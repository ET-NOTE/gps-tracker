use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::{config::Config, events::Event, services::{fcm::FcmClient, opinet::OpinetCache}};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub events: broadcast::Sender<Event>,
    /// FCM 클라이언트 — 서비스 계정 미설정 시 None (dry-run)
    pub fcm: Option<Arc<FcmClient>>,
    /// (2026-07-28) Stage-4D: 오피넷 유가 캐시 (프로세스 공용).
    pub opinet: Arc<OpinetCache>,
}
