// 도메인 이벤트 + tokio broadcast 채널.
// ingest 핸들러가 발행 → WS 핸들러 / 추후 FCM worker 가 구독.

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::broadcast;

/// P1: WS 의 batch broadcast 용 fix entry. 1 POST = N fix array.
#[derive(Clone, Debug, Serialize)]
pub struct LocationFix {
    pub recorded_at: DateTime<Utc>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub sat: Option<i16>,
}

/// (2026-07-29 F7-b) 채팅 메시지 push 용 payload.
/// chat_messages 행과 동일 구조 (FE 가 그대로 append 가능).
#[derive(Clone, Debug, Serialize)]
pub struct ChatMessagePayload {
    pub id: i64,
    pub thread_id: i64,
    pub sender_role: String,
    pub sender_id: Option<i64>,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Location {
        device_id: i64,
        recorded_at: DateTime<Utc>,
        source: String,
        fix: bool,
        lat: Option<f64>,
        lng: Option<f64>,
        sat: Option<i16>,
        ttff_s: Option<i32>,
        vbat_mv: Option<i32>,
        heading: Option<f32>,
        /// P1: 1 POST 안 모든 fix (firmware batch). legacy single fix POST 는 None.
        /// top-level lat/lng/sat 은 fixes 의 마지막 fix 와 동일 (backward compat).
        #[serde(skip_serializing_if = "Option::is_none")]
        fixes: Option<Vec<LocationFix>>,
    },
    DeviceEvent {
        device_id: i64,
        kind: String,
        data: serde_json::Value,
    },
    /// (2026-07-29 F7-b) 채팅 push — target_user_id 와 WS user 가 일치할 때만 배송.
    /// target_user_id 는 payload 에 serialize 되지 않게 skip (client 는 자기 것만 받으므로 불필요).
    ChatMessage {
        #[serde(skip)]
        target_user_id: i64,
        message: ChatMessagePayload,
    },
}

/// broadcast 이벤트 배송 대상 — WS 핸들러가 필터링에 사용.
pub enum EventTarget {
    /// device 소유자 & subscribe 한 WS 에게만 배송.
    Device(i64),
    /// 대상 user_id 의 모든 WS 에게 배송 (subscription 무관).
    User(i64),
}

impl Event {
    pub fn target(&self) -> EventTarget {
        match self {
            Event::Location { device_id, .. } => EventTarget::Device(*device_id),
            Event::DeviceEvent { device_id, .. } => EventTarget::Device(*device_id),
            Event::ChatMessage { target_user_id, .. } => EventTarget::User(*target_user_id),
        }
    }
}

pub fn channel(capacity: usize) -> broadcast::Sender<Event> {
    let (tx, _) = broadcast::channel(capacity);
    tx
}
