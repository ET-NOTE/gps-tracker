//! The handling ledger (위치정보 이용·제공사실 확인자료) as the person responsible for location
//! information reads it. Reading it is itself written to the administrator audit log.
use crate::{
    auth::AdminUser,
    error::{AppError, AppResult},
    services::access_ledger,
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/location-access", get(list))
        .route(
            "/admin/privacy/requests/:id/access-ledger-erasure",
            post(erase),
        )
}

#[derive(Deserialize)]
struct Erase {
    revision: i32,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
    evidence_reference: String,
    confirmed: bool,
}

/// Separate opt-in gate: implementing this executor does not decide a retention policy.
async fn erase(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(q): Json<Erase>,
) -> AppResult<Json<Value>> {
    if std::env::var("GPS_LOCATION_ACCESS_ERASURE").as_deref() != Ok("on") {
        return Err(AppError::Conflict(
            "조회 기록 파기 정책이 아직 활성화되지 않았습니다.".into(),
        ));
    }
    if !q.confirmed
        || q.from >= q.until
        || q.until > Utc::now()
        || q.evidence_reference.trim().is_empty()
        || q.evidence_reference.len() > 160
    {
        return Err(AppError::BadRequest(
            "대상 기간·처리 근거·확인을 입력해 주세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    let reviewed: Option<(String, String, i32)> =
        sqlx::query_as("SELECT kind,status,revision FROM privacy_requests WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((kind, status, revision)) = reviewed else {
        return Err(AppError::NotFound);
    };
    if !matches!(kind.as_str(), "erasure" | "account_closure")
        || status != "in_review"
        || revision != q.revision
    {
        return Err(AppError::Conflict(
            "검토 중인 파기 요청의 최신 버전이 필요합니다.".into(),
        ));
    }
    let used: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM location_access_erasure_runs WHERE request_id=$1 AND request_revision=$2)")
        .bind(id).bind(revision).fetch_one(&mut *tx).await?;
    if used {
        return Err(AppError::Conflict("이미 처리한 요청 버전입니다.".into()));
    }
    let removed: i64 = sqlx::query_scalar("SELECT privacy_erase_access_events($1,$2,$3,$4,$5,$6)")
        .bind(id)
        .bind(revision)
        .bind(admin.user_id)
        .bind(q.from)
        .bind(q.until)
        .bind(q.evidence_reference.trim())
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"removed":removed,"request_completed":false,"scope":"personal_account_events_only",
        "notice":"해당 계정의 명확한 조회 기록만 처리했습니다. 회사·귀속 미상·과거 집계 기록과 원본 자료는 별도 검토 대상입니다."}),
    ))
}

#[derive(Deserialize)]
struct Asked {
    /// One account's records (and the reads of everyone's). Without it, every record of the period.
    user_id: Option<i64>,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
    limit: Option<i64>,
}

async fn list(
    State(state): State<AppState>,
    admin: AdminUser,
    Query(q): Query<Asked>,
) -> AppResult<Json<Value>> {
    if q.until <= q.from || q.until - q.from > Duration::days(31) {
        return Err(AppError::BadRequest(
            "조회 기간은 31일 이내로 지정해 주세요.".into(),
        ));
    }
    let limit = q.limit.unwrap_or(500).clamp(1, 2000);
    let periods: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('started_at',c.started_at,'last_written_at',c.alive_at,'stopped_at',c.stopped_at,\
         'release',c.release,'scope_version',c.scope_version,'not_kept',c.dropped) \
         FROM location_access_coverage c WHERE c.started_at<$2 AND COALESCE(c.stopped_at,c.alive_at)>=$1 ORDER BY c.id",
    )
    .bind(q.from)
    .bind(q.until)
    .fetch_all(&state.db)
    .await?;
    let mut records: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT g.id,g.first_at,g.last_at,g.hits,g.subject_user_id,g.all_subjects,g.device_id,g.vehicle_id,g.share_id,\
         g.recipient_kind,g.recipient_user_id,g.recipient_name,g.path,g.method,g.range_from,g.range_until,\
         g.attribution,g.outcome,g.route,g.record_type,g.actual_subject_user_id \
         FROM location_access_records g WHERE g.last_at>=$1 AND g.first_at<$2 AND ($3::bigint IS NULL OR g.subject_user_id=$3 OR g.all_subjects) \
         ORDER BY g.bucket,g.id LIMIT $4) x",
    )
    .bind(q.from)
    .bind(q.until)
    .bind(q.user_id)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let more = records.len() as i64 > limit;
    records.truncate(limit as usize);
    sqlx::query("INSERT INTO admin_audit_log(admin_id,target_user,action,data) VALUES($1,$2,'location_access_read',$3)")
        .bind(admin.user_id)
        .bind(q.user_id)
        .bind(json!({"from": q.from, "until": q.until, "returned": records.len()}))
        .execute(&state.db)
        .await?;
    Ok(Json(json!({
        "recording_now": access_ledger::enabled(),
        "scope_version": access_ledger::SCOPE_VERSION,
        "minimum_keep_days": access_ledger::MIN_KEEP_DAYS,
        "recorded_periods": periods,
        "records": records,
        "more": more,
        "notice": "subject_user_id는 호환용 계정 범위입니다. 실제 운전자는 확정하지 않습니다. response_ready는 응답 준비, socket_sent는 소켓 전송, http_accepted는 외부 서버의 성공 응답이며 최종 수신자의 열람을 증명하지 않습니다. prepared·transport_unknown은 전달 여부 미확정입니다.",
    })))
}
