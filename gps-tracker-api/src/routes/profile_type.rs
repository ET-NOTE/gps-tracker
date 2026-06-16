// /api/v1/me/account-type — 계정 유형 + 디바이스별 override.
//
// 유형: unspecified / rentcar / corporate_fleet / delivery
// 디바이스 effective type = device.override ?? user.account_type
// (각 유형별 특화 라우터는 routes/profile_corporate.rs 등에서 구현)

use axum::{extract::{Path, State}, routing::{get, patch}, Json, Router};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

const VALID: &[&str] = &["unspecified", "rentcar", "corporate_fleet", "delivery"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/me/account-type",                get(get_my_type).patch(set_my_type))
        .route("/devices/:id/account-type",       patch(set_device_override))
}

#[derive(Debug, Serialize)]
struct AccountTypeView {
    account_type: String,
}

#[derive(Debug, Deserialize)]
struct SetType {
    account_type: String,
}

async fn get_my_type(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<AccountTypeView>> {
    let t: String = sqlx::query_scalar(
        "SELECT account_type FROM users WHERE id = $1",
    )
    .bind(user.user_id)
    .fetch_one(&state.db).await?;
    Ok(Json(AccountTypeView { account_type: t }))
}

async fn set_my_type(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<SetType>,
) -> AppResult<Json<AccountTypeView>> {
    if !VALID.contains(&req.account_type.as_str()) {
        return Err(AppError::BadRequest(format!("invalid account_type: {}", req.account_type)));
    }
    sqlx::query("UPDATE users SET account_type = $2 WHERE id = $1")
        .bind(user.user_id).bind(&req.account_type)
        .execute(&state.db).await?;
    Ok(Json(AccountTypeView { account_type: req.account_type }))
}

#[derive(Debug, Deserialize)]
struct SetDeviceOverride {
    account_type: Option<String>,    // null/missing → override 제거
}

#[derive(Debug, Serialize)]
struct DeviceTypeView {
    device_id: i64,
    override_type: Option<String>,
    effective_type: String,
}

async fn set_device_override(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    Json(req): Json<SetDeviceOverride>,
) -> AppResult<Json<DeviceTypeView>> {
    // 본인 디바이스인지 검증
    let owner: Option<i64> = sqlx::query_scalar(
        "SELECT owner_id FROM devices WHERE id = $1",
    )
    .bind(device_id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) { return Err(AppError::NotFound); }

    let val = req.account_type.as_deref();
    if let Some(v) = val {
        if !VALID.contains(&v) {
            return Err(AppError::BadRequest(format!("invalid account_type: {v}")));
        }
    }

    sqlx::query("UPDATE devices SET account_type_override = $2 WHERE id = $1")
        .bind(device_id).bind(val)
        .execute(&state.db).await?;

    let row: (Option<String>, String) = sqlx::query_as(
        r#"SELECT d.account_type_override, u.account_type
             FROM devices d JOIN users u ON u.id = d.owner_id
            WHERE d.id = $1"#,
    )
    .bind(device_id).fetch_one(&state.db).await?;
    let (override_type, account_type) = row;
    let effective = override_type.clone().unwrap_or(account_type);

    Ok(Json(DeviceTypeView {
        device_id,
        override_type,
        effective_type: effective,
    }))
}

/// 헬퍼: 디바이스의 effective account_type 조회 (overrides ?? user.account_type)
pub async fn effective_type(db: &sqlx::PgPool, device_id: i64) -> AppResult<String> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        r#"SELECT d.account_type_override, u.account_type
             FROM devices d JOIN users u ON u.id = d.owner_id
            WHERE d.id = $1"#,
    )
    .bind(device_id).fetch_optional(db).await?;
    let (override_type, account_type) = row.ok_or(AppError::NotFound)?;
    Ok(override_type.unwrap_or(account_type))
}
