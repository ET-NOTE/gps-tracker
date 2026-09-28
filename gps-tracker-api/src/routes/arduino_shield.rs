//! Shield status: one public bench UID, and an independently authenticated owner view.
use axum::{
    extract::{Path, Query, State},
    http::header,
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

pub async fn page() -> Response {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Html(include_str!("arduino_shield.html").replace(
            "__SHIELD_RELEASE__",
            option_env!("GPS_RELEASE").unwrap_or("local"),
        )),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShieldQuery {}

pub async fn data(
    State(state): State<AppState>,
    Query(_query): Query<ShieldQuery>,
) -> AppResult<Response> {
    // The operator explicitly keeps this bench UID's status public after pairing.
    // A single snapshot; the UID is fixed and never selected through user input.
    // No raw payload, subscriber IDs, precise coordinates, or KC devices are exposed.
    let value: Value = sqlx::query_scalar(include_str!("arduino_shield.sql"))
        .bind("uno-shield-test")
        .bind::<Option<i64>>(None)
        .fetch_one(&state.db)
        .await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/shield-monitor/devices", get(owned_devices))
        .route("/shield-monitor/devices/:id", get(owned_data))
}

#[derive(Serialize, sqlx::FromRow)]
struct ShieldDevice {
    id: i64,
    device_uid: String,
    display_name: Option<String>,
    last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
}

async fn owned_devices(State(state): State<AppState>, auth: AuthUser) -> AppResult<Response> {
    // The v1 transport reserves this UID namespace; phone and IDF devices are excluded.
    let devices = sqlx::query_as::<_, ShieldDevice>(
        "SELECT id,device_uid,display_name,last_seen_at FROM devices
         WHERE owner_id=$1 AND device_kind='hardware' AND device_uid LIKE 'uno-shield-%'
         ORDER BY COALESCE(display_name,device_uid),id",
    )
    .bind(auth.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(devices)).into_response())
}

async fn owned_data(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let uid: String = sqlx::query_scalar(
        "SELECT device_uid FROM devices WHERE id=$1 AND owner_id=$2
         AND device_kind='hardware' AND device_uid LIKE 'uno-shield-%'",
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    // Recheck ownership in the same snapshot as the history. Old owners' rows are excluded.
    let value: Value = sqlx::query_scalar(include_str!("arduino_shield.sql"))
        .bind(uid)
        .bind(Some(auth.user_id))
        .fetch_one(&state.db)
        .await?;
    if value.get("available").and_then(Value::as_bool) != Some(true) {
        return Err(AppError::NotFound);
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response())
}
