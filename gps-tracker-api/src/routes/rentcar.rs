// (2026-07-28) Stage-R1: 렌트카 (rental) 계약 관리.
//
// account_type='rentcar' 사용자 전용 (프론트 게이팅, 백엔드도 owner 만 접근).
// endpoints:
//   GET    /rentcar/contracts?status=&device_id=&from=&to=  list
//   POST   /rentcar/contracts                               create
//   PATCH  /rentcar/contracts/:id                           update
//   POST   /rentcar/contracts/:id/return                    반납 처리 (정산 자동)
//   DELETE /rentcar/contracts/:id                           delete

use axum::{
    extract::{Path, Query, State},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rentcar/contracts", get(list_contracts).post(create_contract))
        .route("/rentcar/contracts/:id", patch(update_contract).delete(delete_contract))
        .route("/rentcar/contracts/:id/return", post(return_contract))
}

#[derive(Debug, Serialize, FromRow)]
pub struct Contract {
    pub id:                  i64,
    pub user_id:             i64,
    pub device_id:           i64,
    pub device_name:         Option<String>,
    pub license_plate:       Option<String>,
    pub renter_name:         String,
    pub renter_phone:        Option<String>,
    pub renter_id_last4:     Option<String>,
    pub starts_at:           DateTime<Utc>,
    pub ends_at:             DateTime<Utc>,
    pub rate_type:           String,
    pub rate_amount_krw:     i64,
    pub included_km_per_day: Option<i32>,
    pub over_km_price_krw:   Option<i32>,
    pub deposit_krw:         i64,
    pub return_odometer_km:  Option<i32>,
    pub pickup_odometer_km:  Option<i32>,
    pub settled_amount_krw:  Option<i64>,
    pub settled_at:          Option<DateTime<Utc>>,
    pub pickup_location:     Option<String>,
    pub return_location:     Option<String>,
    pub status:              String,
    pub note:                Option<String>,
    pub created_at:          DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ContractQuery {
    pub status:    Option<String>,
    pub device_id: Option<i64>,
    pub from:      Option<String>,
    pub to:        Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ContractPayload {
    pub device_id:           i64,
    pub renter_name:         String,
    pub renter_phone:        Option<String>,
    pub renter_id_last4:     Option<String>,
    pub starts_at:           DateTime<Utc>,
    pub ends_at:             DateTime<Utc>,
    pub rate_type:           Option<String>,
    pub rate_amount_krw:     Option<i64>,
    pub included_km_per_day: Option<i32>,
    pub over_km_price_krw:   Option<i32>,
    pub deposit_krw:         Option<i64>,
    pub pickup_odometer_km:  Option<i32>,
    pub pickup_location:     Option<String>,
    pub return_location:     Option<String>,
    pub status:              Option<String>,
    pub note:                Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReturnPayload {
    pub return_odometer_km: Option<i32>,
    pub return_location:    Option<String>,
    pub extra_fee_krw:      Option<i64>,
    pub note:               Option<String>,
}

async fn verify_device_owner(state: &AppState, uid: i64, device_id: i64) -> AppResult<()> {
    let owner: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT owner_id FROM devices WHERE id = $1",
    ).bind(device_id).fetch_optional(&state.db).await?;
    match owner {
        Some(Some(o)) if o == uid => Ok(()),
        _ => Err(AppError::NotFound),
    }
}

async fn list_contracts(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ContractQuery>,
) -> AppResult<Json<Vec<Contract>>> {
    let now = Utc::now();
    let from = q.from.as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc)))
        .unwrap_or_else(|| now - chrono::Duration::days(30));
    let to = q.to.as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc)))
        .unwrap_or_else(|| now + chrono::Duration::days(90));
    let statuses: Option<Vec<String>> = q.status.as_deref().map(|s|
        s.split(',').map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect::<Vec<_>>())
        .filter(|v| !v.is_empty());

    let rows: Vec<Contract> = if let (Some(dev_id), Some(ref sts)) = (q.device_id, statuses.as_ref()) {
        sqlx::query_as(SQL_LIST_DEV_STATUS)
            .bind(user.user_id).bind(dev_id).bind(from).bind(to).bind(sts)
            .fetch_all(&state.db).await?
    } else if let Some(dev_id) = q.device_id {
        sqlx::query_as(SQL_LIST_DEV)
            .bind(user.user_id).bind(dev_id).bind(from).bind(to)
            .fetch_all(&state.db).await?
    } else if let Some(ref sts) = statuses {
        sqlx::query_as(SQL_LIST_STATUS)
            .bind(user.user_id).bind(from).bind(to).bind(sts)
            .fetch_all(&state.db).await?
    } else {
        sqlx::query_as(SQL_LIST_ALL)
            .bind(user.user_id).bind(from).bind(to)
            .fetch_all(&state.db).await?
    };
    Ok(Json(rows))
}

async fn create_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ContractPayload>,
) -> AppResult<Json<Contract>> {
    if req.ends_at <= req.starts_at {
        return Err(AppError::BadRequest("ends_at must be after starts_at".into()));
    }
    if req.renter_name.trim().is_empty() {
        return Err(AppError::BadRequest("renter_name required".into()));
    }
    verify_device_owner(&state, user.user_id, req.device_id).await?;
    let rate_type = req.rate_type.unwrap_or_else(|| "daily".into());
    if !matches!(rate_type.as_str(), "hourly"|"daily"|"monthly") {
        return Err(AppError::BadRequest(format!("invalid rate_type: {rate_type}")));
    }
    let status = req.status.unwrap_or_else(|| "draft".into());
    if !matches!(status.as_str(), "draft"|"active"|"returned"|"overdue"|"cancelled") {
        return Err(AppError::BadRequest(format!("invalid status: {status}")));
    }
    let row: Contract = sqlx::query_as(SQL_INSERT)
        .bind(user.user_id).bind(req.device_id)
        .bind(req.renter_name.trim())
        .bind(req.renter_phone.as_deref())
        .bind(req.renter_id_last4.as_deref())
        .bind(req.starts_at).bind(req.ends_at)
        .bind(&rate_type).bind(req.rate_amount_krw.unwrap_or(0))
        .bind(req.included_km_per_day).bind(req.over_km_price_krw)
        .bind(req.deposit_krw.unwrap_or(0))
        .bind(req.pickup_odometer_km)
        .bind(req.pickup_location.as_deref())
        .bind(req.return_location.as_deref())
        .bind(&status).bind(req.note.as_deref())
        .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn update_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ContractPayload>,
) -> AppResult<Json<Contract>> {
    if req.ends_at <= req.starts_at {
        return Err(AppError::BadRequest("ends_at must be after starts_at".into()));
    }
    let rate_type = req.rate_type.unwrap_or_else(|| "daily".into());
    let status    = req.status.unwrap_or_else(|| "draft".into());
    let row: Option<Contract> = sqlx::query_as(SQL_UPDATE)
        .bind(id).bind(user.user_id).bind(req.device_id)
        .bind(req.renter_name.trim())
        .bind(req.renter_phone.as_deref())
        .bind(req.renter_id_last4.as_deref())
        .bind(req.starts_at).bind(req.ends_at)
        .bind(&rate_type).bind(req.rate_amount_krw.unwrap_or(0))
        .bind(req.included_km_per_day).bind(req.over_km_price_krw)
        .bind(req.deposit_krw.unwrap_or(0))
        .bind(req.pickup_odometer_km)
        .bind(req.pickup_location.as_deref())
        .bind(req.return_location.as_deref())
        .bind(&status).bind(req.note.as_deref())
        .fetch_optional(&state.db).await?;
    Ok(Json(row.ok_or(AppError::NotFound)?))
}

async fn return_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ReturnPayload>,
) -> AppResult<Json<Contract>> {
    #[derive(FromRow)]
    struct Cur {
        rate_type: String, rate_amount_krw: i64,
        starts_at: DateTime<Utc>, ends_at: DateTime<Utc>,
        included_km_per_day: Option<i32>, over_km_price_krw: Option<i32>,
        pickup_odometer_km: Option<i32>,
    }
    let cur: Option<Cur> = sqlx::query_as(
        r#"SELECT rate_type, rate_amount_krw, starts_at, ends_at,
                  included_km_per_day, over_km_price_krw, pickup_odometer_km
             FROM rental_contracts WHERE id = $1 AND user_id = $2"#,
    ).bind(id).bind(user.user_id).fetch_optional(&state.db).await?;
    let cur = cur.ok_or(AppError::NotFound)?;

    let dur = cur.ends_at - cur.starts_at;
    let units = match cur.rate_type.as_str() {
        "hourly"  => (dur.num_minutes() as f64 / 60.0).ceil() as i64,
        "monthly" => (dur.num_days()   as f64 / 30.0).ceil() as i64,
        _         => (dur.num_hours()  as f64 / 24.0).ceil() as i64,
    };
    let base = cur.rate_amount_krw * units.max(1);

    let mut over_fee: i64 = 0;
    if let (Some(ret_od), Some(pick_od), Some(included_per_day), Some(over_price)) =
        (req.return_odometer_km, cur.pickup_odometer_km, cur.included_km_per_day, cur.over_km_price_krw)
    {
        let driven = (ret_od - pick_od).max(0);
        let days = ((dur.num_hours() as f64 / 24.0).ceil() as i32).max(1);
        let allowed = included_per_day * days;
        let over = (driven - allowed).max(0);
        over_fee = (over as i64) * (over_price as i64);
    }
    let settled = base + over_fee + req.extra_fee_krw.unwrap_or(0);

    let row: Contract = sqlx::query_as(
        r#"WITH upd AS (
            UPDATE rental_contracts
               SET status = 'returned',
                   return_odometer_km = COALESCE($3, return_odometer_km),
                   return_location    = COALESCE($4, return_location),
                   settled_amount_krw = $5,
                   settled_at         = NOW(),
                   note               = COALESCE($6, note),
                   updated_at         = NOW()
             WHERE id = $1 AND user_id = $2
             RETURNING *
        )
        SELECT upd.id, upd.user_id, upd.device_id,
               d.display_name  AS device_name,
               d.license_plate AS license_plate,
               upd.renter_name, upd.renter_phone, upd.renter_id_last4,
               upd.starts_at, upd.ends_at,
               upd.rate_type, upd.rate_amount_krw, upd.included_km_per_day, upd.over_km_price_krw,
               upd.deposit_krw, upd.return_odometer_km, upd.pickup_odometer_km,
               upd.settled_amount_krw, upd.settled_at, upd.pickup_location, upd.return_location,
               upd.status, upd.note, upd.created_at
          FROM upd
     LEFT JOIN devices d ON d.id = upd.device_id"#,
    )
    .bind(id).bind(user.user_id)
    .bind(req.return_odometer_km).bind(req.return_location.as_deref())
    .bind(settled).bind(req.note.as_deref())
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn delete_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let n = sqlx::query("DELETE FROM rental_contracts WHERE id = $1 AND user_id = $2")
        .bind(id).bind(user.user_id).execute(&state.db).await?.rows_affected();
    if n == 0 { return Err(AppError::NotFound); }
    Ok(Json(serde_json::json!({ "ok": true })))
}

const SQL_LIST_ALL: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.starts_at < $3 AND c.ends_at > $2
    ORDER BY c.starts_at DESC";
const SQL_LIST_DEV: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.device_id = $2 AND c.starts_at < $4 AND c.ends_at > $3
    ORDER BY c.starts_at DESC";
const SQL_LIST_STATUS: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.starts_at < $3 AND c.ends_at > $2 AND c.status = ANY($4::TEXT[])
    ORDER BY c.starts_at DESC";
const SQL_LIST_DEV_STATUS: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.device_id = $2 AND c.starts_at < $4 AND c.ends_at > $3
      AND c.status = ANY($5::TEXT[])
    ORDER BY c.starts_at DESC";

const SQL_INSERT: &str = r#"WITH ins AS (
    INSERT INTO rental_contracts
        (user_id, device_id, renter_name, renter_phone, renter_id_last4,
         starts_at, ends_at, rate_type, rate_amount_krw,
         included_km_per_day, over_km_price_krw, deposit_krw,
         pickup_odometer_km, pickup_location, return_location,
         status, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING *
)
SELECT ins.id, ins.user_id, ins.device_id,
       d.display_name  AS device_name,
       d.license_plate AS license_plate,
       ins.renter_name, ins.renter_phone, ins.renter_id_last4,
       ins.starts_at, ins.ends_at,
       ins.rate_type, ins.rate_amount_krw, ins.included_km_per_day, ins.over_km_price_krw,
       ins.deposit_krw, ins.return_odometer_km, ins.pickup_odometer_km,
       ins.settled_amount_krw, ins.settled_at, ins.pickup_location, ins.return_location,
       ins.status, ins.note, ins.created_at
  FROM ins
LEFT JOIN devices d ON d.id = ins.device_id"#;

const SQL_UPDATE: &str = r#"WITH upd AS (
    UPDATE rental_contracts SET
        device_id = $3, renter_name = $4, renter_phone = $5, renter_id_last4 = $6,
        starts_at = $7, ends_at = $8,
        rate_type = $9, rate_amount_krw = $10,
        included_km_per_day = $11, over_km_price_krw = $12, deposit_krw = $13,
        pickup_odometer_km = $14, pickup_location = $15, return_location = $16,
        status = $17, note = $18,
        updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING *
)
SELECT upd.id, upd.user_id, upd.device_id,
       d.display_name  AS device_name,
       d.license_plate AS license_plate,
       upd.renter_name, upd.renter_phone, upd.renter_id_last4,
       upd.starts_at, upd.ends_at,
       upd.rate_type, upd.rate_amount_krw, upd.included_km_per_day, upd.over_km_price_krw,
       upd.deposit_krw, upd.return_odometer_km, upd.pickup_odometer_km,
       upd.settled_amount_krw, upd.settled_at, upd.pickup_location, upd.return_location,
       upd.status, upd.note, upd.created_at
  FROM upd
LEFT JOIN devices d ON d.id = upd.device_id"#;
