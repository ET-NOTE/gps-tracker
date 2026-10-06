use super::*;
use axum::{body::to_bytes, extract::Path};
use image::{ImageFormat, ImageReader, Limits};
use std::io::Cursor;

const UPLOAD_LIMIT: usize = 2 * 1024 * 1024;
const STORED_LIMIT: usize = 1536 * 1024;
const STORAGE_LIMIT: i64 = 100 * 1024 * 1024;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Thumbnail {
    pub id: String,
    pub alt: String,
}
pub fn valid_thumbnail(t: &Thumbnail) -> bool {
    valid_id(&t.id) && !t.alt.trim().is_empty() && t.alt.chars().count() <= 200
}

fn unavailable() -> Error {
    Error(StatusCode::NOT_FOUND, "사진을 찾을 수 없습니다.".into())
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn normalize(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    let invalid = || bad("PNG·JPEG·WebP 사진을 다시 선택해 주세요.");
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| invalid())?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err(invalid());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(1600);
    limits.max_image_height = Some(1600);
    limits.max_alloc = Some(24 * 1024 * 1024);
    reader.limits(limits);
    // Decode and re-encode: user-controlled metadata/HTML never reaches a public response.
    let mut picture = reader.decode().map_err(|_| {
        bad("사진을 읽지 못했습니다. 가로·세로 1,600px 이하로 줄여 다시 시도해 주세요.")
    })?;
    loop {
        let mut output = Cursor::new(Vec::new());
        picture
            .write_to(&mut output, ImageFormat::WebP)
            .map_err(|_| invalid())?;
        let data = output.into_inner();
        if data.len() <= STORED_LIMIT {
            return Ok((data, picture.width(), picture.height()));
        }
        picture = picture.resize(
            picture.width() * 3 / 4,
            picture.height() * 3 / 4,
            image::imageops::FilterType::Triangle,
        );
    }
}

pub async fn upload(State(app): State<App>, request: Request) -> Result<Json<Value>> {
    let actor = admin::require(&app, request.headers()).await?;
    auth::rate(&app, format!("post-images:{actor}"), 60).await?;
    // Share the costly-work budget with password hashing. Only one image conversion
    // runs, with no concurrent password hashing, inside the 128 MiB service limit.
    let permit = app
        .password_slots
        .clone()
        .try_acquire_many_owned(2)
        .map_err(|_| {
            Error(
                StatusCode::TOO_MANY_REQUESTS,
                "사진을 처리 중입니다. 잠시 후 다시 시도해 주세요.".into(),
            )
        })?;
    let bytes = to_bytes(request.into_body(), UPLOAD_LIMIT)
        .await
        .map_err(|_| {
            Error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "사진을 2MB 이하로 줄여 다시 시도해 주세요.".into(),
            )
        })?;
    let (data, width, height) = tokio::task::spawn_blocking(move || {
        let _permit = permit; // A timed-out HTTP request must not release this early.
        normalize(&bytes)
    })
    .await
    .map_err(|_| bad("사진을 처리하지 못했습니다. 다시 시도해 주세요."))??;
    let id = format!("{:x}", Sha256::digest(&data));
    let size = data.len();
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(8043002)")
        .execute(&mut *tx)
        .await?;
    // Only abandoned uploads expire. Anything ever saved in a post is retained
    // for the audit/history, even after it is removed from the current revision.
    sqlx::query("DELETE FROM post_images WHERE attached_at IS NULL AND created_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM post_image_links WHERE image_id=post_images.id) AND NOT EXISTS(SELECT 1 FROM category_thumbnails WHERE image_id=post_images.id)").execute(&mut *tx).await?;
    let existing: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM post_images WHERE id=$1)")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if !existing {
        let (total, count): (i64, i64) = sqlx::query_as(
            "SELECT coalesce(sum(octet_length(data)),0)::bigint,count(*) FROM post_images",
        )
        .fetch_one(&mut *tx)
        .await?;
        if total + size as i64 > STORAGE_LIMIT || count >= 1000 {
            return Err(bad(
                "사진 보관 한도에 도달했습니다. 운영 담당자에게 문의해 주세요.",
            ));
        }
        sqlx::query(
            "INSERT INTO post_images(id,data,width,height,created_by) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(&id)
        .bind(data)
        .bind(width as i32)
        .bind(height as i32)
        .bind(actor)
        .execute(&mut *tx)
        .await?;
        admin::audit(
            &mut tx,
            Some(actor),
            "post.image.upload",
            "post_image",
            &id,
            json!({"bytes":size,"width":width,"height":height}),
        )
        .await?;
    } else {
        // Refresh the lifetime when an abandoned image is selected again.
        sqlx::query("UPDATE post_images SET created_at=now() WHERE id=$1 AND attached_at IS NULL")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"width":width,"height":height,"bytes":size}),
    ))
}

pub async fn get_image(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    if !valid_id(&id) {
        return Err(unavailable());
    }
    let published: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM post_image_links l JOIN content_posts p ON p.slug=l.post_slug WHERE l.image_id=$1 AND p.published) OR EXISTS(SELECT 1 FROM category_thumbnails c JOIN content_posts p ON coalesce(nullif(btrim(p.content->>'category'),''),'기타')=c.category WHERE c.image_id=$1 AND p.published AND coalesce(p.content->>'kind','example')='example')")
        .bind(&id).fetch_one(&app.db).await?;
    if !published && admin::require(&app, &h).await.is_err() {
        return Err(unavailable());
    }
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT data FROM post_images WHERE id=$1")
        .bind(&id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(unavailable)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CONTENT_DISPOSITION, "inline"),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_html_svg_and_oversized_dimensions() {
        assert!(normalize(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1601, 1)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        assert!(normalize(png.get_ref()).is_err());
    }
    #[test]
    fn creates_canonical_webp_and_preserves_transparency() {
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(20, 10)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let (data, w, h) = normalize(png.get_ref()).unwrap();
        assert_eq!((w, h), (20, 10));
        assert_eq!(image::guess_format(&data).unwrap(), ImageFormat::WebP);
        assert_eq!(
            image::load_from_memory(&data)
                .unwrap()
                .to_rgba8()
                .get_pixel(0, 0)
                .0[3],
            0
        );
    }
}
