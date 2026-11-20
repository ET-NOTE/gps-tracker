use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("internal error")]
    Internal(#[from] anyhow::Error),

    #[error("database error")]
    Database(#[from] sqlx::Error),

    #[error("not found")]
    NotFound,

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("unauthorized")]
    Unauthorized,

    #[error("forbidden")]
    Forbidden,

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("gone: {0}")]
    Gone(String),

    #[error("too many requests: {0}")]
    TooManyRequests(String),

    #[error("location read capacity exhausted")]
    LocationReadBusy,

    #[error("location read timed out")]
    LocationReadTimeout,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Only this overload is safe for the client to retry automatically.
        if matches!(self, Self::LocationReadBusy) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "2"), ("cache-control", "no-store")],
                Json(json!({"code":"location_read_busy", "error":"조회가 많습니다. 잠시 후 다시 시도해 주세요."})),
            ).into_response();
        }
        let (status, msg) = match &self {
            AppError::Internal(e) => {
                tracing::error!("internal: {:#}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
            AppError::Database(e) => {
                tracing::error!("database: {:#}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "database error".to_string(),
                )
            }
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            AppError::Gone(m) => (StatusCode::GONE, m.clone()),
            AppError::TooManyRequests(m) => (StatusCode::TOO_MANY_REQUESTS, m.clone()),
            AppError::LocationReadBusy => unreachable!(),
            AppError::LocationReadTimeout => (
                StatusCode::REQUEST_TIMEOUT,
                "조회 시간이 초과되었습니다. 기간을 줄여 다시 조회해 주세요.".to_string(),
            ),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
