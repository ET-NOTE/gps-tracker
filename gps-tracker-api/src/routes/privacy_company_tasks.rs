//! Company-owner submissions are evidence for operator review, never an execution engine.
use super::privacy_delivery::{active, no_store};
use crate::{
    auth::{AdminUser, AuthUser},
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/privacy/company-tasks", get(inbox))
        .route("/privacy/company-tasks/:id", get(owner_detail).post(submit))
        .route("/privacy/company-tasks/:id/proof/:sid", post(owner_file))
        .route(
            "/admin/privacy/company-reviews/:id/tasks",
            get(admin_list).post(publish),
        )
        .route("/admin/privacy/company-tasks/:id/decision", post(decide))
        .route("/admin/privacy/company-tasks/:id/revoke", post(revoke))
        .route(
            "/admin/privacy/company-tasks/:id/proof/:sid",
            post(admin_file),
        )
        .layer(DefaultBodyLimit::max(3 * 1024 * 1024))
        .layer(axum::middleware::from_fn(no_store))
}
fn conflict() -> AppError {
    AppError::Conflict(
        "범위·상태가 바뀌었거나 기한이 끝났습니다. 새로고침 후 확인해 주세요.".into(),
    )
}
fn text_ok(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max
}
#[derive(FromRow)]
struct Context {
    request_id: i64,
    request_revision: i32,
    request_status: String,
    kind: String,
    review_id: i64,
    review_revision: i32,
    identity: String,
    review_status: String,
    company_owner_id: i64,
    staff_id: Option<i64>,
}
async fn context(tx: &mut Transaction<'_, Postgres>, review: i64) -> AppResult<Context> {
    let rid: i64 = sqlx::query_scalar("SELECT request_id FROM privacy_company_reviews WHERE id=$1")
        .bind(review)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
    sqlx::query("SELECT id FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(rid)
        .execute(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM privacy_company_reviews WHERE id=$1 FOR UPDATE")
        .bind(review)
        .execute(&mut **tx)
        .await?;
    Ok(sqlx::query_as("SELECT r.id request_id,r.revision request_revision,r.status request_status,r.kind,c.id review_id,c.revision review_revision,c.identity,c.status review_status,c.company_owner_id,c.staff_id FROM privacy_company_reviews c JOIN privacy_requests r ON r.id=c.request_id WHERE c.id=$1").bind(review).fetch_one(&mut **tx).await?)
}
#[derive(FromRow)]
struct Task {
    review_id: i64,
    company_owner_id: i64,
    status: String,
    revision: i32,
    expires_at: DateTime<Utc>,
}
async fn lock(tx: &mut Transaction<'_, Postgres>, id: i64) -> AppResult<(Context, Task)> {
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut **tx)
        .await?;
    let review: i64 = sqlx::query_scalar("SELECT review_id FROM privacy_company_tasks WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
    let c = context(tx, review).await?;
    let t=sqlx::query_as("SELECT id,review_id,company_owner_id,status,revision,expires_at FROM privacy_company_tasks WHERE id=$1 FOR UPDATE").bind(id).fetch_one(&mut **tx).await?;
    Ok((c, t))
}
fn available(c: &Context, t: &Task) -> AppResult<()> {
    if !crate::services::privacy::open(&c.request_status)
        || c.identity != "confirmed"
        || t.status == "revoked"
        || t.expires_at <= Utc::now()
    {
        return Err(conflict());
    }
    Ok(())
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    id: i64,
    actor: i64,
    action: &str,
    sid: Option<i64>,
    detail: &str,
) -> AppResult<()> {
    sqlx::query("INSERT INTO privacy_company_task_events(task_id,actor_id,action,submission_id,detail) VALUES($1,$2,$3,$4,$5)").bind(id).bind(actor).bind(action).bind(sid).bind(detail).execute(&mut **tx).await?;
    Ok(())
}
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    c: &Context,
    actor: i64,
    message: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE privacy_requests SET revision=revision+1,updated_at=now() WHERE id=$1")
        .bind(c.request_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,due_at) SELECT id,$2,revision,status,$3,due_at FROM privacy_requests WHERE id=$1").bind(c.request_id).bind(actor).bind(message).execute(&mut **tx).await?;
    Ok(())
}
fn expected(kind: &str) -> &str {
    match kind {
        "access" => "provided",
        "rectification" => "corrected",
        _ => "erased",
    }
}
#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    after: i64,
}
// Strict projection: no requester identity, internal reasons, inventory or scope text.
const VIEW:&str="SELECT jsonb_build_object('id',t.id,'revision',t.revision,'status',t.status,'instructions',t.instructions,'feedback',t.feedback,'created_at',t.created_at,'expires_at',t.expires_at,'staff_id',c.staff_id,'category',c.category,'from_at',c.from_at,'until_at',c.until_at,'kind',r.kind) FROM privacy_company_tasks t JOIN privacy_company_reviews c ON c.id=t.review_id JOIN privacy_requests r ON r.id=c.request_id";
async fn inbox(
    State(s): State<AppState>,
    u: AuthUser,
    Query(p): Query<Page>,
) -> AppResult<Json<Value>> {
    let query=format!("{VIEW} WHERE t.company_owner_id=$1 AND t.id>$2 AND t.status<>'revoked' AND t.expires_at>now() AND c.identity='confirmed' AND r.status IN ('received','in_review','needs_information') ORDER BY t.id LIMIT 51");
    let mut rows: Vec<Value> = sqlx::query_scalar(&query)
        .bind(u.user_id)
        .bind(p.after)
        .fetch_all(&s.db)
        .await?;
    let more = rows.len() > 50;
    rows.truncate(50);
    let next = if more {
        rows.last().and_then(|v| v["id"].as_i64())
    } else {
        None
    };
    Ok(Json(json!({"items":rows,"next":next})))
}
async fn submissions(tx: &mut Transaction<'_, Postgres>, id: i64) -> AppResult<Vec<Value>> {
    // Never SELECT to_jsonb(row) on a table containing BYTEA.
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('id',id,'outcome',outcome,'executed_at',executed_at,'affected_count',affected_count,'summary',summary,'evidence_reference',evidence_reference,'filename',filename,'mime',mime,'sha256',sha256,'size',octet_length(file_bytes),'created_at',created_at) FROM gps_read_privacy_company_submissions WHERE task_id=$1 ORDER BY id DESC").bind(id).fetch_all(&mut **tx).await?)
}
async fn owner_detail(
    State(s): State<AppState>,
    u: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = s.db.begin().await?;
    let (c, t) = lock(&mut tx, id).await?;
    if t.company_owner_id != u.user_id {
        return Err(AppError::NotFound);
    }
    available(&c, &t)?;
    active(&mut tx, u.user_id).await?;
    let item: Value = sqlx::query_scalar(&format!("{VIEW} WHERE t.id=$1"))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let proofs = submissions(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(json!({"task":item,"submissions":proofs})))
}
async fn admin_list(
    State(s): State<AppState>,
    _: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = s.db.begin().await?;
    let tasks: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(t) FROM privacy_company_tasks t WHERE review_id=$1 ORDER BY id DESC",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let mut items = Vec::new();
    for t in tasks {
        let tid = t["id"].as_i64().ok_or(AppError::NotFound)?;
        let proofs = submissions(&mut tx, tid).await?;
        items.push(json!({"task":t,"submissions":proofs}));
    }
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM privacy_company_task_events e JOIN privacy_company_tasks t ON t.id=e.task_id WHERE t.review_id=$1 ORDER BY e.id DESC LIMIT 100").bind(id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"items":items,"events":events})))
}
#[derive(Deserialize)]
struct Publish {
    request_revision: i32,
    review_revision: i32,
    instructions: String,
    expires_at: DateTime<Utc>,
    confirmed: bool,
}
async fn publish(
    State(s): State<AppState>,
    a: AdminUser,
    Path(id): Path<i64>,
    Json(b): Json<Publish>,
) -> AppResult<Json<Value>> {
    let now = Utc::now();
    if !b.confirmed
        || !text_ok(&b.instructions, 1000)
        || b.expires_at <= now
        || b.expires_at > now + Duration::days(14)
    {
        return Err(AppError::BadRequest(
            "회사에 공개할 범위·안내와 최대 14일의 제출 기한을 확인해 주세요.".into(),
        ));
    }
    let mut tx = s.db.begin().await?;
    let c = context(&mut tx, id).await?;
    if !crate::services::privacy::open(&c.request_status)
        || c.request_revision != b.request_revision
        || c.review_revision != b.review_revision
        || c.identity != "confirmed"
        || c.staff_id.is_none()
        || matches!(
            c.review_status.as_str(),
            "verified" | "excluded" | "restricted"
        )
    {
        return Err(conflict());
    }
    active(&mut tx, c.company_owner_id).await?;
    let (n,busy):(i64,bool)=sqlx::query_as("SELECT count(*),COALESCE(bool_or(status<>'revoked'),false) FROM privacy_company_tasks WHERE review_id=$1").bind(id).fetch_one(&mut *tx).await?;
    if busy || n >= 3 {
        return Err(AppError::Conflict(
            "기존 제출 요청을 확인해 주세요. 범위당 발행은 3회까지 가능합니다.".into(),
        ));
    }
    let tid:i64=sqlx::query_scalar("INSERT INTO privacy_company_tasks(review_id,company_owner_id,instructions,expires_at,updated_by) VALUES($1,$2,$3,$4,$5) RETURNING id").bind(id).bind(c.company_owner_id).bind(b.instructions.trim()).bind(b.expires_at).bind(a.user_id).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE privacy_company_reviews SET status='awaiting_company',outcome='',evidence_reference='',updated_by=$2,revision=revision+1,updated_at=now() WHERE id=$1").bind(id).bind(a.user_id).execute(&mut *tx).await?;
    event(&mut tx, tid, a.user_id, "published", None, "").await?;
    record(
        &mut tx,
        &c,
        a.user_id,
        "확인된 범위의 회사 처리 결과를 요청했습니다.",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":tid})))
}
#[derive(Deserialize)]
struct Submit {
    revision: i32,
    outcome: String,
    executed_at: DateTime<Utc>,
    affected_count: i32,
    summary: String,
    evidence_reference: String,
    filename: String,
    mime: String,
    file_base64: String,
    confirmed: bool,
}
fn proof(b: &Submit) -> AppResult<Vec<u8>> {
    let bytes = STANDARD
        .decode(&b.file_base64)
        .map_err(|_| AppError::BadRequest("첨부파일을 다시 선택해 주세요.".into()))?;
    let signature = match b.mime.as_str() {
        "application/pdf" => bytes.starts_with(b"%PDF-"),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[255, 216, 255]),
        _ => false,
    };
    if !signature
        || bytes.is_empty()
        || bytes.len() > 2 * 1024 * 1024
        || !text_ok(&b.filename, 120)
        || b.filename
            .chars()
            .any(|c| c.is_control() || "/\\".contains(c))
    {
        return Err(AppError::BadRequest(
            "PDF·PNG·JPG 파일 하나를 2MB 이하로 첨부해 주세요.".into(),
        ));
    }
    Ok(bytes)
}
async fn submit(
    State(s): State<AppState>,
    u: AuthUser,
    Path(id): Path<i64>,
    Json(b): Json<Submit>,
) -> AppResult<Json<Value>> {
    if !b.confirmed
        || !text_ok(&b.summary, 2000)
        || !text_ok(&b.evidence_reference, 160)
        || !(0..=10000000).contains(&b.affected_count)
        || b.executed_at > Utc::now()
        || b.executed_at < Utc::now() - Duration::days(366)
    {
        return Err(AppError::BadRequest(
            "최근 1년 이내 처리 시각·건수·방법·근거와 확인 여부를 입력해 주세요.".into(),
        ));
    }
    let bytes = proof(&b)?;
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let mut tx = s.db.begin().await?;
    let (c, t) = lock(&mut tx, id).await?;
    if t.company_owner_id != u.user_id {
        return Err(AppError::NotFound);
    }
    available(&c, &t)?;
    active(&mut tx, u.user_id).await?;
    if t.revision != b.revision || !matches!(t.status.as_str(), "requested" | "changes_requested") {
        return Err(conflict());
    }
    if b.outcome != expected(&c.kind) && b.outcome != "limited" {
        return Err(AppError::BadRequest(
            "요청 종류에 맞는 처리 결과를 선택해 주세요.".into(),
        ));
    }
    // Serialize all submissions by this owner, including different tasks, for quota enforcement.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(u.user_id)
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM gps_read_privacy_company_submissions WHERE task_id=$1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let used:i64=sqlx::query_scalar("SELECT COALESCE(sum(octet_length(p.file_bytes)),0)::bigint FROM gps_read_privacy_company_submissions p JOIN privacy_company_tasks t ON t.id=p.task_id WHERE t.company_owner_id=$1").bind(u.user_id).fetch_one(&mut *tx).await?;
    if count >= 5 || used + bytes.len() as i64 > 64 * 1024 * 1024 {
        return Err(AppError::Conflict(
            "제출 한도에 도달했습니다. 담당자에게 문의해 주세요.".into(),
        ));
    }
    let sid:i64=sqlx::query_scalar("INSERT INTO privacy_company_submissions(task_id,actor_id,outcome,executed_at,affected_count,summary,evidence_reference,filename,mime,sha256,file_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id").bind(id).bind(u.user_id).bind(b.outcome).bind(b.executed_at).bind(b.affected_count).bind(b.summary.trim()).bind(b.evidence_reference.trim()).bind(b.filename).bind(b.mime).bind(&sha).bind(bytes).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE privacy_company_tasks SET status='submitted',revision=revision+1,updated_by=$2,updated_at=now(),feedback='' WHERE id=$1").bind(id).bind(u.user_id).execute(&mut *tx).await?;
    event(&mut tx, id, u.user_id, "submitted", Some(sid), "").await?;
    record(
        &mut tx,
        &c,
        u.user_id,
        "회사 처리 보고서가 제출되어 담당자가 검토 중입니다.",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":sid,"sha256":sha})))
}
async fn file(s: AppState, actor: i64, admin: bool, id: i64, sid: i64) -> AppResult<Response> {
    let mut tx = s.db.begin().await?;
    let (c, t) = lock(&mut tx, id).await?;
    if !admin {
        if t.company_owner_id != actor {
            return Err(AppError::NotFound);
        }
        available(&c, &t)?;
        active(&mut tx, actor).await?;
    }
    let downloads:i64=sqlx::query_scalar("SELECT count(*) FROM privacy_company_task_events WHERE task_id=$1 AND actor_id=$2 AND action='downloaded' AND created_at>now()-interval '15 minutes'").bind(id).bind(actor).fetch_one(&mut *tx).await?;
    if downloads >= 30 {
        return Err(AppError::TooManyRequests(
            "증빙 다운로드는 15분에 30회까지 가능합니다.".into(),
        ));
    }
    let (bytes, sha): (Vec<u8>, String) = sqlx::query_as(
        "SELECT file_bytes,sha256 FROM gps_read_privacy_company_submissions WHERE task_id=$1 AND id=$2",
    )
    .bind(id)
    .bind(sid)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if format!("{:x}", Sha256::digest(&bytes)) != sha {
        return Err(conflict());
    }
    event(&mut tx, id, actor, "downloaded", Some(sid), &sha).await?;
    tx.commit().await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=company-proof.bin",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
async fn owner_file(
    State(s): State<AppState>,
    u: AuthUser,
    Path((id, sid)): Path<(i64, i64)>,
) -> AppResult<Response> {
    file(s, u.user_id, false, id, sid).await
}
async fn admin_file(
    State(s): State<AppState>,
    a: AdminUser,
    Path((id, sid)): Path<(i64, i64)>,
) -> AppResult<Response> {
    file(s, a.user_id, true, id, sid).await
}
#[derive(Deserialize)]
struct Decision {
    request_revision: i32,
    review_revision: i32,
    revision: i32,
    submission_id: i64,
    sha256: String,
    accept: bool,
    confirmed: bool,
    feedback: String,
    public_message: String,
}
async fn decide(
    State(s): State<AppState>,
    a: AdminUser,
    Path(id): Path<i64>,
    Json(b): Json<Decision>,
) -> AppResult<Json<Value>> {
    if !text_ok(&b.feedback, 1000) || !text_ok(&b.public_message, 1000) || !b.confirmed {
        return Err(AppError::BadRequest(
            "증빙의 실제 내용과 처리 결과를 확인하고 회사·요청자에게 전달할 안내를 입력해 주세요."
                .into(),
        ));
    }
    let mut tx = s.db.begin().await?;
    let (c, t) = lock(&mut tx, id).await?;
    available(&c, &t)?;
    active(&mut tx, t.company_owner_id).await?;
    if t.status != "submitted"
        || t.revision != b.revision
        || c.review_revision != b.review_revision
        || c.request_revision != b.request_revision
    {
        return Err(conflict());
    }
    let(sid,sha,outcome):(i64,String,String)=sqlx::query_as("SELECT id,sha256,outcome FROM gps_read_privacy_company_submissions WHERE task_id=$1 ORDER BY id DESC LIMIT 1").bind(id).fetch_one(&mut *tx).await?;
    let downloaded:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_company_task_events WHERE task_id=$1 AND actor_id=$2 AND action='downloaded' AND submission_id=$3 AND detail=$4)").bind(id).bind(a.user_id).bind(sid).bind(&sha).fetch_one(&mut *tx).await?;
    if sid != b.submission_id || sha != b.sha256 || !downloaded {
        return Err(AppError::Conflict(
            "최신 제출 증빙을 내려받아 내용과 결과를 확인해 주세요.".into(),
        ));
    }
    let state = if b.accept {
        "accepted"
    } else {
        "changes_requested"
    };
    sqlx::query("UPDATE privacy_company_tasks SET status=$2,feedback=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE id=$1").bind(id).bind(state).bind(b.feedback.trim()).bind(a.user_id).execute(&mut *tx).await?;
    if b.accept {
        if outcome != expected(&c.kind) && outcome != "limited" {
            return Err(conflict());
        }
        let status = if outcome == "limited" {
            "restricted"
        } else {
            "verified"
        };
        sqlx::query("UPDATE privacy_company_reviews SET status=$2,outcome=$3,evidence_reference=$4,internal_reason=$5,public_message=$6,revision=revision+1,updated_by=$7,updated_at=now() WHERE id=$1").bind(t.review_id).bind(status).bind(outcome).bind(format!("company-task:{id}/submission:{sid}")).bind(b.feedback.trim()).bind(b.public_message.trim()).bind(a.user_id).execute(&mut *tx).await?;
    }
    event(&mut tx, id, a.user_id, state, Some(sid), b.feedback.trim()).await?;
    record(&mut tx, &c, a.user_id, b.public_message.trim()).await?;
    tx.commit().await?;
    Ok(Json(json!({"status":state})))
}
#[derive(Deserialize)]
struct Revoke {
    request_revision: i32,
    revision: i32,
    reason: String,
}
async fn revoke(
    State(s): State<AppState>,
    a: AdminUser,
    Path(id): Path<i64>,
    Json(b): Json<Revoke>,
) -> AppResult<Json<Value>> {
    if !text_ok(&b.reason, 1000) {
        return Err(AppError::BadRequest("회수 사유를 입력해 주세요.".into()));
    }
    let mut tx = s.db.begin().await?;
    let (c, t) = lock(&mut tx, id).await?;
    if !crate::services::privacy::open(&c.request_status)
        || c.request_revision != b.request_revision
        || t.revision != b.revision
        || t.status == "revoked"
    {
        return Err(conflict());
    }
    sqlx::query("UPDATE privacy_company_tasks SET status='revoked',feedback=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1").bind(id).bind(b.reason.trim()).bind(a.user_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE privacy_company_reviews SET status='awaiting_company',outcome='',evidence_reference='',revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1").bind(c.review_id).bind(a.user_id).execute(&mut *tx).await?;
    event(&mut tx, id, a.user_id, "revoked", None, b.reason.trim()).await?;
    record(
        &mut tx,
        &c,
        a.user_id,
        "회사 제출 요청을 회수했습니다. 처리 범위를 재검토합니다.",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"status":"revoked"})))
}
