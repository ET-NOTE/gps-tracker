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

use crate::{
    auth::jwt,
    events::EventTarget,
    services::access_ledger::{self, Access, Recipient, Target},
    state::AppState,
};

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
    if crate::services::admin_security::enabled() && claims.act.is_some() {
        return (StatusCode::FORBIDDEN, "impersonation disabled").into_response();
    }
    let user_id: i64 = match claims.sub.parse() {
        Ok(v) => v,
        Err(_) => return (StatusCode::UNAUTHORIZED, "bad sub").into_response(),
    };
    if crate::auth::extractor::require_existing_account(&state, user_id)
        .await
        .is_err()
    {
        return (StatusCode::UNAUTHORIZED, "account unavailable").into_response();
    }
    // An administrator signed in as the account receives the stream, not the account.
    let reader = match claims.act.as_deref().and_then(|a| a.parse().ok()) {
        Some(admin) => Recipient::Admin(admin),
        None => Recipient::Own(user_id),
    };
    ws.on_upgrade(move |socket| run(socket, state, user_id, claims.exp, reader))
}

async fn run(socket: WebSocket, state: AppState, user_id: i64, expires_at: i64, reader: Recipient) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.events.subscribe();
    let subs: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));

    // hello
    let hello = serde_json::json!({"type":"hello","user_id":user_id});
    if sender.send(Message::Text(hello.to_string())).await.is_err() {
        return;
    }

    // 클라이언트 → 서버: subscribe 메시지를 (string, Vec<accepted>, Vec<rejected>) 패킹해 전달
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel::<(Vec<i64>, Vec<i64>)>(8);

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
                        "SELECT d.id FROM devices d JOIN privacy_account_controls c ON c.user_id=d.owner_id WHERE owner_id = $1 AND d.id = ANY($2) AND NOT c.restricted",
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
    revalidate.tick().await; // 즉시 발화하는 첫 tick 소비
    let expiry = tokio::time::sleep(std::time::Duration::from_secs(
        (expires_at - chrono::Utc::now().timestamp()).max(0) as u64,
    ));
    tokio::pin!(expiry);

    // SEND: broadcast 이벤트 + ack 메시지 + 주기 재검증 멀티플렉싱
    loop {
        tokio::select! {
            biased;
            _ = &mut expiry => {
                let _ = sender.send(Message::Close(None)).await;
                break;
            }
            _ = revalidate.tick() => {
                if crate::auth::extractor::require_existing_account(&state, user_id).await.is_err() {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
                let current: Vec<i64> = { subs.lock().unwrap().iter().copied().collect() };
                if !current.is_empty() {
                    // 성공했을 때만 프루닝 — 일시 DB 오류에 정상 구독을 전부 날리지 않도록.
                    match sqlx::query_scalar::<_, i64>(
                        "SELECT id FROM devices WHERE owner_id = $1 AND id = ANY($2)",
                    ).bind(user_id).bind(&current).fetch_all(&state.db).await {
                      Ok(still) => {
                        let still_set: HashSet<i64> = still.into_iter().collect();
                        let mut s = subs.lock().unwrap();
                        s.retain(|id| still_set.contains(id));
                      }
                      Err(_) => { break; }
                    }
                }
            }
            ack = cmd_rx.recv() => {
                let Some((accepted, rejected)) = ack else { break };
                if crate::auth::extractor::require_existing_account(&state, user_id).await.is_err() {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
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
                        // Keep the owner lock until send completes: unpair waits for an
                        // already-authorized send, and no later send can pass its commit.
                        // The event's stamped owner also excludes old queued events from
                        // a new owner's subscription.
                        let Ok(mut authorization) = state.db.begin().await else { break; };
                        let active = sqlx::query_scalar::<_, i64>(
                            "SELECT user_id FROM privacy_account_controls WHERE user_id=$1 AND NOT restricted FOR SHARE")
                            .bind(user_id).fetch_optional(&mut *authorization).await;
                        if !matches!(active, Ok(Some(_))) { break; }
                        match ev.target() {
                            EventTarget::Device(did, owner) => {
                                if owner != Some(user_id) || !subs.lock().unwrap().contains(&did) { continue; }
                                let allowed = sqlx::query_scalar::<_, i64>(
                                    "SELECT id FROM devices WHERE id=$1 AND owner_id=$2 FOR SHARE")
                                    .bind(did).bind(user_id).fetch_optional(&mut *authorization).await;
                                match allowed {
                                    Ok(Some(_)) => {}
                                    Ok(None) => { subs.lock().unwrap().remove(&did); continue; }
                                    Err(_) => { break; }
                                }
                            }
                            EventTarget::User(uid) => { if uid != user_id { continue; } }
                        }
                        if chrono::Utc::now().timestamp() >= expires_at { break; }
                        let payload = match serde_json::to_string(&ev) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        let ticket = match ev.target() {
                            EventTarget::Device(device, _) => match access_ledger::begin(Access {
                                at:chrono::Utc::now(),target:Target::ScopedDevice{account:user_id,device},
                                recipient:reader.clone(),path:"realtime",method:"position",route:"/realtime",range:None,
                            }).await {Ok(ticket)=>ticket, Err(_)=>break},
                            EventTarget::User(_)=>access_ledger::Ticket::off(),
                        };
                        let sent=matches!(tokio::time::timeout(std::time::Duration::from_secs(3),
                            sender.send(Message::Text(payload))).await, Ok(Ok(())));
                        if ticket.finish(if sent {"socket_sent"} else {"transport_unknown"}).await.is_err() || !sent {break;}
                        if authorization.commit().await.is_err() { break; }
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
