//! Explicit Unicode-scalar selections, not automatic anonymisation. No body copies.
use super::privacy_delivery::{active, no_store, rate_limit};
use crate::{
    auth::{password, AdminUser, AuthUser},
    error::{AppError, AppResult},
    services::privacy::RequestRow,
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/privacy/requests/:id/text-sources", get(options))
        .route(
            "/admin/privacy/requests/:id/text-sources/:kind/:source",
            post(review),
        )
        .route(
            "/admin/privacy/requests/:id/redacted-preview",
            post(preview),
        )
        .route(
            "/admin/privacy/requests/:id/redacted",
            get(admin_list).post(issue),
        )
        .route("/admin/privacy/redacted/:id/revoke", post(revoke))
        .route("/privacy/requests/:id/redacted", get(list))
        .route("/privacy/redacted/:id/download", post(download))
        .layer(middleware::from_fn(no_store))
}
fn conflict() -> AppError {
    AppError::Conflict("원문 또는 요청 상태가 변경됐습니다. 다시 검토해 주세요.".into())
}
fn bad() -> AppError {
    AppError::BadRequest("제공할 구간과 제외 사유를 확인해 주세요. 최대 50개 구간입니다.".into())
}
fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Span {
    start: usize,
    end: usize,
}
// Unicode scalar offsets (not JS UTF-16 or UTF-8 bytes). Gaps remain explicit.
fn redact(text: &str, ranges: &[Span]) -> AppResult<String> {
    let chars: Vec<char> = text.chars().collect();
    if ranges.is_empty() || ranges.len() > 50 || chars.len() > 20000 {
        return Err(bad());
    }
    let mut cursor = 0;
    let mut out = String::new();
    for r in ranges {
        if r.start < cursor || r.end <= r.start || r.end > chars.len() {
            return Err(bad());
        }
        if r.start > cursor {
            out.push_str("[비공개]");
        }
        out.extend(chars[r.start..r.end].iter());
        cursor = r.end;
    }
    if cursor < chars.len() {
        out.push_str("[비공개]");
    }
    if out.trim().is_empty() {
        return Err(bad());
    }
    Ok(out)
}
#[derive(Deserialize)]
struct Selection {
    source_kind: String,
    source_id: i64,
    source_sha256: String,
    ranges: Vec<Span>,
    notice: String,
}
impl Selection {
    fn validate(&self) -> AppResult<()> {
        if !matches!(self.source_kind.as_str(), "chat" | "ai")
            || self.source_id <= 0
            || self.source_sha256.len() != 64
            || self.notice.trim().is_empty()
            || self.notice.chars().count() > 1000
            || self.notice.contains('\0')
        {
            return Err(bad());
        }
        Ok(())
    }
    fn hash(&self) -> String {
        digest(
            serde_json::to_vec(&json!([
                self.source_kind,
                self.source_id,
                self.source_sha256,
                self.ranges,
                self.notice
            ]))
            .expect("selection JSON")
            .as_slice(),
        )
    }
}
#[derive(Deserialize)]
struct Issue {
    revision: i32,
    confirmed: bool,
    preview_sha256: String,
    #[serde(flatten)]
    selection: Selection,
}
#[derive(Serialize, FromRow)]
struct Delivery {
    id: i64,
    request_id: i64,
    source_kind: String,
    source_id: i64,
    source_sha256: String,
    output_sha256: String,
    ranges: Value,
    notice: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}
#[derive(FromRow)]
struct Source {
    body: String,
    created_at: DateTime<Utc>,
}
async fn begin(state: &AppState) -> AppResult<Transaction<'_, Postgres>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
async fn request(tx: &mut Transaction<'_, Postgres>, id: i64) -> AppResult<RequestRow> {
    let row: RequestRow = sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
    if row.kind != "access"
        || !matches!(row.status.as_str(), "in_review" | "needs_information")
        || row.due_at.is_none()
    {
        return Err(conflict());
    }
    active(tx, row.user_id).await?;
    Ok(row)
}
async fn source(
    tx: &mut Transaction<'_, Postgres>,
    uid: i64,
    kind: &str,
    id: i64,
) -> AppResult<Source> {
    // Ownership comes from stored account, never current device/SIM ownership.
    let query=match kind {
  "chat"=>"SELECT m.body,m.created_at FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.user_id=$1 AND m.id=$2 AND length(m.body)<=20000 FOR SHARE OF m,t",
  "ai"=>"SELECT analysis AS body,created_at FROM gps_read_ai_analyses WHERE user_id=$1 AND id=$2 AND length(analysis)<=20000 FOR SHARE",
  _=>return Err(bad())};
    sqlx::query_as(query)
        .bind(uid)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(conflict)
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    rid: i64,
    pid: Option<i64>,
    actor: i64,
    action: &str,
    s: &Selection,
) -> AppResult<()> {
    sqlx::query("INSERT INTO privacy_redacted_events(request_id,delivery_id,actor_id,action,source_kind,source_id,source_sha256,selection_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(rid).bind(pid).bind(actor).bind(action).bind(&s.source_kind).bind(s.source_id).bind(&s.source_sha256).bind(s.hash()).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Deserialize)]
struct Page {
    kind: String,
    before: Option<i64>,
}
async fn options(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
    Query(q): Query<Page>,
) -> AppResult<Json<Value>> {
    let mut tx = begin(&state).await?;
    let r = request(&mut tx, id).await?;
    let query=match q.kind.as_str(){
  "chat"=>"SELECT jsonb_build_object('id',m.id,'created_at',m.created_at,'role',m.sender_role,'characters',length(m.body),'supported',length(m.body)<=20000) FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.user_id=$1 AND ($2::bigint IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT 51",
  "ai"=>"SELECT jsonb_build_object('id',id,'created_at',created_at,'characters',length(analysis),'supported',length(analysis)<=20000) FROM gps_read_ai_analyses WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 51",
  _=>return Err(bad())};
    let mut items: Vec<Value> = sqlx::query_scalar(query)
        .bind(r.user_id)
        .bind(q.before)
        .fetch_all(&mut *tx)
        .await?;
    let more = items.len() > 50;
    items.truncate(50);
    let next = if more {
        items.last().and_then(|i| i.get("id")).cloned()
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next":next})))
}
async fn review(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((id, kind, sid)): Path<(i64, String, i64)>,
) -> AppResult<Json<Value>> {
    let mut tx = begin(&state).await?;
    let r = request(&mut tx, id).await?;
    let src = source(&mut tx, r.user_id, &kind, sid).await?;
    let sha = digest(src.body.as_bytes());
    let s = Selection {
        source_kind: kind.clone(),
        source_id: sid,
        source_sha256: sha.clone(),
        ranges: vec![],
        notice: String::new(),
    };
    event(&mut tx, id, None, admin.user_id, "source_review", &s).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"source_kind":kind,"source_id":sid,"body":src.body,"source_sha256":sha,"created_at":src.created_at}),
    ))
}
async fn prepared(
    tx: &mut Transaction<'_, Postgres>,
    r: &RequestRow,
    admin: i64,
    s: &Selection,
) -> AppResult<String> {
    s.validate()?;
    let src = source(tx, r.user_id, &s.source_kind, s.source_id).await?;
    if digest(src.body.as_bytes()) != s.source_sha256 {
        return Err(conflict());
    }
    let viewed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_redacted_events WHERE request_id=$1 AND actor_id=$2 AND action='source_review' AND source_kind=$3 AND source_id=$4 AND source_sha256=$5 AND created_at>now()-interval '1 hour')").bind(r.id).bind(admin).bind(&s.source_kind).bind(s.source_id).bind(&s.source_sha256).fetch_one(&mut **tx).await?;
    if !viewed {
        return Err(conflict());
    }
    redact(&src.body, &s.ranges)
}
async fn preview(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(s): Json<Selection>,
) -> AppResult<Json<Value>> {
    let mut tx = begin(&state).await?;
    let r = request(&mut tx, id).await?;
    let text = prepared(&mut tx, &r, admin.user_id, &s).await?;
    event(&mut tx, id, None, admin.user_id, "preview", &s).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"text":text,"notice":s.notice,"preview_sha256":s.hash()}),
    ))
}
async fn issue(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(b): Json<Issue>,
) -> AppResult<Json<Value>> {
    if !b.confirmed {
        return Err(bad());
    }
    let mut tx = begin(&state).await?;
    let r = request(&mut tx, id).await?;
    if r.revision != b.revision {
        return Err(conflict());
    }
    let s = &b.selection;
    let text = prepared(&mut tx, &r, admin.user_id, s).await?;
    let previewed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_redacted_events WHERE request_id=$1 AND actor_id=$2 AND action='preview' AND selection_sha256=$3 AND created_at>now()-interval '1 hour')").bind(id).bind(admin.user_id).bind(s.hash()).fetch_one(&mut *tx).await?;
    if !previewed || b.preview_sha256 != s.hash() {
        return Err(conflict());
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM privacy_redacted_deliveries WHERE request_id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 50 {
        return Err(AppError::Conflict(
            "발급 한도를 초과했습니다. 담당자에게 분할 처리를 요청해 주세요.".into(),
        ));
    }
    let prior:Vec<Delivery>=sqlx::query_as("UPDATE privacy_redacted_deliveries SET revoked_at=now() WHERE request_id=$1 AND source_kind=$2 AND source_id=$3 AND revoked_at IS NULL RETURNING *").bind(id).bind(&s.source_kind).bind(s.source_id).fetch_all(&mut *tx).await?;
    for old in prior {
        event(
            &mut tx,
            id,
            Some(old.id),
            admin.user_id,
            "revoked",
            &selection(&old)?,
        )
        .await?;
    }
    let pid:i64=sqlx::query_scalar("INSERT INTO privacy_redacted_deliveries(request_id,created_by,source_kind,source_id,source_sha256,output_sha256,ranges,notice) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id").bind(id).bind(admin.user_id).bind(&s.source_kind).bind(s.source_id).bind(&s.source_sha256).bind(digest(text.as_bytes())).bind(json!(s.ranges)).bind(&s.notice).fetch_one(&mut *tx).await?;
    event(&mut tx, id, Some(pid), admin.user_id, "issued", s).await?;
    let msg="검토한 본문 일부를 제공했습니다. 제외 범위와 사유를 확인하고 24시간 이내 내려받으세요. 요청 전체의 제공 완료는 아닙니다.";
    sqlx::query("UPDATE privacy_requests SET revision=revision+1,assigned_to=$2,result_message=$3,updated_at=now() WHERE id=$1").bind(id).bind(admin.user_id).bind(msg).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,due_at) SELECT id,$2,revision,status,$3,due_at FROM privacy_requests WHERE id=$1").bind(id).bind(admin.user_id).bind(msg).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":pid})))
}
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    // Never expose hidden source hashes, offsets, administrator IDs or raw bodies.
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'source_kind',p.source_kind,'notice',p.notice,'created_at',p.created_at,'expires_at',p.expires_at,'revoked_at',p.revoked_at) FROM privacy_redacted_deliveries p JOIN privacy_requests r ON r.id=p.request_id WHERE r.id=$1 AND r.user_id=$2 ORDER BY p.id DESC LIMIT 50").bind(id).bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(json!({"items":items})))
}
async fn admin_list(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let items: Vec<Delivery> = sqlx::query_as(
        "SELECT * FROM privacy_redacted_deliveries WHERE request_id=$1 ORDER BY id DESC LIMIT 50",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM privacy_redacted_events e WHERE request_id=$1 ORDER BY id DESC LIMIT 100").bind(id).fetch_all(&state.db).await?;
    Ok(Json(json!({"items":items,"events":events})))
}
fn selection(d: &Delivery) -> AppResult<Selection> {
    Ok(Selection {
        source_kind: d.source_kind.clone(),
        source_id: d.source_id,
        source_sha256: d.source_sha256.clone(),
        ranges: serde_json::from_value(d.ranges.clone()).map_err(|_| conflict())?,
        notice: d.notice.clone(),
    })
}
async fn revoke(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = begin(&state).await?;
    let rid: i64 =
        sqlx::query_scalar("SELECT request_id FROM privacy_redacted_deliveries WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    sqlx::query("SELECT id FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(rid)
        .execute(&mut *tx)
        .await?;
    let d:Option<Delivery>=sqlx::query_as("UPDATE privacy_redacted_deliveries SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING *").bind(id).fetch_optional(&mut *tx).await?;
    if let Some(d) = d {
        event(
            &mut tx,
            rid,
            Some(id),
            admin.user_id,
            "revoked",
            &selection(&d)?,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Download {
    password: String,
}
async fn download(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<Download>,
) -> AppResult<Response> {
    rate_limit(&state, &format!("user:{}", user.user_id), &headers).await?;
    if b.password.len() > 1024 {
        return Err(AppError::Unauthorized);
    }
    let mut tx = begin(&state).await?;
    let rid:i64=sqlx::query_scalar("SELECT p.request_id FROM privacy_redacted_deliveries p JOIN privacy_requests r ON r.id=p.request_id WHERE p.id=$1 AND r.user_id=$2").bind(id).bind(user.user_id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    let status: String =
        sqlx::query_scalar("SELECT status FROM privacy_requests WHERE id=$1 FOR SHARE")
            .bind(rid)
            .fetch_one(&mut *tx)
            .await?;
    active(&mut tx, user.user_id).await?;
    let d: Delivery =
        sqlx::query_as("SELECT * FROM privacy_redacted_deliveries WHERE id=$1 FOR SHARE")
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
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1 FOR SHARE")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if !tokio::task::spawn_blocking(move || password::verify(&b.password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
    {
        return Err(AppError::Unauthorized);
    }
    let src = source(&mut tx, user.user_id, &d.source_kind, d.source_id).await?;
    if digest(src.body.as_bytes()) != d.source_sha256 {
        return Err(conflict());
    }
    let s = selection(&d)?;
    let text = redact(&src.body, &s.ranges)?;
    if digest(text.as_bytes()) != d.output_sha256 {
        return Err(conflict());
    }
    let bytes=serde_json::to_vec_pretty(&json!({"format":"gps-reviewed-text-v1","request_id":rid,"delivery_id":id,"source_kind":d.source_kind,"source_created_at":src.created_at,"text":text,"scope_notice":d.notice,"notice":"담당자가 검토한 일부 본문입니다. [비공개]는 제외 구간입니다. 원본 정정·익명화·요청 전체 처리 완료를 뜻하지 않습니다."})).map_err(|e|AppError::Internal(e.into()))?;
    event(
        &mut tx,
        rid,
        Some(id),
        user.user_id,
        "download_prepared",
        &s,
    )
    .await?;
    tx.commit().await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"reviewed-text-{id}.json\""),
            ),
        ],
        bytes,
    )
        .into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_gaps() {
        assert_eq!(
            redact(
                "가😀비밀끝",
                &[Span { start: 0, end: 2 }, Span { start: 4, end: 5 }]
            )
            .unwrap(),
            "가😀[비공개]끝"
        );
        assert_eq!(
            redact("가😀비밀끝", &[Span { start: 2, end: 4 }]).unwrap(),
            "[비공개]비밀[비공개]"
        );
    }
    #[test]
    fn rejects_empty_overlap_unsorted_and_bounds() {
        for spans in [
            vec![],
            vec![Span { start: 1, end: 1 }],
            vec![Span { start: 0, end: 4 }],
            vec![Span { start: 1, end: 3 }, Span { start: 0, end: 1 }],
        ] {
            assert!(redact("abc", &spans).is_err());
        }
    }
    #[test]
    fn preview_binds_notice_and_ranges() {
        let mut s = Selection {
            source_kind: "chat".into(),
            source_id: 1,
            source_sha256: "a".repeat(64),
            ranges: vec![Span { start: 0, end: 1 }],
            notice: "일부 제공".into(),
        };
        let a = s.hash();
        s.notice = "전체".into();
        assert_ne!(a, s.hash());
        let b = s.hash();
        s.ranges[0].end = 2;
        assert_ne!(b, s.hash());
    }
}
