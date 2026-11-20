// /api/v1/me/account-type — 계정 유형 + 디바이스별 override.
//
// 유형: unspecified / rentcar / corporate_fleet / delivery
// 디바이스 effective type = device.override ?? user.account_type
// (각 유형별 특화 라우터는 routes/profile_corporate.rs 등에서 구현)

use axum::{
    extract::{Path, State},
    routing::{get, patch},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

const VALID: &[&str] = &["unspecified", "rentcar", "corporate_fleet", "delivery"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/me/account-type", get(get_my_type).patch(set_my_type))
        .route("/devices/:id/account-type", patch(set_device_override))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AccountTypeView {
    account_type: String,
    enabled_services: Vec<String>,
    start_route: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetType {
    account_type: Option<String>,
    service: Option<String>,
    enabled: Option<bool>,
    start_route: Option<String>,
}

const ACCOUNT_SETTINGS: &str = "
    SELECT u.account_type, u.start_route,
           ARRAY(SELECT k FROM unnest(ARRAY['corporate_fleet','rentcar','delivery']) AS services(k)
                 WHERE gps_owner_service(u,k)) AS enabled_services
    FROM users u WHERE id=$1";

fn route_enabled(route: &str, services: &[String]) -> bool {
    let service = match route {
        "/" | "last" => return true,
        "/corporate" => "corporate_fleet",
        "/rentcar" => "rentcar",
        "/cargo" => "delivery",
        _ => return false,
    };
    services.iter().any(|key| key == service)
}

async fn get_my_type(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<AccountTypeView>> {
    let settings = sqlx::query_as(ACCOUNT_SETTINGS)
        .bind(user.user_id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(settings))
}

async fn set_my_type(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<SetType>,
) -> AppResult<Json<AccountTypeView>> {
    let mut tx = state.db.begin().await?;
    let owner = user.user_id;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(owner).fetch_one(&mut *tx).await?;

    match (req.account_type.as_deref(), req.service.as_deref(), req.enabled, req.start_route.as_deref()) {
        (Some(kind), None, None, None) if VALID.contains(&kind) => {
            // Older clients still switch the primary type. Explicit choices for other services survive.
            sqlx::query("UPDATE users SET account_type=$2,
                corporate_service_enabled=CASE WHEN $2='corporate_fleet' THEN NULL ELSE corporate_service_enabled END,
                rental_service_enabled=CASE WHEN $2='rentcar' THEN NULL ELSE rental_service_enabled END,
                cargo_service_enabled=CASE WHEN $2='delivery' THEN NULL ELSE cargo_service_enabled END WHERE id=$1")
                .bind(owner).bind(kind).execute(&mut *tx).await?;
        }
        (None, Some(service @ ("corporate_fleet" | "rentcar" | "delivery")), Some(enabled), None) => {
            sqlx::query("UPDATE users SET
                corporate_service_enabled=CASE WHEN $2='corporate_fleet' THEN $3 ELSE corporate_service_enabled END,
                rental_service_enabled=CASE WHEN $2='rentcar' THEN $3 ELSE rental_service_enabled END,
                cargo_service_enabled=CASE WHEN $2='delivery' THEN $3 ELSE cargo_service_enabled END WHERE id=$1")
                .bind(owner).bind(service).bind(enabled).execute(&mut *tx).await?;
        }
        (None, None, None, Some(_)) => {}
        _ => return Err(AppError::BadRequest("계정 유형, 이용 서비스 또는 시작 화면을 하나씩 지정해 주세요.".into())),
    }
    let mut settings: AccountTypeView = sqlx::query_as(ACCOUNT_SETTINGS)
        .bind(owner).fetch_one(&mut *tx).await?;
    let route = req.start_route.as_deref().unwrap_or(&settings.start_route);
    let route = if route_enabled(route, &settings.enabled_services) {
        route
    } else if req.start_route.is_none() {
        "/"
    } else {
        return Err(AppError::BadRequest("사용할 수 있는 시작 화면을 선택해 주세요.".into()));
    };
    if route != settings.start_route {
        sqlx::query("UPDATE users SET start_route=$2 WHERE id=$1")
            .bind(owner).bind(route).execute(&mut *tx).await?;
        settings.start_route = route.to_owned();
    }
    tx.commit().await?;
    Ok(Json(settings))
}

#[derive(Debug, Deserialize)]
struct SetDeviceOverride {
    account_type: Option<String>, // null/missing → override 제거
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
    let owner: Option<i64> =
        sqlx::query_scalar("SELECT owner_id FROM gps_read_devices WHERE id = $1")
            .bind(device_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }

    let val = req.account_type.as_deref();
    if let Some(v) = val {
        if !VALID.contains(&v) {
            return Err(AppError::BadRequest(format!("invalid account_type: {v}")));
        }
    }

    sqlx::query("UPDATE devices SET account_type_override = $2 WHERE id = $1")
        .bind(device_id)
        .bind(val)
        .execute(&state.db)
        .await?;

    let row: (Option<String>, String) = sqlx::query_as(
        r#"SELECT d.account_type_override, u.account_type
             FROM gps_read_devices d JOIN users u ON u.id = d.owner_id
            WHERE d.id = $1"#,
    )
    .bind(device_id)
    .fetch_one(&state.db)
    .await?;
    let (override_type, account_type) = row;
    let effective = override_type.clone().unwrap_or(account_type);

    Ok(Json(DeviceTypeView {
        device_id,
        override_type,
        effective_type: effective,
    }))
}
