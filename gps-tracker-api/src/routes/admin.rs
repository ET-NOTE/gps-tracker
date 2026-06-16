// /api/v1/admin/* — 관리자 전용 엔드포인트.
// users.role = 'admin' 만 접근 가능 (AdminUser extractor 가 403 처리).
//
// 기능:
//   - 사용자 목록 + 디바이스 카운트
//   - 특정 사용자의 디바이스/SIM 조회 (god 권한)
//   - 특정 사용자로 임시 임퍼소네이션 (액세스 토큰 발급)
//   - SIM 충전 stub (1NCE 충전 로직은 추후 연동)

use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::{
    auth::{jwt, AdminUser},
    error::{AppError, AppResult},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/users",                          get(list_users))
        .route("/admin/users/:id",                      get(user_detail))
        .route("/admin/users/:id/devices",              get(user_devices))
        .route("/admin/users/:id/impersonate",          post(impersonate_user))
        .route("/admin/devices",                        get(list_all_devices))
        .route("/admin/devices/:id",                    get(device_detail))
        .route("/admin/devices/:id/recompute-stats",    post(recompute_stats))
        .route("/admin/sims/:iccid/topup",              post(topup_sim))
        .route("/admin/payments",                       get(list_payments))
}

// ─── 결제 내역 (모든 사용자) ─────────────────────────────
#[derive(Debug, Deserialize)]
struct PaymentsQuery {
    user_id: Option<i64>,
    status:  Option<String>,            // pending/done/failed/cancelled
    q:       Option<String>,            // 이메일/이름 부분일치
    limit:   Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
struct AdminPaymentRow {
    id:           i64,
    order_id:     String,
    user_id:      i64,
    user_email:   Option<String>,
    user_display: Option<String>,
    amount:       i64,
    status:       String,
    method:       Option<String>,
    receipt_url:  Option<String>,
    fail_reason:  Option<String>,
    created_at:   DateTime<Utc>,
    confirmed_at: Option<DateTime<Utc>>,
}

async fn list_payments(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<PaymentsQuery>,
) -> AppResult<Json<Vec<AdminPaymentRow>>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    // Postgres positional 바인딩 — None 일 땐 fallback 으로 모두 매칭.
    let user_filter: i64 = q.user_id.unwrap_or(-1);  // -1 = no-op (BIGSERIAL >= 1)
    let status_filter = q.status.unwrap_or_default();
    let search = q.q.unwrap_or_default();
    let search_pat = format!("%{}%", search.trim().to_lowercase());

    let rows = sqlx::query_as::<_, AdminPaymentRow>(
        r#"
        SELECT p.id, p.order_id, p.user_id,
               u.email AS user_email, u.display_name AS user_display,
               p.amount, p.status, p.method, p.receipt_url, p.fail_reason,
               p.created_at, p.confirmed_at
          FROM payment_orders p
     LEFT JOIN users u ON u.id = p.user_id
         WHERE ($1 = -1 OR p.user_id = $1)
           AND ($2 = ''  OR p.status = $2)
           AND ($3 = '%%' OR LOWER(COALESCE(u.email,'')) LIKE $3
                          OR LOWER(COALESCE(u.display_name,'')) LIKE $3)
         ORDER BY p.created_at DESC
         LIMIT $4
        "#,
    )
    .bind(user_filter)
    .bind(&status_filter)
    .bind(&search_pat)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ─── 사용자 목록 ─────────────────────────────────────────
#[derive(Debug, Serialize, FromRow)]
pub struct AdminUserRow {
    pub id:               i64,
    pub email:            String,
    pub display_name:     Option<String>,
    pub role:             String,
    pub device_count:     i64,
    pub last_seen_at:     Option<DateTime<Utc>>,
    pub created_at:       DateTime<Utc>,
}

async fn list_users(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<AdminUserRow>>> {
    let rows = sqlx::query_as::<_, AdminUserRow>(
        r#"SELECT u.id, u.email, u.display_name, u.role,
                  (SELECT count(*) FROM devices  WHERE owner_id = u.id) AS device_count,
                  (SELECT max(last_seen_at) FROM devices WHERE owner_id = u.id) AS last_seen_at,
                  u.created_at
             FROM users u
            ORDER BY u.created_at DESC"#,
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ─── 사용자 상세 (메타) ──────────────────────────────────
#[derive(Debug, Serialize, FromRow)]
pub struct AdminUserDetail {
    pub id:               i64,
    pub email:            String,
    pub display_name:     Option<String>,
    pub secondary_phone:  Option<String>,
    pub role:             String,
    pub device_count:     i64,
    pub created_at:       DateTime<Utc>,
}

async fn user_detail(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<AdminUserDetail>> {
    let row: AdminUserDetail = sqlx::query_as(
        r#"SELECT u.id, u.email, u.display_name, u.secondary_phone, u.role,
                  (SELECT count(*) FROM devices WHERE owner_id = u.id) AS device_count,
                  u.created_at
             FROM users u
            WHERE u.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

// ─── 사용자의 디바이스 목록 (god 권한) ────────────────────
#[derive(Debug, Serialize, FromRow)]
pub struct AdminDeviceRow {
    pub id:            i64,
    pub device_uid:    String,
    pub display_name:  Option<String>,
    pub iccid:         Option<String>,
    pub imei:          Option<String>,
    pub last_seen_at:  Option<DateTime<Utc>>,
    pub last_lat:      Option<f64>,
    pub last_lng:      Option<f64>,
    pub paired_at:     Option<DateTime<Utc>>,
    pub created_at:    DateTime<Utc>,
}

async fn user_devices(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<AdminDeviceRow>>> {
    let rows = sqlx::query_as::<_, AdminDeviceRow>(
        r#"SELECT id, device_uid, display_name, iccid, imei,
                  last_seen_at, last_lat, last_lng, paired_at, created_at
             FROM devices
            WHERE owner_id = $1
            ORDER BY COALESCE(last_seen_at, created_at) DESC"#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ─── 전체 디바이스 목록 (사용자 무관 — 관리자 전용) ─────
#[derive(Debug, Serialize, FromRow)]
pub struct AdminDeviceListRow {
    pub id:             i64,
    pub device_uid:     String,
    pub display_name:   Option<String>,
    pub iccid:          Option<String>,
    pub imei:           Option<String>,
    pub owner_id:       Option<i64>,
    pub owner_email:    Option<String>,
    pub last_seen_at:   Option<DateTime<Utc>>,
    pub last_lat:       Option<f64>,
    pub last_lng:       Option<f64>,
    pub paired_at:      Option<DateTime<Utc>>,
    pub created_at:     DateTime<Utc>,
}

async fn list_all_devices(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<AdminDeviceListRow>>> {
    let rows = sqlx::query_as::<_, AdminDeviceListRow>(
        r#"SELECT d.id, d.device_uid, d.display_name, d.iccid, d.imei,
                  d.owner_id, u.email AS owner_email,
                  d.last_seen_at, d.last_lat, d.last_lng, d.paired_at, d.created_at
             FROM devices d
        LEFT JOIN users u ON u.id = d.owner_id
            ORDER BY COALESCE(d.last_seen_at, d.created_at) DESC"#,
    )
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ─── 디바이스 상세 (전체 메타 + 최근 이벤트) ─────────────
#[derive(Debug, Serialize, FromRow)]
pub struct AdminDeviceFull {
    pub id:                 i64,
    pub device_uid:         String,
    pub display_name:       Option<String>,
    pub iccid:              Option<String>,
    pub imei:               Option<String>,
    pub imsi:               Option<String>,
    pub hw_version:         Option<String>,
    pub fw_version:         Option<String>,
    pub owner_id:           Option<i64>,
    pub owner_email:        Option<String>,
    pub last_seen_at:       Option<DateTime<Utc>>,
    pub last_lat:           Option<f64>,
    pub last_lng:           Option<f64>,
    pub last_fix_at:        Option<DateTime<Utc>>,
    pub paired_at:          Option<DateTime<Utc>>,
    pub created_at:         DateTime<Utc>,
    pub rtc_brownouts:      i32,
    pub rtc_no_fix_cycles:  i32,
}

async fn device_detail(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let dev: AdminDeviceFull = sqlx::query_as(
        r#"SELECT d.id, d.device_uid, d.display_name, d.iccid, d.imei, d.imsi,
                  d.hw_version, d.fw_version,
                  d.owner_id, u.email AS owner_email,
                  d.last_seen_at, d.last_lat, d.last_lng, d.last_fix_at,
                  d.paired_at, d.created_at,
                  d.rtc_brownouts, d.rtc_no_fix_cycles
             FROM devices d
        LEFT JOIN users u ON u.id = d.owner_id
            WHERE d.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound)?;

    // 최근 이벤트
    let events: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_build_object(
              'id', id, 'kind', kind, 'data', data, 'occurred_at', occurred_at
            ) FROM events
            WHERE device_id = $1
            ORDER BY occurred_at DESC LIMIT 30"#,
    )
    .bind(id)
    .fetch_all(&state.db).await.unwrap_or_default();

    Ok(Json(json!({
        "device": dev,
        "recent_events": events,
    })))
}

// ─── 임퍼소네이션 — 그 사용자 이름으로 access/refresh 발급 ─
//
// JWT 자체에는 impersonator_id claim 추가 안 함 (다른 모든 검증 코드가 typ/sub 만 알면 되도록
// 호환성 유지). 대신 admin_audit_log 에 영구 기록 — 누가 누구로, 언제 임퍼소네이션 했는지.
async fn impersonate_user(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    // 대상 사용자 존재 확인
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
        .bind(id).fetch_optional(&state.db).await?;
    if exists.is_none() { return Err(AppError::NotFound); }

    let access  = jwt::issue_access(id, &state.config.jwt_secret, state.config.jwt_access_ttl_min)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("jwt: {e}")))?;
    let refresh = jwt::issue_refresh(id, &state.config.jwt_secret, state.config.jwt_refresh_ttl_days)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("jwt: {e}")))?;

    // 영구 감사 — 토큰 발급 자체가 실패한 경우 audit 기록 안 됨 (정상).
    let _ = sqlx::query(
        r#"INSERT INTO admin_audit_log (admin_id, target_user, action, data)
           VALUES ($1, $2, 'impersonate', $3)"#,
    )
    .bind(admin.user_id)
    .bind(id)
    .bind(json!({
        "access_ttl_min":  state.config.jwt_access_ttl_min,
        "refresh_ttl_days": state.config.jwt_refresh_ttl_days,
    }))
    .execute(&state.db)
    .await;

    tracing::warn!(admin_id = admin.user_id, target_user = id, "ADMIN IMPERSONATION");
    Ok(Json(json!({
        "access_token":  access,
        "refresh_token": refresh,
        "as_user_id":    id,
    })))
}

// ─── SIM 충전 — 1NCE Self-care API 직접 호출 ────────────
//
// 흐름:
//   1) 1NCE management API 에 refill POST
//   2) 응답 (status + body) 을 raw 로 admin 에 반환 (성공/실패 모두 가시화)
//   3) audit_log 에 시도 + 결과 함께 기록
//
// 엔드포인트가 plan/계약별로 다를 수 있어 ONCE_REFILL_PATH env 로 override 가능.
// body 는 { "mb": <number> } 받음. 미지정 시 500MB 기본.
#[derive(Debug, serde::Deserialize, Default)]
pub struct TopupRequest {
    pub mb: Option<i32>,
}

// 특정 device 의 daily_stats 를 모든 record 날짜에 대해 재계산.
// 레거시 import 후 catch-up 또는 데이터 정합성 깨졌을 때 사용.
async fn recompute_stats(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    use chrono::NaiveDate;

    // device 존재 확인
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM devices WHERE id = $1",
    ).bind(id).fetch_optional(&state.db).await?;
    if exists.is_none() { return Err(AppError::NotFound); }

    let dates: Vec<NaiveDate> = sqlx::query_scalar(
        r#"SELECT DISTINCT (recorded_at AT TIME ZONE 'Asia/Seoul')::date
             FROM location_records
            WHERE device_id = $1 AND fix = TRUE
            ORDER BY 1 DESC"#,
    ).bind(id).fetch_all(&state.db).await?;

    let mut ok = 0u32;
    let mut failed = 0u32;
    for d in &dates {
        match crate::services::stats::aggregate_one(&state.db, id, *d).await {
            Ok(()) => ok += 1,
            Err(e) => {
                failed += 1;
                tracing::warn!(device_id = id, date = %d, "recompute_stats: {e:#}");
            }
        }
    }
    tracing::info!(actor = admin.user_id, device_id = id, ok, failed, "recompute_stats");
    Ok(Json(json!({
        "device_id": id,
        "dates_processed": ok,
        "dates_failed":    failed,
        "total_dates":     dates.len(),
    })))
}

async fn topup_sim(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(iccid): Path<String>,
    body: Option<Json<TopupRequest>>,
) -> AppResult<Json<Value>> {
    let mb = body.and_then(|b| b.0.mb).unwrap_or(500);

    // 1NCE 호출
    let api_result = match crate::services::nce::refill_sim(&iccid, mb).await {
        Ok(v)  => v,
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    };

    // 디바이스 찾기 + audit
    let device_id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM devices WHERE iccid = $1 LIMIT 1"
    ).bind(&iccid).fetch_optional(&state.db).await?;

    if let Some(did) = device_id {
        let _ = sqlx::query(
            r#"INSERT INTO device_audit_log (device_id, event_type, actor, data)
               VALUES ($1, 'sim_topup', $2, $3)"#,
        )
        .bind(did)
        .bind(format!("admin:{}", admin.user_id))
        .bind(json!({
            "iccid": iccid,
            "mb_requested": mb,
            "api_result": api_result.clone(),
        }))
        .execute(&state.db).await;
    }

    Ok(Json(json!({
        "iccid":      iccid,
        "device_id":  device_id,
        "mb_requested": mb,
        "api_result": api_result,
    })))
}
