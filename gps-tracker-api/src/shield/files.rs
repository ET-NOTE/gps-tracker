use super::*;
use axum::{
    body::to_bytes,
    extract::{Path, Query},
};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Upload {
    name: String,
}
fn valid_name(s: &str) -> bool {
    let extension = s.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    !s.is_empty()
        && s.chars().count() <= 120
        && !s
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '"'))
        && [
            "ino", "h", "hpp", "c", "cpp", "py", "json", "txt", "csv", "md", "pdf", "zip",
        ]
        .contains(&extension.as_str())
}
pub async fn upload(
    State(app): State<App>,
    Query(input): Query<Upload>,
    request: Request,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, request.headers()).await?;
    let name = input.name.trim();
    if !valid_name(name) {
        return Err(bad(
            "코드·문서·ZIP 파일을 선택해 주세요. 파일명은 120자 이하로 입력해 주세요.",
        ));
    }
    auth::rate(&app, format!("post-files:{actor}"), 60).await?;
    let _permit = app
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            Error(
                StatusCode::TOO_MANY_REQUESTS,
                "파일을 처리 중입니다. 잠시 후 다시 시도해 주세요.".into(),
            )
        })?;
    let data = to_bytes(request.into_body(), 5 * 1024 * 1024)
        .await
        .map_err(|_| {
            Error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "첨부파일 한 개는 5MB 이하로 선택해 주세요.".into(),
            )
        })?;
    if data.is_empty() {
        return Err(bad("빈 파일은 첨부할 수 없습니다."));
    }
    let lower = name.to_ascii_lowercase();
    if (lower.ends_with(".pdf") && !data.starts_with(b"%PDF-"))
        || (lower.ends_with(".zip")
            && !data.starts_with(b"PK\x03\x04")
            && !data.starts_with(b"PK\x05\x06"))
    {
        return Err(bad("파일 내용과 확장자가 일치하지 않습니다."));
    }
    if !lower.ends_with(".pdf") && !lower.ends_with(".zip") && std::str::from_utf8(&data).is_err() {
        return Err(bad("코드·텍스트 파일은 UTF-8로 저장해 주세요."));
    }
    let id = format!("{:x}", Sha256::digest(&data));
    let size = data.len();
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(8043003)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM post_files WHERE attached_at IS NULL AND created_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM post_file_links WHERE file_id=post_files.id)").execute(&mut *tx).await?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT filename FROM post_files WHERE id=$1")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let filename = if let Some(existing) = existing {
        sqlx::query("UPDATE post_files SET created_at=now() WHERE id=$1 AND attached_at IS NULL")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        existing
    } else {
        let (total, count): (i64, i64) = sqlx::query_as(
            "SELECT coalesce(sum(octet_length(data)),0)::bigint,count(*) FROM post_files",
        )
        .fetch_one(&mut *tx)
        .await?;
        if total + size as i64 > 100 * 1024 * 1024 || count >= 500 {
            return Err(bad(
                "첨부파일 보관 한도에 도달했습니다. 운영 담당자에게 문의해 주세요.",
            ));
        }
        sqlx::query("INSERT INTO post_files(id,filename,data,created_by) VALUES($1,$2,$3,$4)")
            .bind(&id)
            .bind(name)
            .bind(data.to_vec())
            .bind(actor)
            .execute(&mut *tx)
            .await?;
        admin::audit(
            &mut tx,
            Some(actor),
            "post.file.upload",
            "post_file",
            &id,
            json!({"filename":name,"bytes":size}),
        )
        .await?;
        name.to_owned()
    };
    tx.commit().await?;
    Ok(Json(json!({"id":id,"filename":filename,"bytes":size})))
}
pub async fn download(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    let missing = || Error(StatusCode::NOT_FOUND, "첨부파일을 찾을 수 없습니다.".into());
    if !images::valid_id(&id) {
        return Err(missing());
    }
    let public:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM post_file_links l JOIN content_posts p ON p.slug=l.post_slug WHERE l.file_id=$1 AND p.published AND coalesce(p.content->>'kind','example')='example')").bind(&id).fetch_one(&app.db).await?;
    if !public && admin::require(&app, &h).await.is_err() {
        return Err(missing());
    }
    let (filename, data): (String, Vec<u8>) =
        sqlx::query_as("SELECT filename,data FROM post_files WHERE id=$1")
            .bind(&id)
            .fetch_optional(&app.db)
            .await?
            .ok_or_else(missing)?;
    let encoded: String = filename.bytes().map(|b| format!("%{b:02X}")).collect();
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=download; filename*=UTF-8''{encoded}"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'".into(),
            ),
        ],
        data,
    )
        .into_response())
}
