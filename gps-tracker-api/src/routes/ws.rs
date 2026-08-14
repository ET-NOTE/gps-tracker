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

use crate::{auth::jwt, events::{Event, EventTarget}, state::AppState};

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

    // [보안 2026-08-14] 구독 소유권 주기 재검증 — subscribe 시점에만 검증하면, 이후 device 가
    //   unpair→타인에게 re-pair 되어도 이 WS 의 subs 에 남아 새 owner 의 실시간 좌표가 계속 샘.
    //   30s 주기로 재조회해 더 이상 소유하지 않는 device 를 프루닝(노출 창 ≤30s, per-message 비용 0).
    let mut revalidate = tokio::time::interval(std::time::Duration::from_secs(30));
    revalidate.tick().await;   // 즉시 발화하는 첫 tick 소비

    // SEND: broadcast 이벤트 + ack 메시지 + 주기 재검증 멀티플렉싱
    loop {
        tokio::select! {
            biased;
            _ = revalidate.tick() => {
                let current: Vec<i64> = { subs.lock().unwrap().iter().copied().collect() };
                if !current.is_empty() {
                    // 성공했을 때만 프루닝 — 일시 DB 오류에 정상 구독을 전부 날리지 않도록.
                    if let Ok(still) = sqlx::query_scalar::<_, i64>(
                        "SELECT id FROM devices WHERE owner_id = $1 AND id = ANY($2)",
                    ).bind(user_id).bind(&current).fetch_all(&state.db).await {
                        let still_set: HashSet<i64> = still.into_iter().collect();
                        let mut s = subs.lock().unwrap();
                        s.retain(|id| still_set.contains(id));
                    }
                }
            }
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
                        // (F7-b) 배송 대상 판별:
                        // Device(id) → subscribe 된 device 만
                        // User(id)   → 이 WS 의 user_id 와 일치할 때만 (chat 등 user-scoped)
                        let should_send = match ev.target() {
                            EventTarget::Device(did) => subs.lock().unwrap().contains(&did),
                            EventTarget::User(uid)   => uid == user_id,
                        };
                        if !should_send { continue; }
                        let payload = match serde_json::to_string(&ev) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        if sender.send(Message::Text(payload)).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        // (F11) 이전엔 조용히 continue → 사용자 gap 인지 불가.
                        // 클라이언트에게 lagged 알림 emit → FE 가 REST 로 catch-up 하도록.
                        let notice = serde_json::json!({
                            "type": "lagged",
                            "dropped": n,
                        });
                        if sender.send(Message::Text(notice.to_string())).await.is_err() {
                            break;
                        }
                        continue;
                    }
                    Err(_) => break,
                }
            }
        }
    }
    recv_task.abort();
}
