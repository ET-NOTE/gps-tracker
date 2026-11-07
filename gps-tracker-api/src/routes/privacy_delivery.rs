//! Result-only credentials never issue login tokens. Exports require an active
//! own-account session AND password, and remain bounded to the receipt owner.
use crate::{
    auth::{password, AdminUser, AuthUser},
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use std::sync::OnceLock;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/privacy/result", post(result))
        .route("/privacy/requests/:id/deliveries", get(list))
        .route("/privacy/deliveries/:id/download", post(download))
        .route("/admin/privacy/requests/:id/delivery-options", get(options))
        .route(
            "/admin/privacy/requests/:id/deliveries",
            get(admin_list).post(issue),
        )
        .route("/admin/privacy/deliveries/:id/revoke", post(revoke))
        .layer(middleware::from_fn(no_store))
}
pub(super) async fn no_store(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store, private".parse().unwrap());
    response
        .headers_mut()
        .insert(header::PRAGMA, "no-cache".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}

#[derive(Serialize, FromRow)]
struct Delivery {
    id: i64,
    request_id: i64,
    device_ids: Vec<i64>,
    from_at: DateTime<Utc>,
    until_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
struct ResultLogin {
    email: String,
    password: String,
    request_id: i64,
}

// Count successes as well as failures; atomic UPSERT prevents concurrent bypass.
pub(super) async fn rate_limit(
    state: &AppState,
    email: &str,
    headers: &HeaderMap,
) -> AppResult<()> {
    let ip = headers
        .get("x-real-ip")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("unknown");
    let mut tx = state.db.begin().await?;
    let mut blocked = false;
    for (prefix, value, limit) in [("email", email, 10), ("ip", ip, 30)] {
        let key = format!("{prefix}:{:x}", Sha256::digest(value.as_bytes()));
        let n:i32=sqlx::query_scalar("INSERT INTO privacy_result_limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN privacy_result_limits.window_at<now()-interval '15 minutes' THEN 1 ELSE LEAST(privacy_result_limits.attempts+1,1000) END,window_at=CASE WHEN privacy_result_limits.window_at<now()-interval '15 minutes' THEN now() ELSE privacy_result_limits.window_at END RETURNING attempts")
            .bind(key).fetch_one(&mut *tx).await?;
        blocked |= n > limit;
    }
    sqlx::query("DELETE FROM privacy_result_limits WHERE window_at<now()-interval '1 day'")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if blocked {
        return Err(AppError::TooManyRequests(
            "15분 후 다시 확인해 주세요.".into(),
        ));
    }
    Ok(())
}
async fn result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ResultLogin>,
) -> AppResult<Json<Value>> {
    let email = body.email.trim().to_lowercase();
    if email.len() > 254 || body.password.len() > 1024 || body.request_id <= 0 {
        return Err(AppError::Unauthorized);
    }
    rate_limit(&state, &email, &headers).await?;
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id,password_hash FROM users WHERE lower(email)=$1")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    static DUMMY: OnceLock<String> = OnceLock::new();
    let dummy = DUMMY.get_or_init(|| {
        password::hash("result-lookup-dummy-not-an-account").expect("argon2 static password")
    });
    let hash = row
        .as_ref()
        .map(|r| r.1.clone())
        .unwrap_or_else(|| dummy.clone());
    let ok = tokio::task::spawn_blocking(move || password::verify(&body.password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    if !ok || row.is_none() {
        return Err(AppError::Unauthorized);
    }
    // Explicit public projection: no internal evidence, actor IDs, job metadata,
    // tokens, location records, company data or ordinary session restoration.
    let response:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'kind',kind,'status',status,'scope',scope,'result_message',result_message,'created_at',created_at,'updated_at',updated_at,'due_at',due_at,'account_restricted',EXISTS(SELECT 1 FROM privacy_account_controls c WHERE c.user_id=r.user_id AND c.restricted),'company_reviews',privacy_company_public(r.id,r.user_id),'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('status',e.status,'message',e.message,'created_at',e.created_at) ORDER BY e.revision) FROM privacy_request_events e WHERE e.request_id=r.id),'[]'::jsonb)) FROM privacy_requests r WHERE id=$1 AND user_id=$2")
        .bind(body.request_id).bind(row.unwrap().0).fetch_optional(&state.db).await?;
    Ok(Json(response.ok_or(AppError::Unauthorized)?))
}
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<Delivery>>> {
    let rows=sqlx::query_as("SELECT d.* FROM privacy_deliveries d JOIN privacy_requests r ON r.id=d.request_id WHERE r.id=$1 AND r.user_id=$2 ORDER BY d.id DESC LIMIT 20")
        .bind(id).bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}
async fn admin_list(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let rows: Vec<Delivery> = sqlx::query_as(
        "SELECT * FROM privacy_deliveries WHERE request_id=$1 ORDER BY id DESC LIMIT 20",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM privacy_delivery_events e JOIN privacy_deliveries d ON d.id=e.delivery_id WHERE d.request_id=$1 ORDER BY e.id DESC LIMIT 100").bind(id).fetch_all(&state.db).await?;
    Ok(Json(json!({"items":rows,"events":events})))
}
async fn options(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',d.id,'name',d.display_name) FROM gps_read_devices d WHERE EXISTS(SELECT 1 FROM gps_read_location_records l JOIN privacy_requests r ON r.user_id=l.user_id WHERE r.id=$1 AND l.device_id=d.id) AND NOT EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.device_id=d.id) AND NOT EXISTS(SELECT 1 FROM device_data_controls c WHERE c.device_id=d.id AND c.blocked) ORDER BY d.id LIMIT 101")
        .bind(id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows.iter().take(100).collect::<Vec<_>>(),"more":rows.len()>100}),
    ))
}
#[derive(Deserialize)]
struct Issue {
    revision: i32,
    device_ids: Vec<i64>,
    from_at: DateTime<Utc>,
    until_at: DateTime<Utc>,
    confirmed: bool,
}
fn validate_scope(body: &Issue) -> AppResult<()> {
    if !body.confirmed
        || body.device_ids.is_empty()
        || body.device_ids.len() > 20
        || body.device_ids.iter().any(|id| *id <= 0)
        || body.until_at <= body.from_at
        || body.until_at - body.from_at > Duration::days(31)
        || body.until_at > Utc::now()
    {
        return Err(AppError::BadRequest("과거 날짜에서 최대 31일의 조회 구간과 장치 1~20개를 선택하고 본인 자료 범위를 확인해 주세요.".into()));
    }
    Ok(())
}
pub(super) async fn active(tx: &mut Transaction<'_, Postgres>, uid: i64) -> AppResult<()> {
    let allowed: Option<bool> = sqlx::query_scalar(
        "SELECT NOT restricted FROM privacy_account_controls WHERE user_id=$1 FOR SHARE",
    )
    .bind(uid)
    .fetch_optional(&mut **tx)
    .await?;
    if allowed != Some(true) {
        return Err(AppError::Forbidden);
    }
    Ok(())
}
async fn issue(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(mut body): Json<Issue>,
) -> AppResult<Json<Delivery>> {
    validate_scope(&body)?;
    body.device_ids.sort_unstable();
    body.device_ids.dedup();
    let mut tx = state.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let row: crate::services::privacy::RequestRow =
        sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    if row.revision != body.revision
        || row.kind != "access"
        || !matches!(row.status.as_str(), "in_review" | "needs_information")
        || row.due_at.is_none()
    {
        return Err(AppError::Conflict(
            "담당자 검토와 기한 지정 후 최신 요청에서 발급해 주세요.".into(),
        ));
    }
    active(&mut tx, row.user_id).await?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM gps_read_devices d WHERE d.id=ANY($1) AND EXISTS(SELECT 1 FROM location_sample_keys_between(d.id,$2,$3,$4) p WHERE p.recorded_at < $4) AND NOT EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.device_id=d.id) AND NOT EXISTS(SELECT 1 FROM device_data_controls c WHERE c.device_id=d.id AND c.blocked)")
        .bind(&body.device_ids).bind(row.user_id).bind(body.from_at).bind(body.until_at).fetch_one(&mut *tx).await?;
    if count != body.device_ids.len() as i64 {
        return Err(AppError::Conflict(
            "선택 장치의 해당 기간 개인 기록이 없거나 회사·삭제 검토 범위입니다.".into(),
        ));
    }
    sqlx::query("WITH changed AS (UPDATE privacy_deliveries SET revoked_at=now() WHERE request_id=$1 AND revoked_at IS NULL RETURNING id) INSERT INTO privacy_delivery_events(delivery_id,actor_id,action) SELECT id,$2,'revoked' FROM changed").bind(id).bind(admin.user_id).execute(&mut *tx).await?;
    let delivery:Delivery=sqlx::query_as("INSERT INTO privacy_deliveries(request_id,created_by,device_ids,from_at,until_at) VALUES($1,$2,$3,$4,$5) RETURNING *")
        .bind(id).bind(admin.user_id).bind(&body.device_ids).bind(body.from_at).bind(body.until_at).fetch_one(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO privacy_delivery_events(delivery_id,actor_id,action) VALUES($1,$2,'issued')",
    )
    .bind(delivery.id)
    .bind(admin.user_id)
    .execute(&mut *tx)
    .await?;
    let message="검토한 범위의 개인 위치 기록을 준비했습니다. 요청 내역에서 24시간 이내 내려받을 수 있습니다. 회사 자료와 별도 검토 범위는 포함하지 않습니다.";
    sqlx::query("UPDATE privacy_requests SET revision=revision+1,assigned_to=$2,result_message=$3,updated_at=now() WHERE id=$1").bind(id).bind(admin.user_id).bind(message).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,due_at) SELECT id,$2,revision,status,$3,due_at FROM privacy_requests WHERE id=$1").bind(id).bind(admin.user_id).bind(message).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(delivery))
}
async fn revoke(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let row:Option<i64>=sqlx::query_scalar("UPDATE privacy_deliveries SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id").bind(id).fetch_optional(&mut *tx).await?;
    if row.is_some() {
        sqlx::query("INSERT INTO privacy_delivery_events(delivery_id,actor_id,action) VALUES($1,$2,'revoked')").bind(id).bind(admin.user_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Download {
    password: String,
}
#[derive(FromRow)]
struct Record {
    device_id: i64,
    recorded_at: DateTime<Utc>,
    fix: bool,
    lat: Option<f64>,
    lng: Option<f64>,
}
async fn download(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<Download>,
) -> AppResult<Response> {
    if body.password.len() > 1024 {
        return Err(AppError::Unauthorized);
    }
    rate_limit(&state, &format!("user:{}", user.user_id), &headers).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let request_id:Option<i64>=sqlx::query_scalar("SELECT d.request_id FROM privacy_deliveries d JOIN privacy_requests r ON r.id=d.request_id WHERE d.id=$1 AND r.user_id=$2").bind(id).bind(user.user_id).fetch_optional(&mut *tx).await?;
    let request_id = request_id.ok_or(AppError::NotFound)?;
    // Same lock order as review/cancel/closure. Revocation serializes on delivery.
    let status: String =
        sqlx::query_scalar("SELECT status FROM privacy_requests WHERE id=$1 FOR SHARE")
            .bind(request_id)
            .fetch_one(&mut *tx)
            .await?;
    active(&mut tx, user.user_id).await?;
    let grant: Delivery = sqlx::query_as("SELECT * FROM privacy_deliveries WHERE id=$1 FOR SHARE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if grant.revoked_at.is_some()
        || grant.expires_at <= Utc::now()
        || matches!(status.as_str(), "cancelled" | "rejected")
    {
        return Err(AppError::Gone(
            "자료 제공 기간이 끝났거나 회수됐습니다. 재발급을 요청해 주세요.".into(),
        ));
    }
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1 FOR SHARE")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if !tokio::task::spawn_blocking(move || password::verify(&body.password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
    {
        return Err(AppError::Unauthorized);
    }
    // Refuse changed scope rather than silently reporting a partial archive.
    // Lock erasure gates; pause alone does not suppress existing records.
    sqlx::query("SELECT device_id FROM device_data_controls WHERE device_id=ANY($1) ORDER BY device_id FOR SHARE").bind(&grant.device_ids).fetch_all(&mut *tx).await?;
    let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM device_data_controls WHERE device_id=ANY($1) AND blocked) OR EXISTS(SELECT 1 FROM fleet_vehicle_bindings WHERE device_id=ANY($1))").bind(&grant.device_ids).fetch_one(&mut *tx).await?;
    if blocked {
        return Err(AppError::Conflict(
            "자료 범위가 변경되었습니다. 담당자의 재검토가 필요합니다.".into(),
        ));
    }
    // Reuse the canonical SIM/receiving-owner projection, including every batch
    // sample and batches whose anchor lies outside the requested period.
    let rows:Vec<Record>=sqlx::query_as("SELECT p.device_id,p.recorded_at,p.fix,CASE WHEN p.fix THEN p.lat END AS lat,CASE WHEN p.fix THEN p.lng END AS lng FROM unnest($2::bigint[]) d(id) CROSS JOIN LATERAL location_points_between(d.id,$1,$3,$4) p WHERE p.recorded_at < $4 ORDER BY p.recorded_at,p.device_id,p.source LIMIT 10001")
        .bind(user.user_id).bind(&grant.device_ids).bind(grant.from_at).bind(grant.until_at).fetch_all(&mut *tx).await?;
    if rows.len() > 10000 {
        return Err(AppError::Conflict(
            "1만 건을 초과했습니다. 담당자에게 더 짧은 기간으로 나누어 발급을 요청해 주세요."
                .into(),
        ));
    }
    let mut csv = String::from("\u{feff}논리 장치 번호,기록 시각(UTC),위치 확정,위도,경도\r\n");
    for row in &rows {
        csv.push_str(&format!(
            "{},{},{},{},{}\r\n",
            row.device_id,
            row.recorded_at.to_rfc3339(),
            if row.fix { "예" } else { "아니오" },
            row.lat.map(|n| n.to_string()).unwrap_or_default(),
            row.lng.map(|n| n.to_string()).unwrap_or_default()
        ));
    }
    sqlx::query("INSERT INTO privacy_delivery_events(delivery_id,actor_id,action,record_count,sha256) VALUES($1,$2,'download_prepared',$3,$4)").bind(id).bind(user.user_id).bind(rows.len() as i32).bind(format!("{:x}",Sha256::digest(csv.as_bytes()))).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"personal-locations-{request_id}-{id}.csv\""),
            ),
        ],
        csv,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_window_is_bounded_and_review_required() {
        let mut body = Issue {
            revision: 1,
            device_ids: vec![1],
            from_at: Utc::now() - Duration::days(2),
            until_at: Utc::now() - Duration::days(1),
            confirmed: true,
        };
        assert!(validate_scope(&body).is_ok());
        body.confirmed = false;
        assert!(validate_scope(&body).is_err());
        body.confirmed = true;
        body.from_at = body.until_at - Duration::days(32);
        assert!(validate_scope(&body).is_err());
        body.from_at = body.until_at;
        assert!(validate_scope(&body).is_err());
    }
}
