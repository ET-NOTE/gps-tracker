use super::{booking_error, FleetScope, Input, ROW};
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};

#[derive(Deserialize)]
pub(super) struct Policy {
    approval_required: bool,
    previous: bool,
}
#[derive(Deserialize)]
pub(super) struct Decision {
    decision: String,
    note: Option<String>,
    updated_at: DateTime<Utc>,
}

fn timestamp(v: &Value) -> Option<DateTime<Utc>> {
    v.as_str()?.parse().ok()
}
pub(super) fn check_version(row: &Value, expected: Option<DateTime<Utc>>) -> AppResult<()> {
    if expected.is_none() || timestamp(&row["updated_at"]) != expected {
        return Err(AppError::Conflict(
            "예약이 변경되었습니다. 다시 조회해 주세요.".into(),
        ));
    }
    Ok(())
}
pub(super) fn can_review(scope: Option<&FleetScope>, r: &Value) -> bool {
    if r["approval_required"] != true {
        return false;
    }
    scope.is_none_or(|s| {
        s.permits("review_reservations")
            && s.vehicle(r["fleet_vehicle_id"].as_i64().unwrap_or(-1))
                .is_ok()
            && (s.role != "department_manager"
                || r["driver_staff_id"]
                    .as_i64()
                    .is_none_or(|id| s.staff_ids.contains(&id)))
            && (s.role == "owner"
                || (r["submitted_by"].as_i64() != Some(s.actor)
                    && (s.staff.is_none() || r["driver_staff_id"].as_i64() != s.staff)))
    })
}
pub(super) fn edited_status<'a>(
    row: &Value,
    input: &Input,
    requested: &'a str,
) -> AppResult<&'a str> {
    let previous = row["status"].as_str().unwrap_or("");
    let changed = row["fleet_vehicle_id"].as_i64() != Some(input.vehicle_id)
        || row["driver_staff_id"].as_i64() != input.driver_staff_id
        || timestamp(&row["starts_at"]) != Some(input.starts_at)
        || timestamp(&row["ends_at"]) != Some(input.ends_at)
        || row["purpose"].as_str() != input.purpose.as_deref()
        || input.company_purpose_id.is_some_and(|id| id != row["company_purpose_id"].as_i64())
        || row["report_purpose"].as_str() != input.report_purpose.as_deref()
        || row["note"].as_str() != input.note.as_deref()
        || input.destination_address.as_ref().is_some_and(|a| a.as_deref() != row["destination_address"].as_str());
    match (previous, requested) {
        ("pending", "pending") => Ok("pending"),
        ("planned", "planned") if changed => Ok("pending"),
        ("planned", "planned" | "in_progress" | "completed") if !changed => Ok(requested),
        ("in_progress", "in_progress" | "completed") if !changed => Ok(requested),
        ("pending" | "planned" | "in_progress", "cancelled") if !changed => Ok("cancelled"),
        _ => Err(AppError::Conflict(
            "현재 예약 상태에서 처리할 수 없습니다. 변경된 일정은 다시 승인을 받아야 합니다."
                .into(),
        )),
    }
}
pub(super) async fn company_lock(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-reservations:{owner}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub(super) async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    actor: i64,
    id: i64,
    action: &str,
    before: Option<&str>,
    after: &str,
    note: &str,
) -> AppResult<()> {
    sqlx::query("INSERT INTO fleet_team_audit(owner_id,actor_id,action,target_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(owner).bind(actor).bind(action).bind(id).bind(json!({"status":before})).bind(json!({"status":after,"note":note})).execute(&mut **tx).await?;
    Ok(())
}
pub(super) async fn policy(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Value>> {
    let required:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_reservation_policy WHERE owner_id=$1 AND approval_required)").bind(user.user_id).fetch_one(&state.db).await?;
    Ok(Json(json!({"approval_required":required})))
}
pub(super) async fn set_policy(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(input): Json<Policy>,
) -> AppResult<Json<Value>> {
    if scope.as_ref().is_some_and(|s| s.actor != user.user_id) {
        return Err(AppError::Forbidden);
    }
    let owner = user.user_id;
    let mut tx = state.db.begin().await?;
    company_lock(&mut tx, owner).await?;
    let current:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_reservation_policy WHERE owner_id=$1 AND approval_required)").bind(owner).fetch_one(&mut *tx).await?;
    if current != input.previous && current != input.approval_required {
        return Err(AppError::Conflict(
            "예약 정책이 변경되었습니다. 다시 조회해 주세요.".into(),
        ));
    }
    if current != input.approval_required {
        sqlx::query("INSERT INTO fleet_reservation_policy(owner_id,approval_required) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET approval_required=excluded.approval_required")
            .bind(owner).bind(input.approval_required).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO fleet_team_audit(owner_id,actor_id,action,before_value,after_value) VALUES($1,$1,'reservation_policy',$2,$3)")
            .bind(owner).bind(json!({"approval_required":current})).bind(json!({"approval_required":input.approval_required})).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"approval_required":input.approval_required})))
}
pub(super) async fn decide(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    scope: Option<Extension<FleetScope>>,
    Json(input): Json<Decision>,
) -> AppResult<Json<Value>> {
    let note = input.note.as_deref().unwrap_or("").trim();
    let status = match input.decision.as_str() {
        "approve" => "planned",
        "reject" if !note.is_empty() => "rejected",
        _ => {
            return Err(AppError::BadRequest(
                "승인 종류와 반려 사유를 확인해 주세요.".into(),
            ))
        }
    };
    if note.chars().count() > 500 {
        return Err(AppError::BadRequest(
            "사유는 500자 이내로 입력해 주세요.".into(),
        ));
    }
    let owner = user.user_id;
    let mut tx = state.db.begin().await?;
    company_lock(&mut tx, owner).await?;
    let before:Value=sqlx::query_scalar("SELECT to_jsonb(r) FROM vehicle_reservations r WHERE id=$1 AND user_id=$2 AND fleet_vehicle_id IS NOT NULL FOR UPDATE").bind(id).bind(owner).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    if !can_review(scope.as_ref().map(|s| &s.0), &before) {
        return Err(AppError::Forbidden);
    }
    if before["status"] != "pending" {
        return Err(AppError::Conflict("이미 처리된 예약입니다.".into()));
    }
    check_version(&before, Some(input.updated_at))?;
    let vehicle = before["fleet_vehicle_id"]
        .as_i64()
        .ok_or(AppError::NotFound)?;
    if status == "planned" {
        let enabled: bool = sqlx::query_scalar(
            "SELECT enabled FROM fleet_vehicles WHERE id=$1 AND owner_id=$2 FOR SHARE",
        )
        .bind(vehicle)
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if !enabled {
            return Err(AppError::Conflict(
                "사용 정지 차량은 승인할 수 없습니다.".into(),
            ));
        }
        crate::routes::fleet_team::driver_allowed(
            &mut tx,
            owner,
            before["driver_staff_id"].as_i64(),
            vehicle,
        )
        .await?;
    }
    sqlx::query(
        "UPDATE vehicle_reservations SET status=$2,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(id)
    .bind(status)
    .execute(&mut *tx)
    .await
    .map_err(booking_error)?;
    audit(
        &mut tx,
        owner,
        scope.as_ref().map_or(owner, |s| s.actor),
        id,
        "reservation_review",
        Some("pending"),
        status,
        note,
    )
    .await?;
    let result: Value = sqlx::query_scalar(&format!("{ROW} WHERE r.id=$1 AND r.user_id=$2"))
        .bind(id)
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub(super) async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let row:Value=sqlx::query_scalar("SELECT to_jsonb(r) FROM vehicle_reservations r WHERE id=$1 AND user_id=$2 AND fleet_vehicle_id IS NOT NULL").bind(id).bind(user.user_id).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    if let Some(Extension(s)) = scope {
        s.vehicle(row["fleet_vehicle_id"].as_i64().ok_or(AppError::NotFound)?)?;
        if !s.manager()
            && row["submitted_by"].as_i64() != Some(s.actor)
            && row["driver_staff_id"].as_i64() != s.staff
        {
            return Err(AppError::Forbidden);
        }
    }
    let rows=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'actor_id',actor_id,'created_at',created_at,'action',action,'status',after_value->>'status','note',after_value->>'note') FROM gps_read_fleet_team_audit WHERE owner_id=$1 AND target_id=$2 AND action IN ('reservation_change','reservation_review') ORDER BY id DESC")
        .bind(user.user_id).bind(id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn booking() -> (Value, Input) {
        let row = json!({"fleet_vehicle_id":1,"driver_staff_id":3,"starts_at":"2026-11-19T23:00:00Z","ends_at":"2026-11-20T02:00:00Z","updated_at":"2026-11-18T00:00:00Z","status":"planned","approval_required":true,"purpose":"방문"});
        let input=serde_json::from_value(json!({"vehicle_id":1,"driver_staff_id":3,"starts_at":row["starts_at"],"ends_at":row["ends_at"],"purpose":"방문"})).unwrap();
        (row, input)
    }
    #[test]
    fn changes_to_approved_request_require_another_review() {
        let (row, mut input) = booking();
        assert_eq!(
            edited_status(&row, &input, "in_progress").unwrap(),
            "in_progress"
        );
        input.vehicle_id = 2;
        assert_eq!(edited_status(&row, &input, "planned").unwrap(), "pending");
        assert!(edited_status(&row, &input, "completed").is_err());
    }
    #[test]
    fn pending_and_closed_requests_cannot_skip_review() {
        let (mut row, input) = booking();
        for state in ["pending", "rejected", "cancelled", "completed"] {
            row["status"] = json!(state);
            assert!(edited_status(&row, &input, "planned").is_err());
        }
        assert!(check_version(&row, None).is_err());
        assert!(check_version(&row, timestamp(&row["starts_at"])).is_err());
        assert!(check_version(&row, timestamp(&row["updated_at"])).is_ok());
    }
}
