//! Read-only monitor for the unclaimed UNO bench device; independent of KC routes.
use axum::{
    extract::{Query, State},
    http::header,
    response::{Html, IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{error::AppResult, state::AppState};

pub async fn page() -> Response {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Html(include_str!("arduino_shield.html")),
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
    // A single snapshot; UID is fixed and every record joins the ownership guard.
    // No raw payload, subscriber IDs, precise coordinates, or KC devices are exposed.
    let value: Value = sqlx::query_scalar(include_str!("arduino_shield.sql"))
        .bind("uno-shield-test")
        .fetch_one(&state.db)
        .await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response())
}
