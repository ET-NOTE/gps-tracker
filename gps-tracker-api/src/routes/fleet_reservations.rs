//! Vehicle reservations do not depend on a current SIM connection.
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::{get, put},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/vehicle-reservations", get(list).post(create))
        .route(
            "/corporate/vehicle-reservations/:id",
            put(update).delete(cancel),
        )
}
#[derive(Deserialize)]
struct Filter {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    vehicle_id: Option<i64>,
    status: Option<String>,
}
#[derive(Deserialize)]
struct Input {
    vehicle_id: i64,
    driver_staff_id: Option<i64>,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    purpose: Option<String>,
    note: Option<String>,
    status: Option<String>,
}
const ROW:&str="SELECT to_jsonb(r)||jsonb_build_object('vehicle_name',v.name,'license_plate',v.license_plate,'driver_name',COALESCE(r.driver_name_snapshot,s.name),'vehicle_id',r.fleet_vehicle_id) FROM vehicle_reservations r JOIN fleet_vehicles v ON v.id=r.fleet_vehicle_id AND v.owner_id=r.user_id LEFT JOIN staff s ON s.id=r.driver_staff_id AND s.user_id=r.user_id";
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<Filter>,
) -> AppResult<Json<Vec<Value>>> {
    let from = q.from.unwrap_or(Utc::now() - chrono::Duration::days(7));
    let to = q.to.unwrap_or(Utc::now() + chrono::Duration::days(31));
    if to <= from || to - from > chrono::Duration::days(366) {
        return Err(AppError::BadRequest(
            "조회 기간을 1년 이내로 선택해 주세요.".into(),
        ));
    }
    let statuses = q
        .status
        .map(|s| s.split(',').map(str::to_owned).collect::<Vec<_>>());
    let rows=sqlx::query_scalar(&format!("{ROW} WHERE r.user_id=$1 AND r.starts_at<$3 AND r.ends_at>$2 AND ($4::bigint IS NULL OR r.fleet_vehicle_id=$4) AND ($5::text[] IS NULL OR r.status=ANY($5)) ORDER BY r.starts_at DESC,r.id DESC"))
        .bind(user.user_id).bind(from).bind(to).bind(q.vehicle_id).bind(statuses).fetch_all(&state.db).await?;
    Ok(Json(rows))
}
async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<crate::auth::fleet::FleetScope>>,
    Json(input): Json<Input>,
) -> AppResult<Json<Value>> {
    save(&state, user.user_id, None, input, scope.map(|s| s.0))
        .await
        .map(Json)
}
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    scope: Option<Extension<crate::auth::fleet::FleetScope>>,
    Json(input): Json<Input>,
) -> AppResult<Json<Value>> {
    save(&state, user.user_id, Some(id), input, scope.map(|s| s.0))
        .await
        .map(Json)
}
async fn save(
    state: &AppState,
    owner: i64,
    id: Option<i64>,
    input: Input,
    scope: Option<crate::auth::fleet::FleetScope>,
) -> AppResult<Value> {
    if input.ends_at <= input.starts_at
        || input.ends_at - input.starts_at > chrono::Duration::days(366)
    {
        return Err(AppError::BadRequest(
            "종료 시간을 시작 시간 이후로 선택해 주세요. 최대 1년까지 예약할 수 있습니다.".into(),
        ));
    }
    if input
        .purpose
        .as_ref()
        .is_some_and(|s| s.chars().count() > 500)
        || input
            .note
            .as_ref()
            .is_some_and(|s| s.chars().count() > 2000)
    {
        return Err(AppError::BadRequest("목적 또는 메모가 너무 깁니다.".into()));
    }
    let status = input.status.unwrap_or_else(|| "planned".into());
    if !["planned", "in_progress", "completed", "cancelled"].contains(&status.as_str()) {
        return Err(AppError::BadRequest("잘못된 예약 상태입니다.".into()));
    }
    let mut tx = state.db.begin().await?;
    // Serialize modifications for this owner's reservations (including moves
    // between vehicles) so reversed lock orders cannot double-book or deadlock.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-reservations:{owner}"))
        .execute(&mut *tx)
        .await?;
    let before: Option<Value> = if let Some(id) = id {
        Some(sqlx::query_scalar("SELECT to_jsonb(r) FROM vehicle_reservations r WHERE id=$1 AND user_id=$2 AND fleet_vehicle_id IS NOT NULL FOR UPDATE").bind(id).bind(owner).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?)
    } else {
        None
    };
    if let Some(ref scope) = scope {
        scope.vehicle(input.vehicle_id)?;
        if !scope.manager() && input.driver_staff_id != scope.staff {
            return Err(AppError::Forbidden);
        }
        if let Some(ref before) = before {
            scope.vehicle(
                before["fleet_vehicle_id"]
                    .as_i64()
                    .ok_or(AppError::NotFound)?,
            )?;
            if !scope.manager() && before["driver_staff_id"].as_i64() != scope.staff {
                return Err(AppError::Forbidden);
            }
        }
    }
    let enabled: bool = sqlx::query_scalar(
        "SELECT enabled FROM fleet_vehicles WHERE id=$1 AND owner_id=$2 FOR SHARE",
    )
    .bind(input.vehicle_id)
    .bind(owner)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if !enabled && ["planned", "in_progress"].contains(&status.as_str()) {
        return Err(AppError::BadRequest(
            "사용 정지 차량은 예약할 수 없습니다.".into(),
        ));
    }
    super::fleet_team::driver_allowed(&mut tx, owner, input.driver_staff_id, input.vehicle_id)
        .await?;
    if let Some(staff) = input.driver_staff_id {
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM staff WHERE id=$1 AND user_id=$2 AND active)",
        )
        .bind(staff)
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if !valid {
            return Err(AppError::BadRequest(
                "현재 계정의 활성 사용자를 선택해 주세요.".into(),
            ));
        }
    }
    if ["planned", "in_progress"].contains(&status.as_str()) {
        let overlap:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vehicle_reservations WHERE fleet_vehicle_id=$1 AND status IN ('planned','in_progress') AND starts_at<$3 AND ends_at>$2 AND ($4::bigint IS NULL OR id<>$4))")
            .bind(input.vehicle_id).bind(input.starts_at).bind(input.ends_at).bind(id).fetch_one(&mut *tx).await?;
        if overlap {
            return Err(AppError::Conflict(
                "이용 시간이 겹치는 예약이 있습니다.".into(),
            ));
        }
    }
    let saved: i64 = if let Some(id) = id {
        sqlx::query_scalar("UPDATE vehicle_reservations SET fleet_vehicle_id=$3,device_id=NULL,driver_staff_id=$4,starts_at=$5,ends_at=$6,purpose=$7,note=$8,status=$9,alerted_at=CASE WHEN starts_at IS DISTINCT FROM $5 OR fleet_vehicle_id IS DISTINCT FROM $3 THEN NULL ELSE alerted_at END,ended_alerted_at=CASE WHEN ends_at IS DISTINCT FROM $6 OR fleet_vehicle_id IS DISTINCT FROM $3 THEN NULL ELSE ended_alerted_at END,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING id")
            .bind(id).bind(owner).bind(input.vehicle_id).bind(input.driver_staff_id).bind(input.starts_at).bind(input.ends_at).bind(input.purpose).bind(input.note).bind(status).fetch_one(&mut *tx).await.map_err(booking_error)?
    } else {
        sqlx::query_scalar("INSERT INTO vehicle_reservations(user_id,fleet_vehicle_id,driver_staff_id,starts_at,ends_at,purpose,note,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id")
            .bind(owner).bind(input.vehicle_id).bind(input.driver_staff_id).bind(input.starts_at).bind(input.ends_at).bind(input.purpose).bind(input.note).bind(status).fetch_one(&mut *tx).await.map_err(booking_error)?
    };
    let row: Value = sqlx::query_scalar(&format!("{ROW} WHERE r.id=$1 AND r.user_id=$2"))
        .bind(saved)
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO fleet_vehicle_audit(owner_id,vehicle_id,action,before_value,after_value) VALUES($1,$2,'reservation',$3,$4)").bind(owner).bind(input.vehicle_id).bind(before).bind(&row).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}
async fn cancel(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    scope: Option<Extension<crate::auth::fleet::FleetScope>>,
) -> AppResult<Json<Value>> {
    // Retain the old booking and its audit instead of physically deleting it.
    let mut tx = state.db.begin().await?;
    let before:Value=sqlx::query_scalar("SELECT to_jsonb(r) FROM vehicle_reservations r WHERE id=$1 AND user_id=$2 AND fleet_vehicle_id IS NOT NULL FOR UPDATE").bind(id).bind(user.user_id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    if let Some(Extension(scope)) = scope {
        scope.vehicle(
            before["fleet_vehicle_id"]
                .as_i64()
                .ok_or(AppError::NotFound)?,
        )?;
        if !scope.manager() && before["driver_staff_id"].as_i64() != scope.staff {
            return Err(AppError::Forbidden);
        }
    }
    sqlx::query("UPDATE vehicle_reservations SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO fleet_vehicle_audit(owner_id,vehicle_id,action,before_value,after_value) VALUES($1,$2,'reservation_cancel',$3,jsonb_build_object('reservation_id',$4::bigint))")
        .bind(user.user_id).bind(before["fleet_vehicle_id"].as_i64().unwrap()).bind(before).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

fn booking_error(e: sqlx::Error) -> AppError {
    if e.as_database_error().and_then(|e| e.code()).as_deref() == Some("23P01") {
        AppError::Conflict("이용 시간이 겹치는 예약이 있습니다.".into())
    } else {
        AppError::Database(e)
    }
}
