// /gps-tracker/ws/realtime?token=<access_jwt>
//
// 프로토콜:
//   ← {"type":"hello","user_id":<i64>}
//   → {"action":"subscribe","device_ids":[1,2]}
//   ← {"type":"ack","action":"subscribe","accepted":[1],"rejected":[2]}
//   ← {"type":"location",...}  /  {"type":"device_event",...}
// 슬로우 컨슈머는 broadcast::Lagged 발생 시 그냥 스킵.

use std::collections::HashSet;
use std::sync::Mutex;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;

use crate::{auth::jwt, events::Event, state::AppState};

#[derive(Deserialize)]
pub struct WsParams {
    pub token: String,
}

#[derive(Deserialize, Debug)]
struct ClientMsg {
    action: String,
    #[serde(default)]
    device_ids: Vec<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/realtime", get(handler))
}

async fn handler(
    State(state): State<AppState>,
    Query(params): Query<WsParams>,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    let claims = match jwt::verify(&params.token, &state.config.jwt_secret, "access") {
        Ok(c) => c,
        Err(_) => return (StatusCode::UNAUTHORIZED, "bad token").into_response(),
    };
    let user_id: i64 = match claims.sub.parse() {
        Ok(v) => v,
        Err(_) => return (StatusCode::UNAUTHORIZED, "bad sub").into_response(),
    };
    ws.on_upgrade(move |socket| run(socket, state, user_id))
}

async fn run(socket: WebSocket, state: AppState, user_id: i64) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.events.subscribe();
    let subs: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));

    // hello
    let hello = serde_json::json!({"type":"hello","user_id":user_id});
    if sender.send(Message::Text(hello.to_string())).await.is_err() {
        return;
    }

    // 클라이언트 → 서버: subscribe 메시지를 (string, Vec<accepted>, Vec<rejected>) 패킹해 전달
    let (cmd_tx, mut cmd_rx) =
        tokio::sync::mpsc::channel::<(Vec<i64>, Vec<i64>)>(8);

    let subs_for_recv = subs.clone();
    let db_for_recv = state.db.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(txt) => {
                    let cmd: ClientMsg = match serde_json::from_str(&txt) {
                        Ok(c) => c,
                        Err(_) => continue,
                    };
                    if cmd.action != "subscribe" {
                        continue;
                    }
                    // 소유권 검증
                    let allowed: Vec<i64> = sqlx::query_scalar(
                        "SELECT id FROM devices WHERE owner_id = $1 AND id = ANY($2)",
                    )
                    .bind(user_id)
                    .bind(&cmd.device_ids)
                    .fetch_all(&db_for_recv)
                    .await
                    .unwrap_or_default();

                    let allowed_set: HashSet<i64> = allowed.iter().copied().collect();
                    let rejected: Vec<i64> = cmd
                        .device_ids
                        .iter()
                        .copied()
                        .filter(|id| !allowed_set.contains(id))
                        .collect();

                    {
                        let mut s = subs_for_recv.lock().unwrap();
                        s.clear();
                        for id in &allowed {
                            s.insert(*id);
                        }
                    }
                    if cmd_tx.send((allowed, rejected)).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // SEND: broadcast 이벤트 + ack 메시지 두 채널 멀티플렉싱
    loop {
        tokio::select! {
            biased;
            ack = cmd_rx.recv() => {
                let Some((accepted, rejected)) = ack else { break };
                let payload = serde_json::json!({
                    "type":"ack",
                    "action":"subscribe",
                    "accepted":accepted,
                    "rejected":rejected,
                });
                if sender.send(Message::Text(payload.to_string())).await.is_err() {
                    break;
                }
            }
            ev = rx.recv() => {
                match ev {
                    Ok(ev) => {
                        let device_id = ev.device_id();
                        let subscribed = { subs.lock().unwrap().contains(&device_id) };
                        if !subscribed { continue; }
                        let payload = match serde_json::to_string(&ev) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        if sender.send(Message::Text(payload)).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
    recv_task.abort();
}
