//! Public status monitor for the fixed UNO bench device; independent of KC routes.
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
    // The operator explicitly keeps this bench UID's status public after pairing.
    // A single snapshot; the UID is fixed and never selected through user input.
    // No raw payload, subscriber IDs, precise coordinates, or KC devices are exposed.
    let value: Value = sqlx::query_scalar(include_str!("arduino_shield.sql"))
        .bind("uno-shield-test")
        .fetch_one(&state.db)
        .await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response())
}
