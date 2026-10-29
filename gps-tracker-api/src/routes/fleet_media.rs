//! Private vehicle photos remain attached to the asset across SIM changes.
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
pub fn router() -> Router<AppState> {
    Router::new().route(
        "/corporate/vehicles/:id/photo",
        get(read_car_image)
            .post(upload_car_image)
            .layer(DefaultBodyLimit::max(6 * 1024 * 1024)),
    )
}
fn private_car_images() -> std::path::PathBuf {
    let uploads = std::path::PathBuf::from(
        std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "/home/mmm/uploads".into()),
    );
    std::env::var("PRIVATE_UPLOAD_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| uploads.with_file_name("gps-private-uploads"))
        .join("car-images")
}

async fn read_car_image(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    use axum::response::IntoResponse;
    let mut tx = state.db.begin().await?;
    let url: Option<String> = sqlx::query_scalar(
        "SELECT profile->>'car_image_url' FROM fleet_vehicles WHERE id=$1 AND owner_id=$2 FOR SHARE",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let url = url.ok_or(AppError::NotFound)?;
    let legacy: Option<i64> = sqlx::query_scalar(
        "SELECT legacy_device_id FROM fleet_vehicles WHERE id=$1 AND owner_id=$2",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_one(&mut *tx)
    .await?;
    let prefix = if url.starts_with(&format!("/uploads/car-images/fleet_{id}_")) {
        format!("/uploads/car-images/fleet_{id}_")
    } else {
        format!(
            "/uploads/car-images/dev_{}_",
            legacy.ok_or(AppError::NotFound)?
        )
    };
    if !url.starts_with(&prefix) || url.contains("..") || url[prefix.len()..].contains('/') {
        return Err(AppError::NotFound);
    }
    let name = url.rsplit('/').next().ok_or(AppError::NotFound)?;
    let bytes = tokio::fs::read(private_car_images().join(name))
        .await
        .map_err(|_| AppError::NotFound)?;
    let mime = if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    tx.commit().await?;
    Ok((
        [
            ("content-type", mime),
            ("cache-control", "private, no-store"),
            ("x-content-type-options", "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

async fn upload_car_image(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    mut multipart: axum::extract::Multipart,
) -> AppResult<Json<Value>> {
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM fleet_vehicles WHERE id=$1 AND owner_id=$2)",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_one(&state.db)
    .await?;
    if !owned {
        return Err(AppError::NotFound);
    }
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
        if bytes.len() > 5 * 1024 * 1024 {
            return Err(AppError::BadRequest("image exceeds 5 MiB".into()));
        }
        let ext = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "jpg"
        } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "png"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "webp"
        } else {
            return Err(AppError::BadRequest("JPEG, PNG or WebP required".into()));
        };
        let root = private_car_images();
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let name = format!("fleet_{id}_{}.{ext}", uuid::Uuid::new_v4());
        let path = root.join(&name);
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let url = format!("/uploads/car-images/{name}");
        let result = sqlx::query("UPDATE fleet_vehicles SET profile=jsonb_set(profile,'{car_image_url}',to_jsonb($1::text)),updated_at=clock_timestamp() WHERE id=$2 AND owner_id=$3")
            .bind(&url)
            .bind(id)
            .bind(user.user_id)
            .execute(&state.db)
            .await;
        match result {
            Ok(r) if r.rows_affected() == 1 => {
                return Ok(Json(json!({"url":url,"car_image_url":url})))
            }
            other => {
                let _ = tokio::fs::remove_file(&path).await;
                return Err(other
                    .err()
                    .map(AppError::from)
                    .unwrap_or(AppError::NotFound));
            }
        }
    }
    Err(AppError::BadRequest("file required".into()))
}
