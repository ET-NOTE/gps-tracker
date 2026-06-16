// /api/v1/notifications/* — per-user 알림 설정
//
// FCM 워커가 이벤트 발송 전 이 설정을 참조해서 끔/켬, 임계치 적용.
// STATUS 분류 (frontend classifyDevice) 와 1:1 매핑되도록 토글 구성.

use axum::{extract::State, routing::get, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{
    auth::AuthUser,
    error::AppResult,
    state::AppState,
};

#[derive(Debug, Serialize, FromRow)]
pub struct NotificationSettings {
    pub user_id:               i64,
    pub motion_alert:          bool,
    pub low_batt_alert:        bool,
    pub offline_alert:         bool,
    pub geofence_alert:        bool,
    pub device_health_alert:   bool,
    pub lost_alert:            bool,
    // STATUS 확장 (0014)
    pub signal_loss_alert:     bool,
    pub online_alert:          bool,
    pub sleep_alert:           bool,
    pub wake_alert:            bool,
    pub low_batt_threshold_mv: i32,
    pub offline_minutes:       i32,
    pub signal_loss_minutes:   i32,
    pub created_at:            DateTime<Utc>,
    pub updated_at:            DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSettings {
    pub motion_alert:          Option<bool>,
    pub low_batt_alert:        Option<bool>,
    pub offline_alert:         Option<bool>,
    pub geofence_alert:        Option<bool>,
    pub device_health_alert:   Option<bool>,
    pub lost_alert:            Option<bool>,
    pub signal_loss_alert:     Option<bool>,
    pub online_alert:          Option<bool>,
    pub sleep_alert:           Option<bool>,
    pub wake_alert:            Option<bool>,
    pub low_batt_threshold_mv: Option<i32>,
    pub offline_minutes:       Option<i32>,
    pub signal_loss_minutes:   Option<i32>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/notifications/settings", get(get_settings).patch(update_settings))
}

const SELECT_COLS: &str = r#"
    user_id, motion_alert, low_batt_alert, offline_alert, geofence_alert,
    device_health_alert, lost_alert,
    signal_loss_alert, online_alert, sleep_alert, wake_alert,
    low_batt_threshold_mv, offline_minutes, signal_loss_minutes,
    created_at, updated_at
"#;

/// GET /notifications/settings — 없으면 기본값으로 생성하여 반환 (idempotent).
async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<NotificationSettings>> {
    sqlx::query("INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(user.user_id)
        .execute(&state.db)
        .await?;

    let q = format!("SELECT {SELECT_COLS} FROM notification_settings WHERE user_id = $1");
    let row: NotificationSettings = sqlx::query_as(&q)
        .bind(user.user_id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(row))
}

/// PATCH /notifications/settings — 보낸 필드만 갱신.
async fn update_settings(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<UpdateSettings>,
) -> AppResult<Json<NotificationSettings>> {
    sqlx::query("INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(user.user_id)
        .execute(&state.db)
        .await?;

    sqlx::query(
        r#"UPDATE notification_settings
              SET motion_alert          = COALESCE($2,  motion_alert),
                  low_batt_alert        = COALESCE($3,  low_batt_alert),
                  offline_alert         = COALESCE($4,  offline_alert),
                  geofence_alert        = COALESCE($5,  geofence_alert),
                  device_health_alert   = COALESCE($6,  device_health_alert),
                  lost_alert            = COALESCE($7,  lost_alert),
                  signal_loss_alert     = COALESCE($8,  signal_loss_alert),
                  online_alert          = COALESCE($9,  online_alert),
                  sleep_alert           = COALESCE($10, sleep_alert),
                  wake_alert            = COALESCE($11, wake_alert),
                  low_batt_threshold_mv = COALESCE($12, low_batt_threshold_mv),
                  offline_minutes       = COALESCE($13, offline_minutes),
                  signal_loss_minutes   = COALESCE($14, signal_loss_minutes),
                  updated_at            = now()
            WHERE user_id = $1"#,
    )
    .bind(user.user_id)
    .bind(req.motion_alert)
    .bind(req.low_batt_alert)
    .bind(req.offline_alert)
    .bind(req.geofence_alert)
    .bind(req.device_health_alert)
    .bind(req.lost_alert)
    .bind(req.signal_loss_alert)
    .bind(req.online_alert)
    .bind(req.sleep_alert)
    .bind(req.wake_alert)
    .bind(req.low_batt_threshold_mv)
    .bind(req.offline_minutes)
    .bind(req.signal_loss_minutes)
    .execute(&state.db)
    .await?;

    get_settings(State(state), user).await
}
