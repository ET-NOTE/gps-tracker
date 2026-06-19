// 도메인 이벤트 + tokio broadcast 채널.
// ingest 핸들러가 발행 → WS 핸들러 / 추후 FCM worker 가 구독.

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::broadcast;

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
    },
    DeviceEvent {
        device_id: i64,
        kind: String,
        data: serde_json::Value,
    },
}

impl Event {
    pub fn device_id(&self) -> i64 {
        match self {
            Event::Location { device_id, .. } => *device_id,
            Event::DeviceEvent { device_id, .. } => *device_id,
        }
    }
}

pub fn channel(capacity: usize) -> broadcast::Sender<Event> {
    let (tx, _) = broadcast::channel(capacity);
    tx
}
