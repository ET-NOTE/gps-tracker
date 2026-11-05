//! Operator review ledger. Candidate links are not authority to disclose company data.
use crate::{
    auth::{AdminUser, AuthUser},
    error::{AppError, AppResult},
    services::privacy::RequestRow,
    state::AppState,
};
use axum::{
    extract::{Path, State},
    routing::{get, patch},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/privacy/requests/:id/company-reviews", get(personal))
        .route(
            "/admin/privacy/requests/:id/company-candidates",
            get(candidates),
        )
        .route(
            "/admin/privacy/requests/:id/company-reviews",
            get(list).post(create),
        )
        .route("/admin/privacy/company-reviews/:id", patch(update))
        .layer(axum::middleware::from_fn(super::privacy_delivery::no_store))
}

async fn personal(
    State(s): State<AppState>,
    u: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let found: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM privacy_requests WHERE id=$1 AND user_id=$2)",
    )
    .bind(id)
    .bind(u.user_id)
    .fetch_one(&s.db)
    .await?;
    if !found {
        return Err(AppError::NotFound);
    }
    Ok(Json(
        sqlx::query_scalar("SELECT privacy_company_public($1,$2)")
            .bind(id)
            .bind(u.user_id)
            .fetch_one(&s.db)
            .await?,
    ))
}
async fn candidates(
    State(s): State<AppState>,
    _: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let uid: i64 = sqlx::query_scalar("SELECT user_id FROM privacy_requests WHERE id=$1")
        .bind(id)
        .fetch_optional(&s.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('owner_id',h.company_owner_id,'staff_id',h.staff_id,'company_name',ci.company_name,'first_observed',min(h.captured_at),'last_observed',max(h.captured_at),'currently_linked',EXISTS(SELECT 1 FROM fleet_staff_accounts a WHERE a.owner_id=h.company_owner_id AND a.staff_id=h.staff_id AND a.account_id=$1)) FROM privacy_company_link_history h LEFT JOIN corporate_info ci ON ci.user_id=h.company_owner_id WHERE h.subject_id=$1 GROUP BY h.company_owner_id,h.staff_id,ci.company_name ORDER BY h.company_owner_id,h.staff_id LIMIT 51").bind(uid).fetch_all(&s.db).await?;
    Ok(Json(
        json!({"items":rows.iter().take(50).collect::<Vec<_>>(),"more":rows.len()>50,"identity_confirmed":false}),
    ))
}
async fn list(
    State(s): State<AppState>,
    _: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM privacy_company_reviews c WHERE request_id=$1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM privacy_company_review_events e JOIN privacy_company_reviews c ON c.id=e.review_id WHERE c.request_id=$1 ORDER BY e.id DESC LIMIT 100").bind(id).fetch_all(&s.db).await?;
    Ok(Json(json!({"items":rows,"events":events})))
}
async fn request(
    tx: &mut Transaction<'_, Postgres>,
    id: i64,
    revision: i32,
) -> AppResult<RequestRow> {
    let r: RequestRow = sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
    if r.revision != revision || !crate::services::privacy::open(&r.status) {
        return Err(AppError::Conflict(
            "요청 상태가 바뀌었습니다. 새로고침 후 확인해 주세요.".into(),
        ));
    }
    Ok(r)
}
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    rid: i64,
    actor: i64,
    message: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE privacy_requests SET revision=revision+1,assigned_to=$2,updated_at=now() WHERE id=$1").bind(rid).bind(actor).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,due_at) SELECT id,$2,revision,status,$3,due_at FROM privacy_requests WHERE id=$1").bind(rid).bind(actor).bind(message).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Deserialize)]
struct Create {
    revision: i32,
    company_owner_id: i64,
    staff_id: Option<i64>,
    category: String,
    from_at: DateTime<Utc>,
    until_at: DateTime<Utc>,
    due_at: DateTime<Utc>,
}
async fn create(
    State(s): State<AppState>,
    a: AdminUser,
    Path(id): Path<i64>,
    Json(b): Json<Create>,
) -> AppResult<Json<Value>> {
    if !matches!(
        b.category.as_str(),
        "staff" | "trips" | "reservations" | "expenses" | "files" | "snapshots"
    ) || b.until_at <= b.from_at
        || b.until_at - b.from_at > Duration::days(366)
    {
        return Err(AppError::BadRequest(
            "자료 종류와 최대 366일의 기간을 확인해 주세요.".into(),
        ));
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let r = request(&mut tx, id, b.revision).await?;
    if b.company_owner_id == r.user_id || b.due_at < r.created_at {
        return Err(AppError::BadRequest(
            "별도 회사와 접수 이후 검토 기한을 지정해 주세요.".into(),
        ));
    }
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u WHERE u.id=$1 AND ($2::bigint IS NULL OR EXISTS(SELECT 1 FROM staff WHERE id=$2 AND user_id=$1) OR EXISTS(SELECT 1 FROM privacy_company_link_history WHERE company_owner_id=$1 AND staff_id=$2 AND subject_id=$3)))").bind(b.company_owner_id).bind(b.staff_id).bind(r.user_id).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(AppError::BadRequest(
            "회사와 명단 번호의 소속을 확인해 주세요.".into(),
        ));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM privacy_company_reviews WHERE request_id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 50 {
        return Err(AppError::Conflict(
            "요청당 검토 항목은 50개까지입니다. 범위를 나누어 검토해 주세요.".into(),
        ));
    }
    let duplicate:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_company_reviews WHERE request_id=$1 AND company_owner_id=$2 AND staff_id IS NOT DISTINCT FROM $3 AND category=$4 AND from_at=$5 AND until_at=$6)").bind(id).bind(b.company_owner_id).bind(b.staff_id).bind(&b.category).bind(b.from_at).bind(b.until_at).fetch_one(&mut *tx).await?;
    if duplicate {
        return Err(AppError::Conflict(
            "같은 범위의 검토 항목이 있습니다.".into(),
        ));
    }
    // Counts are provisional, capped, internal only; no names/coordinates/files copied.
    let mut inventory =
        json!({"captured_at":Utc::now(),"identity_confirmed":false,"counts_are_candidates":true});
    for (key,query) in [
 ("trips","SELECT count(*) FROM (SELECT 1 FROM trip_annotations WHERE user_id=$1 AND driver_staff_id=$2 AND trip_started_at>=$3 AND trip_started_at<$4 LIMIT 10001) t"),
 ("reservations","SELECT count(*) FROM (SELECT 1 FROM vehicle_reservations WHERE user_id=$1 AND driver_staff_id=$2 AND ends_at>$3 AND starts_at<$4 LIMIT 10001) t"),
 ("expenses","SELECT count(*) FROM (SELECT 1 FROM fleet_expenses WHERE owner_id=$1 AND staff_id=$2 AND spent_on>=($3::timestamptz AT TIME ZONE 'Asia/Seoul')::date AND spent_on<($4::timestamptz AT TIME ZONE 'Asia/Seoul')::date LIMIT 10001) t")]{
  let n:i64=sqlx::query_scalar(query).bind(b.company_owner_id).bind(b.staff_id).bind(b.from_at).bind(b.until_at).fetch_one(&mut *tx).await?;
  inventory[key]=json!({"count":n.min(10000),"more":n>10000});
 }
    let item:Value=sqlx::query_scalar("INSERT INTO privacy_company_reviews(request_id,company_owner_id,staff_id,category,from_at,until_at,due_at,inventory,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING to_jsonb(privacy_company_reviews)").bind(id).bind(b.company_owner_id).bind(b.staff_id).bind(b.category).bind(b.from_at).bind(b.until_at).bind(b.due_at).bind(inventory).bind(a.user_id).fetch_one(&mut *tx).await?;
    record(
        &mut tx,
        id,
        a.user_id,
        "회사 자료 검토 항목을 추가했습니다. 본인 범위와 처리 방법을 확인 중입니다.",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(item))
}
#[derive(Deserialize)]
struct Update {
    request_revision: i32,
    revision: i32,
    status: String,
    identity: String,
    identity_evidence: String,
    outcome: String,
    evidence_reference: String,
    internal_reason: String,
    public_message: String,
    due_at: DateTime<Utc>,
    confirmed: bool,
}
fn validate(b: &Update, kind: &str) -> AppResult<()> {
    let terminal = matches!(b.status.as_str(), "verified" | "excluded" | "restricted");
    let valid_status = matches!(
        b.status.as_str(),
        "identity_pending"
            | "in_review"
            | "awaiting_company"
            | "awaiting_policy"
            | "verified"
            | "excluded"
            | "restricted"
    );
    let expected = match kind {
        "access" => "provided",
        "rectification" => "corrected",
        _ => "erased",
    };
    if !valid_status
        || !matches!(b.identity.as_str(), "pending" | "confirmed" | "not_subject")
        || b.public_message.trim().is_empty()
        || b.public_message.chars().count() > 1000
        || b.internal_reason.trim().is_empty()
        || b.internal_reason.chars().count() > 1000
        || b.identity_evidence.chars().count() > 160
        || b.evidence_reference.chars().count() > 160
        || (b.identity != "pending" && b.identity_evidence.trim().is_empty())
        || (terminal && (!b.confirmed || b.evidence_reference.trim().is_empty()))
        || (b.status == "verified" && (b.identity != "confirmed" || b.outcome != expected))
        || (b.status == "excluded" && (b.identity != "not_subject" || b.outcome != "not_subject"))
        || (b.status == "restricted" && (b.identity != "confirmed" || b.outcome != "limited"))
        || (matches!(
            b.status.as_str(),
            "in_review" | "awaiting_company" | "awaiting_policy"
        ) && b.identity != "confirmed")
        || (!terminal && !b.outcome.is_empty())
    {
        return Err(AppError::BadRequest(
            "본인 확인, 처리 결과에 맞는 근거·사유·공개 안내와 실제 확인 여부를 입력해 주세요."
                .into(),
        ));
    }
    Ok(())
}
async fn update(
    State(s): State<AppState>,
    a: AdminUser,
    Path(id): Path<i64>,
    Json(b): Json<Update>,
) -> AppResult<Json<Value>> {
    let mut tx = s.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let rid: i64 = sqlx::query_scalar("SELECT request_id FROM privacy_company_reviews WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    let r = request(&mut tx, rid, b.request_revision).await?;
    validate(&b, &r.kind)?;
    if b.due_at < r.created_at {
        return Err(AppError::BadRequest(
            "검토 기한은 접수 이후여야 합니다.".into(),
        ));
    }
    let rev: i32 =
        sqlx::query_scalar("SELECT revision FROM privacy_company_reviews WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if rev != b.revision {
        return Err(AppError::Conflict(
            "검토 내용이 바뀌었습니다. 새로고침해 주세요.".into(),
        ));
    }
    let row:Value=sqlx::query_scalar("UPDATE privacy_company_reviews SET status=$2,identity=$3,identity_evidence=$4,outcome=$5,evidence_reference=$6,internal_reason=$7,public_message=$8,due_at=$9,updated_by=$10,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING to_jsonb(privacy_company_reviews)").bind(id).bind(b.status).bind(b.identity).bind(b.identity_evidence.trim()).bind(b.outcome).bind(b.evidence_reference.trim()).bind(b.internal_reason.trim()).bind(b.public_message.trim()).bind(b.due_at).bind(a.user_id).fetch_one(&mut *tx).await?;
    record(
        &mut tx,
        rid,
        a.user_id,
        &format!("회사 자료 검토 #{id}: {}", b.public_message.trim()),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}
