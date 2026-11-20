use super::{review::company_lock, FleetScope};
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{extract::State, Extension, Json};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, sqlx::FromRow)]
pub(super) struct Hours {
    week_mask: i32,
    open_minute: i32,
    close_minute: i32,
    revision: i64,
}

async fn read<'e>(
    db: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    owner: i64,
) -> AppResult<Hours> {
    let stored = sqlx::query_as(
        "SELECT week_mask, open_minute, close_minute, revision
         FROM fleet_booking_hours WHERE owner_id = $1",
    )
    .bind(owner)
    .fetch_optional(db)
    .await?;
    Ok(stored.unwrap_or(Hours {
        week_mask: 127,
        open_minute: 0,
        close_minute: 1440,
        revision: 0,
    }))
}

pub(super) async fn get(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Hours>> {
    Ok(Json(read(&state.db, user.user_id).await?))
}

pub(super) async fn save(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(next): Json<Hours>,
) -> AppResult<Json<Hours>> {
    if scope.as_ref().is_some_and(|s| s.actor != user.user_id) {
        return Err(AppError::Forbidden);
    }
    if !(1..=127).contains(&next.week_mask)
        || next.open_minute < 0
        || next.close_minute > 1440
        || next.open_minute >= next.close_minute
    {
        return Err(AppError::BadRequest(
            "허용 요일을 하나 이상 선택하고 종료 시간을 시작 시간 이후로 설정해 주세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    company_lock(&mut tx, user.user_id).await?;
    let previous = read(&mut *tx, user.user_id).await?;
    if previous.revision != next.revision {
        return Err(AppError::Conflict(
            "다른 곳에서 정책이 변경되었습니다. 다시 조회해 주세요.".into(),
        ));
    }
    if previous.week_mask == next.week_mask
        && previous.open_minute == next.open_minute
        && previous.close_minute == next.close_minute
    {
        return Ok(Json(previous));
    }
    let saved: Hours = sqlx::query_as(
        "INSERT INTO fleet_booking_hours(owner_id, week_mask, open_minute, close_minute, revision)
         VALUES ($1,$2,$3,$4,1)
         ON CONFLICT(owner_id) DO UPDATE
         SET week_mask=excluded.week_mask, open_minute=excluded.open_minute,
             close_minute=excluded.close_minute, revision=fleet_booking_hours.revision+1
         RETURNING week_mask,open_minute,close_minute,revision",
    )
    .bind(user.user_id)
    .bind(next.week_mask)
    .bind(next.open_minute)
    .bind(next.close_minute)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO fleet_team_audit(owner_id,actor_id,action,before_value,after_value)
         VALUES ($1,$1,'booking_hours',$2,$3)",
    )
    .bind(user.user_id)
    .bind(serde_json::json!(previous))
    .bind(serde_json::json!(saved))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(saved))
}
