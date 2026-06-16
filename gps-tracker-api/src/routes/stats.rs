// /api/v1/devices/:id/stats/daily
use axum::{extract::{Path, Query, State}, routing::get, Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices/:id/stats/daily", get(daily))
        .route("/devices/:id/active-dates", get(active_dates))
}

// daily_stats 가 비어도 location_records 에 점이 있는 날짜는 시커에서 선택 가능해야 함.
// (catchup worker 가 늦게 도는 케이스 또는 새로 import 한 데이터 등)
async fn active_dates(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<NaiveDate>>> {
    // owner 검증
    let owner: Option<i64> = sqlx::query_scalar(
        "SELECT owner_id FROM devices WHERE id = $1",
    ).bind(id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) { return Err(AppError::NotFound); }

    let rows: Vec<(NaiveDate,)> = sqlx::query_as(
        r#"SELECT DISTINCT (recorded_at AT TIME ZONE 'Asia/Seoul')::date AS d
             FROM location_records
            WHERE device_id = $1 AND fix = TRUE AND user_id = $2
            ORDER BY d DESC
            LIMIT 365"#,
    ).bind(id).bind(user.user_id).fetch_all(&state.db).await?;

    Ok(Json(rows.into_iter().map(|(d,)| d).collect()))
}

#[derive(Debug, Deserialize)]
pub struct DailyQuery {
    pub from: Option<NaiveDate>,
    pub to:   Option<NaiveDate>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct DailyRow {
    pub date:           NaiveDate,
    pub fix_count:      i32,
    pub distance_m:     f64,
    pub duration_s:     i32,
    pub moving_s:       i32,
    pub stop_count:     i32,
    pub max_speed_kmh:  f32,
    pub avg_speed_kmh:  f32,
    pub first_fix_at:   Option<DateTime<Utc>>,
    pub last_fix_at:    Option<DateTime<Utc>>,
}

async fn daily(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<DailyQuery>,
) -> AppResult<Json<Vec<DailyRow>>> {
    // 본인 소유 검증
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
        .bind(id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }

    let limit = q.limit.unwrap_or(31).clamp(1, 365);

    let rows: Vec<DailyRow> = sqlx::query_as(
        r#"SELECT date, fix_count, distance_m, duration_s, moving_s, stop_count,
                  max_speed_kmh, avg_speed_kmh, first_fix_at, last_fix_at
             FROM daily_stats
            WHERE device_id = $1 AND user_id = $5
              AND ($2::date IS NULL OR date >= $2)
              AND ($3::date IS NULL OR date <= $3)
            ORDER BY date DESC
            LIMIT $4"#,
    )
    .bind(id)
    .bind(q.from)
    .bind(q.to)
    .bind(limit)
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}
