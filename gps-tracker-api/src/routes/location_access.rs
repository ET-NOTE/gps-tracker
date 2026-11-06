//! The handling ledger (위치정보 이용·제공사실 확인자료) as the person responsible for location
//! information reads it. Reading it is itself written to the administrator audit log.
use crate::{
    auth::AdminUser,
    error::{AppError, AppResult},
    services::access_ledger,
    state::AppState,
};
use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new().route("/admin/location-access", get(list))
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
         g.recipient_kind,g.recipient_user_id,g.recipient_name,g.path,g.method,g.range_from,g.range_until \
         FROM location_access_log g WHERE g.last_at>=$1 AND g.first_at<$2 AND ($3::bigint IS NULL OR g.subject_user_id=$3 OR g.all_subjects) \
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
    })))
}
