use crate::{
    auth::{fleet::FleetScope, AuthUser},
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{extract::{Path, Query, State}, Extension, Json};
use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

const KINDS: &[&str] = &["service", "oil", "tires", "insurance", "inspection", "other"];
const PAGE_SIZE: i64 = 30;

#[derive(Deserialize)]
pub(super) struct Filters {
    vehicle_id: Option<i64>,
    kind: Option<String>,
    before_date: Option<NaiveDate>,
    before_id: Option<i64>,
}

#[derive(Serialize, FromRow)]
pub(super) struct Completion {
    id: i64,
    vehicle_id: i64,
    kind: String,
    completed_on: NaiveDate,
    note: String,
    schedule_key: Option<String>,
    scheduled_on: Option<NaiveDate>,
}

#[derive(Serialize)]
pub(super) struct HistoryPage {
    rows: Vec<Completion>,
    has_more: bool,
}

pub(super) async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Query(q): Query<Filters>,
) -> AppResult<Json<HistoryPage>> {
    if q.before_date.is_some() != q.before_id.is_some()
        || q.kind.as_ref().is_some_and(|k| !KINDS.contains(&k.as_str()))
    {
        return Err(AppError::BadRequest("조회 조건을 확인해 주세요.".into()));
    }
    if let (Some(id), Some(scope)) = (q.vehicle_id, &scope) {
        scope.vehicle(id)?;
    }
    let allowed_vehicles = scope.as_ref().filter(|s| s.actor != s.owner).map(|s| &s.vehicles);
    let mut rows: Vec<Completion> = sqlx::query_as(
        "SELECT id, vehicle_id, kind, completed_on, note, schedule_key, scheduled_on
         FROM fleet_maintenance_history
         WHERE owner_id=$1 AND ($2::bigint[] IS NULL OR vehicle_id=ANY($2))
           AND ($3::bigint IS NULL OR vehicle_id=$3) AND ($4::text IS NULL OR kind=$4)
           AND ($5::date IS NULL OR (completed_on, id)<($5,$6::bigint))
         ORDER BY completed_on DESC,id DESC LIMIT $7"
    ).bind(user.user_id).bind(allowed_vehicles).bind(q.vehicle_id).bind(q.kind)
        .bind(q.before_date).bind(q.before_id).bind(PAGE_SIZE + 1)
        .fetch_all(&state.db).await?;
    let has_more = rows.len() > PAGE_SIZE as usize;
    rows.truncate(PAGE_SIZE as usize);
    Ok(Json(HistoryPage { rows, has_more }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CompleteInput {
    request_id: Uuid,
    kind: String,
    completed_on: NaiveDate,
    #[serde(default)]
    note: String,
    schedule_key: Option<String>,
    scheduled_on: Option<NaiveDate>,
}

impl CompleteInput {
    fn validate(&mut self, today: NaiveDate) -> AppResult<()> {
        self.note = self.note.trim().to_owned();
        if !KINDS.contains(&self.kind.as_str()) || self.note.chars().count() > 400 {
            return Err(AppError::BadRequest("정비 종류와 메모(400자 이내)를 확인해 주세요.".into()));
        }
        if self.completed_on > today {
            return Err(AppError::BadRequest("완료일은 오늘 또는 이전 날짜로 입력해 주세요.".into()));
        }
        let matches_schedule = match self.schedule_key.as_deref() {
            None => self.scheduled_on.is_none(),
            Some("next_service_date") => self.scheduled_on.is_some() && matches!(self.kind.as_str(), "service" | "oil" | "tires" | "other"),
            Some("insurance_expiry") => self.scheduled_on.is_some() && self.kind == "insurance",
            Some("inspection_expiry") => self.scheduled_on.is_some() && self.kind == "inspection",
            _ => false,
        };
        if !matches_schedule {
            return Err(AppError::BadRequest("완료할 일정과 정비 종류를 확인해 주세요.".into()));
        }
        Ok(())
    }
}

pub(super) async fn complete(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(vehicle): Path<i64>,
    Json(mut input): Json<CompleteInput>,
) -> AppResult<Json<Completion>> {
    let actor = if let Some(scope) = scope {
        if !scope.permits("manage_vehicles") { return Err(AppError::Forbidden); }
        scope.vehicle(vehicle)?;
        scope.actor
    } else { user.user_id };
    input.validate((Utc::now() + Duration::hours(9)).date_naive())?;
    let mut tx = state.db.begin().await?;
    let profile: serde_json::Value = sqlx::query_scalar(
        "SELECT profile FROM fleet_vehicles WHERE owner_id=$1 AND id=$2 FOR UPDATE"
    ).bind(user.user_id).bind(vehicle).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    let request_id = input.request_id.to_string();
    // A lost success response can be retried after the original schedule was cleared.
    let existing: Option<Completion> = sqlx::query_as(
        "SELECT id, vehicle_id, kind, completed_on, note, schedule_key, scheduled_on
         FROM fleet_maintenance_history WHERE owner_id=$1 AND vehicle_id=$2 AND request_id=$3::text::uuid"
    ).bind(user.user_id).bind(vehicle).bind(&request_id).fetch_optional(&mut *tx).await?;
    if let Some(row) = existing {
        if row.kind == input.kind && row.completed_on == input.completed_on && row.note == input.note
            && row.schedule_key == input.schedule_key && row.scheduled_on == input.scheduled_on
        {
            return Ok(Json(row));
        }
        return Err(AppError::Conflict("이미 저장된 요청입니다. 이력을 다시 확인해 주세요.".into()));
    }
    if let (Some(key), Some(day)) = (&input.schedule_key, input.scheduled_on) {
        let day = day.to_string();
        if profile.get(key.as_str()).and_then(|v| v.as_str()) != Some(day.as_str()) {
            return Err(AppError::Conflict("일정이 변경되었거나 이미 완료됐습니다. 일정을 다시 확인해 주세요.".into()));
        }
        sqlx::query("UPDATE fleet_vehicles SET profile=profile-$3::text, updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2")
            .bind(user.user_id).bind(vehicle).bind(key).execute(&mut *tx).await?;
    }
    let row: Completion = sqlx::query_as(
        "INSERT INTO fleet_maintenance_history
           (owner_id, vehicle_id, kind, completed_on, note, schedule_key, scheduled_on, actor_id, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text::uuid)
         RETURNING id, vehicle_id, kind, completed_on, note, schedule_key, scheduled_on"
    ).bind(user.user_id).bind(vehicle).bind(input.kind).bind(input.completed_on).bind(input.note)
        .bind(input.schedule_key).bind(input.scheduled_on).bind(actor).bind(request_id)
        .fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_or_linked_completion_validates_kind_and_korean_calendar_day() {
        let today = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
        let mut input = CompleteInput { request_id: Uuid::new_v4(), kind: "oil".into(),
            completed_on: today, note: "  교체  ".into(), schedule_key: None, scheduled_on: None };
        assert!(input.validate(today).is_ok());
        assert_eq!(input.note, "교체");
        input.schedule_key = Some("insurance_expiry".into());
        assert!(input.validate(today).is_err());
        input.scheduled_on = Some(today);
        assert!(input.validate(today).is_err());
        input.kind = "insurance".into();
        assert!(input.validate(today).is_ok());
        input.completed_on = today.succ_opt().unwrap();
        assert!(input.validate(today).is_err());
    }
}
