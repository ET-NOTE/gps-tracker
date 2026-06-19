// /api/v1/devices/:id/locations/* — 위치 시계열 조회.
// 모든 응답은 owner_id 일치 강제 (소유 안 한 디바이스는 404).

use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Debug, Serialize, FromRow)]
pub struct LocationView {
    pub recorded_at: DateTime<Utc>,
    pub source: String,
    pub fix: bool,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub sat: Option<i16>,
    pub ttff_s: Option<i32>,
    pub csq: Option<i16>,
    pub reg: Option<i16>,
    pub vbat_mv: Option<i32>,
    pub device_uptime_s: Option<i32>,
    pub heading: Option<f32>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// 최대 반환 개수 (default 100, max 1000)
    pub limit: Option<i64>,
    /// recorded_at >= since (RFC3339)
    pub since: Option<DateTime<Utc>>,
    /// recorded_at <= until (RFC3339)
    pub until: Option<DateTime<Utc>>,
    /// 'l80' 또는 'lte_gnss' 한 가지만 필터
    pub source: Option<String>,
    /// fix=true 만 (오류 좌표 제외)
    pub fix_only: Option<bool>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/devices/:id/locations/latest",
            get(latest),
        )
        .route(
            "/devices/:id/locations",
            get(history),
        )
}

async fn ensure_owner(state: &AppState, device_id: i64, user_id: i64) -> AppResult<()> {
    let exists: Option<i64> = sqlx::query_scalar(
        r#"SELECT id FROM devices WHERE id = $1 AND owner_id = $2"#,
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    exists.map(|_| ()).ok_or(AppError::NotFound)
}

async fn latest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Option<LocationView>>> {
    ensure_owner(&state, id, user.user_id).await?;

    // user_id 필터 — 이전 owner 의 위치 이력 노출 차단 (재페어링 시 본인 데이터는
    // user_id 가 일치하므로 자동 복구).
    let row = sqlx::query_as::<_, LocationView>(
        r#"SELECT recorded_at, source, fix, lat, lng, sat, ttff_s,
                  csq, reg, vbat_mv, device_uptime_s, heading
             FROM location_records
            WHERE device_id = $1 AND user_id = $2
            ORDER BY recorded_at DESC
            LIMIT 1"#,
    )
    .bind(id).bind(user.user_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row))
}

async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<LocationView>>> {
    ensure_owner(&state, id, user.user_id).await?;

    let limit = q.limit.unwrap_or(100).clamp(1, 10000);

    // 조건이 NULL이면 무시되도록 COALESCE 패턴 사용.
    let rows = sqlx::query_as::<_, LocationView>(
        r#"SELECT recorded_at, source, fix, lat, lng, sat, ttff_s,
                  csq, reg, vbat_mv, device_uptime_s, heading
             FROM location_records
            WHERE device_id = $1 AND user_id = $7
              AND ($2::timestamptz IS NULL OR recorded_at >= $2)
              AND ($3::timestamptz IS NULL OR recorded_at <= $3)
              AND ($4::text        IS NULL OR source = $4)
              AND ($5::bool        IS NULL OR fix = $5)
            ORDER BY recorded_at DESC
            LIMIT $6"#,
    )
    .bind(id)
    .bind(q.since)
    .bind(q.until)
    .bind(q.source.as_deref())
    .bind(q.fix_only)
    .bind(limit)
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}
