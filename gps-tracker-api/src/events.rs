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
        cbc_mv:  Option<i32>,   // SIM7080 AT+CBC (모듈 관점 VBAT, 배선 loss 뒤)
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
