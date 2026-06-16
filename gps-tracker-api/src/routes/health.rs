use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::{error::AppResult, state::AppState};

pub async fn health(State(state): State<AppState>) -> AppResult<Json<Value>> {
    // DB 연결 확인 — 빠른 ping
    let row: (i32,) = sqlx::query_as("SELECT 1").fetch_one(&state.db).await?;

    Ok(Json(json!({
        "ok": true,
        "service": "gps-tracker-api",
        "db": row.0 == 1,
    })))
}
