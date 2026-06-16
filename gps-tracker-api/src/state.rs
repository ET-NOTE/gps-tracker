use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::{config::Config, events::Event, services::fcm::FcmClient};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub events: broadcast::Sender<Event>,
    /// FCM 클라이언트 — 서비스 계정 미설정 시 None (dry-run)
    pub fcm: Option<Arc<FcmClient>>,
}
