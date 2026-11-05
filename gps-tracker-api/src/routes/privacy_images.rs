//! Reviewed raster snapshots. Only chosen RGB pixels are retained; no source/PDF metadata.
use super::privacy_delivery::{active, no_store, rate_limit};
use crate::{
    auth::{password, AdminUser, AuthUser},
    error::{AppError, AppResult},
    services::privacy::RequestRow,
    state::AppState,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use std::sync::OnceLock;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/privacy/requests/:id/image-preview", post(preview))
        .route(
            "/admin/privacy/requests/:id/images",
            get(admin_list).post(issue),
        )
        .route("/admin/privacy/images/:id/revoke", post(revoke))
        .route("/privacy/requests/:id/images", get(list))
        .route("/privacy/images/:id/download", post(download))
        .layer(DefaultBodyLimit::max(4_100_000))
        .layer(middleware::from_fn(no_store))
}
fn conflict() -> AppError {
    AppError::Conflict("요청·회사 범위 또는 제공본이 변경됐습니다. 다시 검토해 주세요.".into())
}
fn bad() -> AppError {
    AppError::BadRequest(
        "자료 참조·안내와 공개할 영역을 확인하세요. 최대 100만 화소·30개 영역입니다.".into(),
    )
}
fn digest(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn text(s: &str, n: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= n && !s.contains('\0')
}
#[derive(Clone, Deserialize, Serialize)]
struct Region {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}
#[derive(Deserialize)]
struct Selection {
    company_review_id: Option<i64>,
    company_revision: Option<i32>,
    category: String,
    source_reference: String,
    source_sha256: String,
    width: u32,
    height: u32,
    regions: Vec<Region>,
    notice: String,
    rgb_base64: String,
}
struct Prepared {
    png: Vec<u8>,
    selection_hash: String,
    output_hash: String,
}
impl Selection {
    fn prepare(&self) -> AppResult<Prepared> {
        if !matches!(self.category.as_str(), "document" | "photo" | "receipt")
            || !text(&self.source_reference, 160)
            || !text(&self.notice, 1000)
            || self.source_sha256.len() != 64
            || !self
                .source_sha256
                .bytes()
                .all(|x| x.is_ascii_hexdigit() && !x.is_ascii_uppercase())
            || self.company_review_id.is_some() != self.company_revision.is_some()
            || self.width == 0
            || self.height == 0
            || self.width > 2048
            || self.height > 2048
            || u64::from(self.width) * u64::from(self.height) > 1_000_000
            || self.regions.is_empty()
            || self.regions.len() > 30
            || self.rgb_base64.len() > 4_000_000
        {
            return Err(bad());
        }
        let rgb = STANDARD.decode(&self.rgb_base64).map_err(|_| bad())?;
        if rgb.len() != (self.width * self.height * 3) as usize {
            return Err(bad());
        }
        // Start fully opaque black. Never copy unselected pixels, alpha or metadata.
        let mut output = vec![0u8; rgb.len()];
        for r in &self.regions {
            if r.width == 0
                || r.height == 0
                || r.x >= self.width
                || r.y >= self.height
                || r.width > self.width - r.x
                || r.height > self.height - r.y
            {
                return Err(bad());
            }
            for y in r.y..r.y + r.height {
                let start = ((y * self.width + r.x) * 3) as usize;
                let end = start + (r.width * 3) as usize;
                output[start..end].copy_from_slice(&rgb[start..end]);
            }
        }
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, self.width, self.height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| AppError::Internal(e.into()))?;
            writer
                .write_image_data(&output)
                .map_err(|e| AppError::Internal(e.into()))?;
        }
        if png.len() > 3_100_000 {
            return Err(bad());
        }
        let output_hash = digest(&png);
        let selection_hash = digest(
            serde_json::to_vec(&json!([
                self.company_review_id,
                self.company_revision,
                self.category,
                self.source_reference,
                self.source_sha256,
                self.width,
                self.height,
                self.regions,
                self.notice,
                output_hash
            ]))
            .expect("selection json")
            .as_slice(),
        );
        Ok(Prepared {
            png,
            output_hash,
            selection_hash,
        })
    }
}
async fn prepare(s: Selection) -> AppResult<(Selection, Prepared)> {
    static LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let permit = LIMIT
        .get_or_init(|| tokio::sync::Semaphore::new(2))
        .try_acquire()
        .map_err(|_| {
            AppError::TooManyRequests("제공본을 처리 중입니다. 잠시 후 다시 시도해 주세요.".into())
        })?;
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let p = s.prepare()?;
        Ok((s, p))
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    result
}
async fn begin(s: &AppState) -> AppResult<Transaction<'_, Postgres>> {
    let mut tx = s.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
async fn request(tx: &mut Transaction<'_, Postgres>, id: i64) -> AppResult<RequestRow> {
    let r: RequestRow = sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
    if r.kind != "access"
        || !matches!(r.status.as_str(), "in_review" | "needs_information")
        || r.due_at.is_none()
    {
        return Err(conflict());
    }
    active(tx, r.user_id).await?;
    Ok(r)
}
async fn company(
    tx: &mut Transaction<'_, Postgres>,
    rid: i64,
    id: Option<i64>,
    revision: Option<i32>,
) -> AppResult<()> {
    if let Some(id) = id {
        let row:Option<(i64,i32,String,Option<i64>,String)>=sqlx::query_as("SELECT company_owner_id,revision,identity,staff_id,status FROM privacy_company_reviews WHERE id=$1 AND request_id=$2 FOR SHARE").bind(id).bind(rid).fetch_optional(&mut **tx).await?;
        let (owner, rev, identity, staff, status) = row.ok_or_else(conflict)?;
        if Some(rev) != revision
            || identity != "confirmed"
            || staff.is_none()
            || matches!(status.as_str(), "excluded" | "restricted")
        {
            return Err(conflict());
        }
        active(tx, owner).await?;
    } else if revision.is_some() {
        return Err(bad());
    }
    Ok(())
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    rid: i64,
    did: Option<i64>,
    actor: i64,
    action: &str,
    hash: &str,
) -> AppResult<()> {
    sqlx::query("INSERT INTO privacy_image_events(request_id,delivery_id,actor_id,action,selection_sha256) VALUES($1,$2,$3,$4,$5)").bind(rid).bind(did).bind(actor).bind(action).bind(hash).execute(&mut **tx).await?;
    Ok(())
}
async fn preview(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(s): Json<Selection>,
) -> AppResult<Json<Value>> {
    rate_limit(
        &state,
        &format!("image-preview:{}", admin.user_id),
        &headers,
    )
    .await?;
    // Validate request/scope before processing, then recheck under lock after encoding.
    {
        let mut tx = begin(&state).await?;
        request(&mut tx, id).await?;
        company(&mut tx, id, s.company_review_id, s.company_revision).await?;
        tx.commit().await?;
    }
    let (s, p) = prepare(s).await?;
    let mut tx = begin(&state).await?;
    request(&mut tx, id).await?;
    company(&mut tx, id, s.company_review_id, s.company_revision).await?;
    event(
        &mut tx,
        id,
        None,
        admin.user_id,
        "preview",
        &p.selection_hash,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"png_base64":STANDARD.encode(p.png),"preview_sha256":p.selection_hash,"output_sha256":p.output_hash,"notice":s.notice}),
    ))
}
#[derive(Deserialize)]
struct Issue {
    revision: i32,
    confirmed: bool,
    source_confirmed: bool,
    preview_sha256: String,
    #[serde(flatten)]
    selection: Selection,
}
async fn issue(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(b): Json<Issue>,
) -> AppResult<Json<Value>> {
    if !b.confirmed || !b.source_confirmed {
        return Err(bad());
    }
    let (s, p) = prepare(b.selection).await?;
    let mut tx = begin(&state).await?;
    let r = request(&mut tx, id).await?;
    company(&mut tx, id, s.company_review_id, s.company_revision).await?;
    if r.revision != b.revision || p.selection_hash != b.preview_sha256 {
        return Err(conflict());
    }
    let seen:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_image_events WHERE request_id=$1 AND actor_id=$2 AND action='preview' AND selection_sha256=$3 AND created_at>now()-interval '1 hour')").bind(id).bind(admin.user_id).bind(&p.selection_hash).fetch_one(&mut *tx).await?;
    if !seen {
        return Err(conflict());
    }
    // Serialize total temporary storage quota across administrators/requests.
    sqlx::query("SELECT pg_advisory_xact_lock(12984713)")
        .execute(&mut *tx)
        .await?;
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM privacy_image_deliveries WHERE request_id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(octet_length(png_bytes)),0)::bigint FROM privacy_image_payloads",
    )
    .fetch_one(&mut *tx)
    .await?;
    if n >= 10 || used + p.png.len() as i64 > 64 * 1024 * 1024 {
        return Err(AppError::Conflict(
            "제공본 용량·발급 한도입니다. 담당자에게 분할 처리를 요청해 주세요.".into(),
        ));
    }
    let did:i64=sqlx::query_scalar("INSERT INTO privacy_image_deliveries(request_id,created_by,company_review_id,company_revision,category,source_reference,source_sha256,selection_sha256,output_sha256,width,height,regions,notice) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id").bind(id).bind(admin.user_id).bind(s.company_review_id).bind(s.company_revision).bind(&s.category).bind(&s.source_reference).bind(&s.source_sha256).bind(&p.selection_hash).bind(&p.output_hash).bind(s.width as i32).bind(s.height as i32).bind(json!(s.regions)).bind(&s.notice).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_image_payloads(delivery_id,png_bytes) VALUES($1,$2)")
        .bind(did)
        .bind(p.png)
        .execute(&mut *tx)
        .await?;
    event(
        &mut tx,
        id,
        Some(did),
        admin.user_id,
        "issued",
        &p.selection_hash,
    )
    .await?;
    let msg="검토한 이미지 일부를 제공했습니다. 범위·제외 사유를 확인하고 24시간 이내 내려받으세요. 요청 전체의 완료는 아닙니다.";
    sqlx::query("UPDATE privacy_requests SET revision=revision+1,assigned_to=$2,result_message=$3,updated_at=now() WHERE id=$1").bind(id).bind(admin.user_id).bind(msg).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,due_at) SELECT id,$2,revision,status,$3,due_at FROM privacy_requests WHERE id=$1").bind(id).bind(admin.user_id).bind(msg).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":did})))
}
const PUBLIC:&str="SELECT jsonb_build_object('id',g.id,'category',g.category,'notice',g.notice,'created_at',g.created_at,'expires_at',g.expires_at,'revoked_at',g.revoked_at,'available',NOT privacy_image_unavailable(g) AND EXISTS(SELECT 1 FROM privacy_image_payloads p WHERE p.delivery_id=g.id)) FROM privacy_image_deliveries g JOIN privacy_requests r ON r.id=g.request_id";
async fn list(
    State(s): State<AppState>,
    u: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "{PUBLIC} WHERE r.id=$1 AND r.user_id=$2 ORDER BY g.id DESC LIMIT 10"
    ))
    .bind(id)
    .bind(u.user_id)
    .fetch_all(&s.db)
    .await?;
    Ok(Json(json!({"items":rows})))
}
async fn admin_list(
    State(s): State<AppState>,
    _a: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let items:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(g)||jsonb_build_object('available',NOT privacy_image_unavailable(g) AND EXISTS(SELECT 1 FROM privacy_image_payloads p WHERE p.delivery_id=g.id)) FROM privacy_image_deliveries g WHERE request_id=$1 ORDER BY id DESC LIMIT 10").bind(id).fetch_all(&s.db).await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM privacy_image_events e WHERE request_id=$1 ORDER BY id DESC LIMIT 100").bind(id).fetch_all(&s.db).await?;
    Ok(Json(json!({"items":items,"events":events})))
}
async fn revoke(
    State(s): State<AppState>,
    a: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = begin(&s).await?;
    let rid: i64 =
        sqlx::query_scalar("SELECT request_id FROM privacy_image_deliveries WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    sqlx::query("SELECT id FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(rid)
        .execute(&mut *tx)
        .await?;
    let hash:Option<String>=sqlx::query_scalar("UPDATE privacy_image_deliveries SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING selection_sha256").bind(id).fetch_optional(&mut *tx).await?;
    if let Some(hash) = hash {
        event(&mut tx, rid, Some(id), a.user_id, "revoked", &hash).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Download {
    password: String,
}
#[derive(FromRow)]
struct Delivery {
    company_review_id: Option<i64>,
    company_revision: Option<i32>,
    selection_sha256: String,
    output_sha256: String,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}
async fn download(
    State(s): State<AppState>,
    u: AuthUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<Download>,
) -> AppResult<Response> {
    rate_limit(&s, &format!("user:{}", u.user_id), &headers).await?;
    if b.password.len() > 1024 {
        return Err(AppError::Unauthorized);
    }
    let mut tx = begin(&s).await?;
    let rid:i64=sqlx::query_scalar("SELECT g.request_id FROM privacy_image_deliveries g JOIN privacy_requests r ON r.id=g.request_id WHERE g.id=$1 AND r.user_id=$2").bind(id).bind(u.user_id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    let status: String =
        sqlx::query_scalar("SELECT status FROM privacy_requests WHERE id=$1 FOR SHARE")
            .bind(rid)
            .fetch_one(&mut *tx)
            .await?;
    active(&mut tx, u.user_id).await?;
    let d: Delivery =
        sqlx::query_as("SELECT * FROM privacy_image_deliveries WHERE id=$1 FOR SHARE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if d.revoked_at.is_some()
        || d.expires_at <= Utc::now()
        || matches!(status.as_str(), "cancelled" | "rejected")
    {
        return Err(AppError::Gone(
            "제공 기한이 끝났거나 회수된 자료입니다.".into(),
        ));
    }
    company(&mut tx, rid, d.company_review_id, d.company_revision).await?;
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1 FOR SHARE")
        .bind(u.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if !tokio::task::spawn_blocking(move || password::verify(&b.password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
    {
        return Err(AppError::Unauthorized);
    }
    let bytes: Vec<u8> = sqlx::query_scalar(
        "SELECT png_bytes FROM privacy_image_payloads WHERE delivery_id=$1 FOR SHARE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(conflict)?;
    if digest(&bytes) != d.output_sha256 {
        return Err(conflict());
    }
    event(
        &mut tx,
        rid,
        Some(id),
        u.user_id,
        "download_prepared",
        &d.selection_sha256,
    )
    .await?;
    tx.commit().await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"reviewed-image-{id}.png\""),
            ),
        ],
        bytes,
    )
        .into_response())
}
// Access expires immediately; physical temporary bytes are removed at startup and each minute.
// Review/audit metadata and any backup copies are separate retention-review scopes.
pub fn spawn_cleanup(pool: sqlx::PgPool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tick.tick().await;
            match sqlx::query_scalar::<_, i64>("SELECT privacy_cleanup_image_payloads()")
                .fetch_one(&pool)
                .await
            {
                Ok(n) if n > 0 => tracing::info!(removed = n, "temporary privacy images removed"),
                Ok(_) => {}
                Err(_) => tracing::error!("temporary privacy image cleanup failed"),
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Selection {
        Selection {
            company_review_id: None,
            company_revision: None,
            category: "photo".into(),
            source_reference: "test".into(),
            source_sha256: "a".repeat(64),
            width: 2,
            height: 1,
            regions: vec![Region {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            }],
            notice: "Partial".into(),
            rgb_base64: STANDARD.encode([255, 0, 0, 99, 88, 77]),
        }
    }
    #[test]
    fn only_selected_pixels_and_core_png_chunks() {
        let p = fixture().prepare().unwrap();
        let mut reader = png::Decoder::new(p.png.as_slice()).read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!(&buf[..info.buffer_size()], &[255, 0, 0, 0, 0, 0]);
        assert_eq!(info.color_type, png::ColorType::Rgb);
        let mut i = 8;
        while i < p.png.len() {
            let n = u32::from_be_bytes(p.png[i..i + 4].try_into().unwrap()) as usize;
            assert!([b"IHDR", b"IDAT", b"IEND"].contains(&p.png[i + 4..i + 8].try_into().unwrap()));
            i += n + 12;
        }
    }
    #[test]
    fn fail_closed_bounds_size_and_empty() {
        for regions in [
            vec![],
            vec![Region {
                x: 2,
                y: 0,
                width: 1,
                height: 1,
            }],
            vec![Region {
                x: 0,
                y: 0,
                width: u32::MAX,
                height: 1,
            }],
        ] {
            let mut s = fixture();
            s.regions = regions;
            assert!(s.prepare().is_err());
        }
        let mut s = fixture();
        s.rgb_base64 = STANDARD.encode([1, 2, 3]);
        assert!(s.prepare().is_err());
        s.width = 2049;
        assert!(s.prepare().is_err());
    }
    #[test]
    fn preview_binds_reference_notice_company_and_output() {
        let mut s = fixture();
        let a = s.prepare().unwrap().selection_hash;
        s.notice = "Changed".into();
        assert_ne!(a, s.prepare().unwrap().selection_hash);
        let b = s.prepare().unwrap().selection_hash;
        s.company_review_id = Some(1);
        s.company_revision = Some(2);
        assert_ne!(b, s.prepare().unwrap().selection_hash);
    }
}
