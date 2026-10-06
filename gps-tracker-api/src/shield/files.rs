use super::*;
use axum::{
    body::to_bytes,
    extract::{Path, Query},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriveFile {
    url: String,
    filename: String,
    // Optional one-time migration of a content-addressed attachment; posts and old links stay intact.
    existing_id: Option<String>,
}

fn drive_url(input: &str) -> Option<String> {
    let input = input.trim();
    if input.len() > 1000 || input.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    let url = reqwest::Url::parse(input).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("drive.google.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let params: Vec<_> = url.query_pairs().collect();
    let ids: Vec<_> = params.iter().filter(|(k, _)| k == "id").collect();
    let keys: Vec<_> = params.iter().filter(|(k, _)| k == "resourcekey").collect();
    if ids.len() > 1 || keys.len() > 1 {
        return None;
    }
    let segments: Vec<_> = url.path_segments()?.collect();
    let id = match segments.as_slice() {
        ["file", "d", id, "view"] | ["file", "d", id] if ids.is_empty() => id.to_string(),
        ["open"] | ["uc"] if ids.len() == 1 => ids[0].1.to_string(),
        _ => return None,
    };
    let safe = |s: &str| {
        !s.is_empty()
            && s.len() <= 200
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    if id.len() < 10 || !safe(&id) {
        return None;
    }
    let mut canonical = format!("https://drive.google.com/file/d/{id}/view");
    if let Some((_, key)) = keys.first() {
        if !safe(key) {
            return None;
        }
        canonical.push_str("?resourcekey=");
        canonical.push_str(key);
    }
    Some(canonical)
}

pub async fn register_drive(
    State(app): State<App>,
    h: HeaderMap,
    Json(input): Json<DriveFile>,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, &h).await?;
    auth::rate(&app, format!("post-files:{actor}"), 60).await?;
    let url = drive_url(&input.url).ok_or_else(|| {
        bad("Google Drive 파일의 공유 링크를 입력해 주세요. 폴더 링크는 사용할 수 없습니다.")
    })?;
    let name = input.filename.trim();
    if !valid_name(name) {
        return Err(bad(
            "파일 이름과 확장자를 입력해 주세요. 예: example.zip, example.ino, GUIDE.md",
        ));
    }
    let id = if let Some(id) = input.existing_id.as_ref() {
        if !images::valid_id(id) {
            return Err(bad("첨부파일 식별자를 확인해 주세요."));
        }
        id.clone()
    } else {
        format!(
            "{:x}",
            Sha256::digest(format!("google-drive:{url}").as_bytes())
        )
    };
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(8043003)")
        .execute(&mut *tx)
        .await?;
    let existing: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT filename,drive_url FROM post_files WHERE id=$1 FOR UPDATE")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let filename = if let Some((filename, current)) = existing {
        if current.as_ref().is_some_and(|value| value != &url)
            || (current.is_none() && input.existing_id.is_none())
        {
            return Err(Error(
                StatusCode::CONFLICT,
                "이미 연결된 파일입니다. 다른 링크는 새 첨부로 추가해 주세요.".into(),
            ));
        }
        if current.is_none() {
            sqlx::query("UPDATE post_files SET drive_url=$2 WHERE id=$1")
                .bind(&id)
                .bind(&url)
                .execute(&mut *tx)
                .await?;
            admin::audit(
                &mut tx,
                Some(actor),
                "post.file.drive",
                "post_file",
                &id,
                json!({"url":url,"migrated":true}),
            )
            .await?;
        }
        // A repeated registration keeps an unreferenced entry alive until the editor saves.
        sqlx::query("UPDATE post_files SET created_at=now() WHERE id=$1 AND attached_at IS NULL")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        filename
    } else {
        if input.existing_id.is_some() {
            return Err(Error(
                StatusCode::NOT_FOUND,
                "기존 첨부파일이 없습니다.".into(),
            ));
        }
        sqlx::query("DELETE FROM post_files WHERE attached_at IS NULL AND created_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM post_file_links WHERE file_id=post_files.id)").execute(&mut *tx).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM post_files")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 500 {
            return Err(bad(
                "첨부파일 보관 한도에 도달했습니다. 운영 담당자에게 문의해 주세요.",
            ));
        }
        sqlx::query("INSERT INTO post_files(id,filename,drive_url,created_by) VALUES($1,$2,$3,$4)")
            .bind(&id)
            .bind(name)
            .bind(&url)
            .bind(actor)
            .execute(&mut *tx)
            .await?;
        admin::audit(
            &mut tx,
            Some(actor),
            "post.file.drive",
            "post_file",
            &id,
            json!({"filename":name,"url":url,"migrated":false}),
        )
        .await?;
        name.to_string()
    };
    tx.commit().await?;
    Ok(Json(json!({"id":id,"filename":filename,"drive_url":url})))
}

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
    // Check the destination before loading any stored bytes. The VPS never proxies Drive content.
    let destination: Option<Option<String>> =
        sqlx::query_scalar("SELECT drive_url FROM post_files WHERE id=$1")
            .bind(&id)
            .fetch_optional(&app.db)
            .await?;
    if let Some(url) = destination.ok_or_else(missing)? {
        let url = drive_url(&url).ok_or_else(missing)?;
        return Ok(axum::response::Redirect::temporary(&url).into_response());
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

#[cfg(test)]
mod tests {
    use super::drive_url;
    #[test]
    fn drive_links_are_canonical_file_links_only() {
        let view = "https://drive.google.com/file/d/abc123_DEF-456/view";
        assert_eq!(drive_url(&format!("{view}?usp=sharing")), Some(view.into()));
        assert_eq!(
            drive_url("https://drive.google.com/open?id=abc123_DEF-456"),
            Some(view.into())
        );
        assert_eq!(drive_url("https://drive.google.com/uc?export=download&id=abc123_DEF-456&resourcekey=0-abc123"), Some(format!("{view}?resourcekey=0-abc123")));
        for invalid in [
            "http://drive.google.com/file/d/abc123_DEF-456/view",
            "https://drive.google.com.evil.test/file/d/abc123_DEF-456/view",
            "https://user@drive.google.com/file/d/abc123_DEF-456/view",
            "https://drive.google.com:444/file/d/abc123_DEF-456/view",
            "https://drive.google.com/drive/folders/abc123_DEF-456",
            "https://drive.google.com/open?id=abc123_DEF-456&id=other123456",
            "https://drive.google.com/file/d/abc%2F123_DEF-456/view",
            "https://drive.google.com/file/d/abc123_DEF-456/view#fragment",
            "https://drive.google.com/file/d/abc123_DEF-456/view?resourcekey=abc&resourcekey=def",
            "https://drive.google.com/file/d/abc123_DEF-456/view?resourcekey=https://evil.test",
            "https://drive.google.com/\\evil.test",
            "https://drive.google.com/file/d/abc123_DEF-456/\nview",
        ] {
            assert_eq!(drive_url(invalid), None, "{invalid}");
        }
    }
}
