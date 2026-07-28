// (2026-07-28) Stage-4C-3: 차량 서류 (등록증/보험/정비영수증) 업로드/조회/다운로드/삭제.
//
// 저장: 로컬 FS. UPLOAD_DIR env (기본 /home/mmm/uploads). soft cap 파일당 10MB, 차량당 20.
// 인증: owner 만. download 시 device.owner_id 확인.
//
// endpoints:
//   POST   /devices/:id/documents  (multipart: file, kind, note?)
//   GET    /devices/:id/documents  (list)
//   GET    /documents/:id/download (owner only, blob)
//   DELETE /documents/:id          (owner only, DB row + FS 파일 삭제)

use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::header,
    response::IntoResponse,
    routing::{delete, get},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;
use tokio::io::AsyncWriteExt;

use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;   // 10MB
const MAX_FILES_PER_DEVICE: i64 = 20;
const ALLOWED_MIMES: &[&str] = &[
    "application/pdf",
    "image/jpeg", "image/png", "image/webp", "image/gif",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices/:id/documents", get(list_documents).post(upload_document))
        .route("/documents/:id/download", get(download_document))
        .route("/documents/:id/preview",  get(preview_document))
        .route("/documents/:id",          delete(delete_document))
}

fn upload_dir() -> PathBuf {
    std::env::var("UPLOAD_DIR").ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/home/mmm/uploads"))
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\')
        .take(100)
        .collect()
}

#[derive(Debug, Serialize, FromRow)]
pub struct DocumentView {
    pub id:          i64,
    pub device_id:   i64,
    pub kind:        String,
    pub filename:    String,
    pub mime:        String,
    pub size_bytes:  i64,
    pub note:        Option<String>,
    pub uploaded_at: DateTime<Utc>,
}

async fn verify_device_owner(state: &AppState, uid: i64, device_id: i64) -> AppResult<()> {
    let owner: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT owner_id FROM devices WHERE id = $1",
    )
    .bind(device_id).fetch_optional(&state.db).await?;
    match owner {
        Some(Some(o)) if o == uid => Ok(()),
        Some(_) => Err(AppError::NotFound),
        None    => Err(AppError::NotFound),
    }
}

async fn list_documents(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
) -> AppResult<Json<Vec<DocumentView>>> {
    verify_device_owner(&state, user.user_id, device_id).await?;
    let rows: Vec<DocumentView> = sqlx::query_as(
        r#"SELECT id, device_id, kind, filename, mime, size_bytes, note, uploaded_at
             FROM device_documents
            WHERE device_id = $1
            ORDER BY uploaded_at DESC"#,
    )
    .bind(device_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

async fn upload_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    mut mp: Multipart,
) -> AppResult<Json<DocumentView>> {
    verify_device_owner(&state, user.user_id, device_id).await?;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM device_documents WHERE device_id = $1",
    )
    .bind(device_id).fetch_one(&state.db).await?;
    if count >= MAX_FILES_PER_DEVICE {
        return Err(AppError::BadRequest(
            format!("차량당 최대 {MAX_FILES_PER_DEVICE}개 서류. 오래된 것 삭제 후 재업로드.")));
    }

    let mut kind: Option<String> = None;
    let mut note: Option<String> = None;
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut file_name: Option<String>   = None;
    let mut file_mime: Option<String>   = None;

    while let Some(field) = mp.next_field().await.map_err(|e| AppError::BadRequest(format!("multipart: {e}")))? {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            file_name = field.file_name().map(sanitize_filename);
            file_mime = field.content_type().map(|s| s.to_string());
            let data = field.bytes().await.map_err(|e| AppError::BadRequest(format!("read: {e}")))?;
            if data.len() as u64 > MAX_FILE_BYTES {
                return Err(AppError::BadRequest(
                    format!("파일 크기 최대 {}MB", MAX_FILE_BYTES / 1024 / 1024)));
            }
            file_bytes = Some(data.to_vec());
        } else if name == "kind" {
            kind = Some(field.text().await.unwrap_or_default());
        } else if name == "note" {
            let t = field.text().await.unwrap_or_default();
            if !t.trim().is_empty() { note = Some(t); }
        }
    }

    let bytes = file_bytes.ok_or_else(|| AppError::BadRequest("file field missing".into()))?;
    let filename = file_name.filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("file name missing".into()))?;
    let mime = file_mime.unwrap_or_else(|| "application/octet-stream".into());
    let kind = kind.filter(|s| !s.is_empty()).unwrap_or_else(|| "other".into());

    if !ALLOWED_MIMES.contains(&mime.as_str()) {
        return Err(AppError::BadRequest(format!("지원 안 하는 MIME: {mime} (PDF/이미지만)")));
    }
    if !matches!(kind.as_str(), "registration"|"insurance"|"inspection"|"receipt"|"other") {
        return Err(AppError::BadRequest(format!("invalid kind: {kind}")));
    }

    let dir = upload_dir().join("device_documents").join(user.user_id.to_string()).join(device_id.to_string());
    tokio::fs::create_dir_all(&dir).await.map_err(|e| anyhow::anyhow!("mkdir: {e}"))?;
    let uuid = uuid::Uuid::new_v4();
    let stored_name = format!("{}_{}", uuid, filename);
    let stored_path = dir.join(&stored_name);
    let mut f = tokio::fs::File::create(&stored_path).await.map_err(|e| anyhow::anyhow!("create file: {e}"))?;
    f.write_all(&bytes).await.map_err(|e| anyhow::anyhow!("write file: {e}"))?;
    f.flush().await.ok();

    let row: DocumentView = sqlx::query_as(
        r#"INSERT INTO device_documents
             (user_id, device_id, kind, filename, stored_path, mime, size_bytes, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, device_id, kind, filename, mime, size_bytes, note, uploaded_at"#,
    )
    .bind(user.user_id).bind(device_id).bind(&kind).bind(&filename)
    .bind(stored_path.to_string_lossy().to_string())
    .bind(&mime).bind(bytes.len() as i64).bind(&note)
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn download_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    #[derive(FromRow)]
    struct Row { user_id: i64, stored_path: String, mime: String, filename: String }
    let row: Option<Row> = sqlx::query_as(
        "SELECT user_id, stored_path, mime, filename FROM device_documents WHERE id = $1",
    )
    .bind(id).fetch_optional(&state.db).await?;
    let row = row.ok_or(AppError::NotFound)?;
    if row.user_id != user.user_id { return Err(AppError::NotFound); }
    let data = tokio::fs::read(&row.stored_path).await
        .map_err(|e| anyhow::anyhow!("read file: {e}"))?;
    let cd = percent_encode(&row.filename);
    Ok((
        [(header::CONTENT_TYPE, row.mime.clone()),
         (header::CONTENT_DISPOSITION,
          format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", cd, cd))],
        Body::from(data),
    ).into_response())
}

// (2026-07-28) inline preview — <img> / <iframe> 로 바로 렌더 가능한 형태.
// Content-Disposition: inline. 원본 파일 그대로 (이미지/PDF).
async fn preview_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    #[derive(FromRow)]
    struct Row { user_id: i64, stored_path: String, mime: String, filename: String }
    let row: Option<Row> = sqlx::query_as(
        "SELECT user_id, stored_path, mime, filename FROM device_documents WHERE id = $1",
    ).bind(id).fetch_optional(&state.db).await?;
    let row = row.ok_or(AppError::NotFound)?;
    if row.user_id != user.user_id { return Err(AppError::NotFound); }
    let data = tokio::fs::read(&row.stored_path).await
        .map_err(|e| anyhow::anyhow!("read file: {e}"))?;
    let cd = percent_encode(&row.filename);
    Ok((
        [(header::CONTENT_TYPE, row.mime.clone()),
         (header::CONTENT_DISPOSITION,
          format!("inline; filename=\"{}\"; filename*=UTF-8''{}", cd, cd)),
         (header::CACHE_CONTROL, "private, max-age=3600".to_string())],
        Body::from(data),
    ).into_response())
}

async fn delete_document(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    #[derive(FromRow)]
    struct Row { stored_path: String }
    let row: Option<Row> = sqlx::query_as(
        "DELETE FROM device_documents WHERE id = $1 AND user_id = $2 RETURNING stored_path",
    )
    .bind(id).bind(user.user_id).fetch_optional(&state.db).await?;
    let row = row.ok_or(AppError::NotFound)?;
    let _ = tokio::fs::remove_file(&row.stored_path).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
