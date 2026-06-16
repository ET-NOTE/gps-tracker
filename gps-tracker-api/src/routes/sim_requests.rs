// /api/v1/sim-requests/* — 사용자가 자기 디바이스 SIM 데이터 충전을 요청.
//
// 흐름:
//   1) 사용자 POST /sim-requests { device_id, data_mb }
//      → 가격 = data_mb / 100 * COST_PER_100MB (default 100원)
//      → credits 차감 (부족하면 400)
//      → sim_topup_requests row 생성 (status='pending')
//      → chat 시스템 메시지 자동 등록 (admin 알림용)
//   2) 관리자 POST /admin/sim-requests/:id/process
//      → 1NCE refill_sim 호출
//      → 성공 → status='done', api_response 저장
//      → 실패 → status='failed', credits 환불, api_response 에 에러
//   3) 관리자 POST /admin/sim-requests/:id/cancel  → 환불 + status='cancelled'

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::{
    auth::{AdminUser, AuthUser},
    error::{AppError, AppResult},
    services::credits,
    state::AppState,
};

pub fn router_user() -> Router<AppState> {
    Router::new()
        .route("/sim-requests",            post(create_request).get(list_my_requests))
        .route("/sim-requests/pricing",    get(pricing))
        .route("/sim-requests/:id/cancel", post(cancel_my_request))
}

pub fn router_admin() -> Router<AppState> {
    Router::new()
        .route("/admin/sim-requests",                       get(list_all_requests))
        .route("/admin/sim-requests/:id/process",           post(process_request))
        .route("/admin/sim-requests/:id/order",             get(admin_order_info))
        .route("/admin/sim-requests/:id/manual-complete",   post(manual_complete))
        .route("/admin/sim-requests/:id/manual-fail",       post(manual_fail))
        .route("/admin/sim-requests/:id/cancel",            post(cancel_request))
}

// ─── 가격 정책 ─────────────────────────────────────────
//   1NCE 의 표준 1회 top-up 단위가 500MB 고정 (~ $15) 라 변량 청구 의미 없음.
//   사용자에겐 "1회 = 500MB = 143,000 포인트" 만 노출.
//   ENV SIM_TOPUP_COST 로 운영 중 조정 가능.
const TOPUP_UNIT_MB: i32 = 500;

fn topup_cost() -> i64 {
    std::env::var("SIM_TOPUP_COST")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(143_000)
}

// 입력 data_mb 무관하게 1회 top-up 가격 고정. UI 도 500MB 만 보내지만 안전 fallback.
fn calc_cost(_data_mb: i32) -> i64 {
    topup_cost()
}

#[derive(Debug, Serialize)]
struct Pricing {
    topup_mb:    i32,        // 1회 충전 데이터량 (1NCE plan 고정)
    topup_cost:  i64,        // 1회 충전 가격 (포인트)
    currency:    &'static str,
    note:        &'static str,
}

async fn pricing(_user: AuthUser) -> AppResult<Json<Pricing>> {
    Ok(Json(Pricing {
        topup_mb:   TOPUP_UNIT_MB,
        topup_cost: topup_cost(),
        currency:   "POINT",
        note:       "1NCE 정책상 1회 충전 단위는 500MB 고정.",
    }))
}

// ─── 사용자가 요청 생성 ─────────────────────────────────
#[derive(Debug, Deserialize)]
struct CreateReq {
    device_id: i64,
    data_mb:   i32,
}

#[derive(Debug, Serialize)]
struct CreateRes {
    request_id:   i64,
    cost_credits: i64,
    balance:      i64,
    status:       String,
}

async fn create_request(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<CreateRes>> {
    if req.data_mb <= 0 || req.data_mb > 10_000 {
        return Err(AppError::BadRequest("data_mb must be 1..=10000".into()));
    }
    // 본인 디바이스인지 + iccid 스냅샷
    let row: Option<(Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT owner_id, iccid FROM devices WHERE id = $1",
    )
    .bind(req.device_id).fetch_optional(&state.db).await?;
    let (owner, iccid) = row.ok_or(AppError::NotFound)?;
    if owner != Some(user.user_id) { return Err(AppError::NotFound); }
    let iccid = iccid.ok_or_else(|| AppError::BadRequest("디바이스에 등록된 SIM(ICCID)이 없습니다.".into()))?;

    let cost = calc_cost(req.data_mb);

    // 1) 요청 row 먼저 생성 (cost 묶기 위해)
    let request_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO sim_topup_requests (user_id, device_id, iccid, data_mb, cost_credits, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           RETURNING id"#,
    )
    .bind(user.user_id).bind(req.device_id)
    .bind(&iccid).bind(req.data_mb).bind(cost)
    .fetch_one(&state.db).await?;

    // 2) 포인트 차감 (부족이면 요청 cancelled 로 마크 후 에러)
    let txn = match credits::charge(
        &state.db, user.user_id, cost,
        "sim_topup", Some(request_id),
        Some(&format!("{}MB to {}", req.data_mb, iccid)),
    ).await {
        Ok(t) => t,
        Err(e) => {
            let _ = sqlx::query(
                "UPDATE sim_topup_requests SET status = 'cancelled', note = $2 WHERE id = $1",
            )
            .bind(request_id).bind(format!("credit charge failed: {e}"))
            .execute(&state.db).await;
            return Err(e);
        }
    };

    // 3) 채팅 시스템 메시지 자동 등록 (admin inbox 에 노출)
    let _ = post_system_message_to_user_thread(
        &state, user.user_id,
        &format!("SIM 데이터 충전 요청 #{request_id}: {}MB ({}원 차감, ICCID {iccid})",
            req.data_mb, cost),
        json!({
            "kind": "sim_topup_request",
            "request_id": request_id,
            "data_mb": req.data_mb,
            "cost": cost,
        }),
    ).await;

    Ok(Json(CreateRes {
        request_id,
        cost_credits: cost,
        balance:      txn.balance,
        status:       "pending".into(),
    }))
}

#[derive(Debug, Serialize, FromRow)]
struct SimRequestRow {
    id:           i64,
    user_id:      i64,
    device_id:    i64,
    iccid:        Option<String>,
    data_mb:      i32,
    cost_credits: i64,
    status:       String,
    api_response: Option<Value>,
    requested_at: DateTime<Utc>,
    processed_at: Option<DateTime<Utc>>,
    note:         Option<String>,
}

async fn list_my_requests(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<SimRequestRow>>> {
    let rows = sqlx::query_as::<_, SimRequestRow>(
        r#"SELECT id, user_id, device_id, iccid, data_mb, cost_credits, status,
                  api_response, requested_at, processed_at, note
             FROM sim_topup_requests
            WHERE user_id = $1
            ORDER BY requested_at DESC
            LIMIT 50"#,
    )
    .bind(user.user_id)
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ─── 관리자: 모든 요청 목록 ─────────────────────────────
// processed_by + cancelled_by_user 로 "유저 취소" vs "관리자 취소/처리" 구분 노출
#[derive(Debug, Serialize, FromRow)]
struct AdminSimRequestRow {
    id:                 i64,
    user_id:            i64,
    user_email:         Option<String>,
    device_id:          i64,
    device_name:        Option<String>,
    iccid:              Option<String>,
    data_mb:            i32,
    cost_credits:       i64,
    status:             String,
    requested_at:       DateTime<Utc>,
    processed_at:       Option<DateTime<Utc>>,
    note:               Option<String>,
    processed_by:       Option<i64>,
    processed_by_email: Option<String>,
    cancelled_by_user:  Option<bool>,    // status='cancelled' 일 때만 의미 있음
}

async fn list_all_requests(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<AdminSimRequestRow>>> {
    let rows = sqlx::query_as::<_, AdminSimRequestRow>(
        r#"SELECT r.id, r.user_id, u.email AS user_email,
                  r.device_id, d.display_name AS device_name,
                  r.iccid, r.data_mb, r.cost_credits, r.status,
                  r.requested_at, r.processed_at, r.note,
                  r.processed_by,
                  pu.email AS processed_by_email,
                  CASE WHEN r.status = 'cancelled' AND r.processed_by = r.user_id
                       THEN TRUE ELSE FALSE END AS cancelled_by_user
             FROM sim_topup_requests r
        LEFT JOIN users   u  ON u.id  = r.user_id
        LEFT JOIN devices d  ON d.id  = r.device_id
        LEFT JOIN users   pu ON pu.id = r.processed_by
            ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
            LIMIT 200"#,
    )
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ─── 관리자: 1NCE 주문/SIM 상세 조회 ─────────────────────
//
// done 상태인 요청의 1NCE 주문번호 + invoice 번호/금액 + 현재 SIM 잔량까지 한 번에.
// Invoice PDF 는 1NCE 가 AWS SigV4 별도 인증 요구 → Bearer 토큰으로 못 가져옴.
// 그래서 invoice_number 만 노출, admin 이 1NCE 포털에서 검색하도록 안내.
//
// 캐시 전략:
//   order_info  — 한 번 발급되면 불변 (order_number, invoice_number, invoice_amount,
//                 order_date) → DB 에 영구 저장, 이후 클릭은 DB 만 read.
//                 ?refresh=1 쿼리로 강제 재조회 가능.
//   sim_info    — 잔량/상태는 변동성. devices.sim_info_cache (30분 워커 갱신) 우선,
//                 ?refresh_sim=1 일 때만 1NCE 라이브 호출.
#[derive(serde::Serialize)]
struct AdminOrderInfo {
    request_id:  i64,
    status:      String,
    order_id:    Option<String>,
    order:       Option<Value>,
    order_cached_at: Option<DateTime<Utc>>,
    sim:         Option<Value>,
    sim_cached_at:   Option<DateTime<Utc>>,
    error:       Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OrderInfoQuery {
    #[serde(default)]
    refresh:     bool,
    #[serde(default)]
    refresh_sim: bool,
}

async fn admin_order_info(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<OrderInfoQuery>,
) -> AppResult<Json<AdminOrderInfo>> {
    let row: Option<(String, Option<String>, Option<i64>, Option<Value>, Option<Value>, Option<DateTime<Utc>>)> = sqlx::query_as(
        r#"SELECT status, iccid, device_id, api_response, order_info, order_fetched_at
             FROM sim_topup_requests
            WHERE id = $1"#,
    )
    .bind(id).fetch_optional(&state.db).await?;
    let (status, iccid, device_id, api_resp, cached_order, cached_at) = row.ok_or(AppError::NotFound)?;

    // order_url 에서 마지막 path segment (= order_id) 추출
    let order_id = api_resp
        .as_ref()
        .and_then(|v| v.get("order_url"))
        .and_then(|v| v.as_str())
        .and_then(crate::services::nce::extract_order_id);

    let mut out = AdminOrderInfo {
        request_id: id,
        status,
        order_id: order_id.clone(),
        order: None,
        order_cached_at: None,
        sim: None,
        sim_cached_at: None,
        error: None,
    };

    // ── order info: 캐시 우선 ─────────────────────────
    if !q.refresh {
        if let Some(v) = cached_order.clone() {
            out.order = Some(v);
            out.order_cached_at = cached_at;
        }
    }
    if out.order.is_none() {
        if let Some(oid) = order_id.as_deref() {
            match crate::services::nce::fetch_order(oid).await {
                Ok(v) => {
                    let _ = sqlx::query(
                        r#"UPDATE sim_topup_requests
                              SET order_info = $2, order_fetched_at = NOW()
                            WHERE id = $1"#,
                    )
                    .bind(id).bind(&v)
                    .execute(&state.db).await;
                    out.order = Some(v);
                    out.order_cached_at = Some(Utc::now());
                }
                Err(e) => out.error = Some(format!("order fetch: {e:#}")),
            }
        }
    }

    // ── sim info: devices.sim_info_cache 우선 (30분 워커), refresh_sim 일 때만 라이브 ──
    if !q.refresh_sim {
        if let Some(did) = device_id {
            let cached: Option<(Option<Value>, Option<DateTime<Utc>>)> = sqlx::query_as(
                "SELECT sim_info_cache, sim_info_fetched_at FROM devices WHERE id = $1",
            )
            .bind(did).fetch_optional(&state.db).await?;
            if let Some((Some(v), at)) = cached {
                out.sim = Some(v);
                out.sim_cached_at = at;
            }
        }
    }
    if out.sim.is_none() {
        if let Some(icc) = iccid.as_deref() {
            match crate::services::nce::fetch_sim_usage(icc, "", "").await {
                Ok(v) => {
                    if let Some(did) = device_id {
                        let _ = sqlx::query(
                            r#"UPDATE devices
                                  SET sim_info_cache = $2,
                                      sim_info_fetched_at = NOW(),
                                      sim_info_error = NULL
                                WHERE id = $1"#,
                        )
                        .bind(did).bind(&v)
                        .execute(&state.db).await;
                    }
                    out.sim = Some(v);
                    out.sim_cached_at = Some(Utc::now());
                }
                Err(e) => {
                    let merge = match out.error.take() {
                        Some(prev) => format!("{prev}; sim fetch: {e:#}"),
                        None       => format!("sim fetch: {e:#}"),
                    };
                    out.error = Some(merge);
                }
            }
        }
    }
    Ok(Json(out))
}

// ─── 관리자: 요청 처리 (1NCE 호출) ──────────────────────
//
// 동시성: 'pending' → 'processing' 으로 conditional UPDATE 로 claim.
// 이렇게 하면 1NCE 호출 도중에 user 가 cancel 시도해도, user cancel 은
// "WHERE status='pending'" 조건에 걸려 0행 → Conflict. 안전.
async fn process_request(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    // 1) claim — pending 인 요청을 processing 으로 atomic 전환
    let claim: Option<(i64, Option<String>, i32, i64)> = sqlx::query_as(
        r#"UPDATE sim_topup_requests
              SET status = 'processing',
                  processed_at = NOW(),
                  processed_by = $2
            WHERE id = $1 AND status = 'pending'
        RETURNING user_id, iccid, data_mb, cost_credits"#,
    )
    .bind(id).bind(admin.user_id)
    .fetch_optional(&state.db).await?;

    let (user_id, iccid, data_mb, cost) = match claim {
        Some(v) => v,
        None    => return claim_failed(&state.db, id).await,
    };
    let req_id = id;
    let iccid = iccid.ok_or_else(|| AppError::BadRequest("iccid missing".into()))?;

    // 2) 1NCE 호출 — 이 사이에 user 가 cancel 을 누르면 status='cancelled' 로 바꾸려 하나
    //    우리가 이미 'processing' 이므로 user 의 conditional UPDATE 는 실패 (Conflict).
    let api_result = match crate::services::nce::refill_sim(&iccid, data_mb).await {
        Ok(v)  => v,
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    };
    let ok = api_result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);

    // 3) 결과 기록
    if ok {
        sqlx::query(
            r#"UPDATE sim_topup_requests
                  SET status = 'done',
                      api_response = $2,
                      processed_at = NOW()
                WHERE id = $1"#,
        )
        .bind(req_id).bind(&api_result)
        .execute(&state.db).await?;

        let _ = post_system_message_to_user_thread(
            &state, user_id,
            &format!("SIM 충전 요청 #{req_id} 처리 완료 ({data_mb}MB)"),
            json!({"kind":"sim_topup_done","request_id":req_id}),
        ).await;
    } else {
        // 실패 → 환불 + 상태 failed
        let _ = credits::refund(
            &state.db, user_id, cost,
            "sim_topup_refund", Some(req_id),
            Some("1NCE 충전 실패 자동 환불"),
        ).await;
        sqlx::query(
            r#"UPDATE sim_topup_requests
                  SET status = 'failed',
                      api_response = $2,
                      processed_at = NOW()
                WHERE id = $1"#,
        )
        .bind(req_id).bind(&api_result)
        .execute(&state.db).await?;

        let _ = post_system_message_to_user_thread(
            &state, user_id,
            &format!("SIM 충전 요청 #{req_id} 실패 — {}원 자동 환불됨", cost),
            json!({"kind":"sim_topup_failed","request_id":req_id}),
        ).await;
    }

    Ok(Json(json!({
        "ok":         ok,
        "request_id": req_id,
        "api_result": api_result,
    })))
}

// claim 실패 시 현재 status 를 보고 NotFound / Conflict 결정.
async fn claim_failed(db: &sqlx::PgPool, id: i64) -> AppResult<Json<Value>> {
    let cur: Option<String> = sqlx::query_scalar(
        "SELECT status FROM sim_topup_requests WHERE id = $1",
    )
    .bind(id).fetch_optional(db).await?;
    match cur {
        Some(s) => Err(AppError::Conflict(format!("이미 {s} 상태입니다"))),
        None    => Err(AppError::NotFound),
    }
}

// ─── 관리자: 콘솔 수동 충전 후 "완료" 마킹 ─────────────
//
// 1NCE 가 우리 서버로 webhook 안 보내므로, admin 이 콘솔에서 직접 충전 후
// 이 endpoint 로 status='done' 마킹. 환불 없음 (충전 자체는 콘솔에서 이루어짐).
async fn manual_complete(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let claim: Option<(i64, i32, i64)> = sqlx::query_as(
        r#"UPDATE sim_topup_requests
              SET status = 'done',
                  processed_at = NOW(),
                  processed_by = $2,
                  api_response = $3,
                  note         = COALESCE(note, '') || ' [console-manual]'
            WHERE id = $1 AND status = 'pending'
        RETURNING user_id, data_mb, cost_credits"#,
    )
    .bind(id).bind(admin.user_id)
    .bind(json!({ "manual": true, "via": "1nce_console" }))
    .fetch_optional(&state.db).await?;

    let (user_id, data_mb, _cost) = match claim {
        Some(v) => v,
        None    => return claim_failed(&state.db, id).await,
    };

    let _ = post_system_message_to_user_thread(
        &state, user_id,
        &format!("SIM 충전 요청 #{id} 처리 완료 ({data_mb}MB)"),
        json!({"kind":"sim_topup_done","request_id":id,"manual":true}),
    ).await;

    Ok(Json(json!({ "ok": true, "request_id": id, "manual": true })))
}

// ─── 관리자: 콘솔 충전 실패 마킹 (환불) ────────────────
async fn manual_fail(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let claim: Option<(i64, i64)> = sqlx::query_as(
        r#"UPDATE sim_topup_requests
              SET status = 'failed',
                  processed_at = NOW(),
                  processed_by = $2,
                  api_response = $3,
                  note         = COALESCE(note, '') || ' [console-manual-fail]'
            WHERE id = $1 AND status = 'pending'
        RETURNING user_id, cost_credits"#,
    )
    .bind(id).bind(admin.user_id)
    .bind(json!({ "manual": true, "via": "1nce_console", "outcome": "failed" }))
    .fetch_optional(&state.db).await?;

    let (user_id, cost) = match claim {
        Some(v) => v,
        None    => return claim_failed(&state.db, id).await,
    };

    let _ = credits::refund(
        &state.db, user_id, cost,
        "sim_topup_refund", Some(id),
        Some("1NCE 콘솔 수동 처리 실패 — 환불"),
    ).await;

    let _ = post_system_message_to_user_thread(
        &state, user_id,
        &format!("SIM 충전 요청 #{id} 실패 — {}원 자동 환불됨", cost),
        json!({"kind":"sim_topup_failed","request_id":id,"manual":true}),
    ).await;

    Ok(Json(json!({ "ok": true, "request_id": id, "manual": true, "refunded": cost })))
}

// ─── 관리자: 요청 취소 (환불) ──────────────────────────
async fn cancel_request(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    cancel_pending_sim_request(&state, id, admin.user_id, None, "관리자 취소").await
}

// ─── 사용자: 본인 요청 취소 (환불) ─────────────────────
async fn cancel_my_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    cancel_pending_sim_request(&state, id, user.user_id, Some(user.user_id), "사용자 취소").await
}

// 공통 취소 로직 — conditional UPDATE 로 race-safe.
//   - status='pending' 인 row 만 'cancelled' 로 전환 (도중에 admin process 가
//     'processing' 으로 잡아두면 여기 0 행 → Conflict)
//   - 환불은 같은 tx 안에서 UPDATE users + INSERT credit_log
//   - tx commit 까지 가야 row 변경 + 환불이 둘 다 영구화. 어느 단계 실패해도
//     status 와 credit_log 는 일관 유지.
//
//   require_owner: Some(uid) 면 user_id 가 일치할 때만 취소 (사용자 본인 cancel)
async fn cancel_pending_sim_request(
    state: &AppState,
    req_id: i64,
    actor_id: i64,
    require_owner: Option<i64>,
    reason: &str,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;

    // owner 검증 + status='pending' 검증을 conditional UPDATE 한 번으로
    let claim: Option<(i64, i64)> = match require_owner {
        Some(owner) => sqlx::query_as(
            r#"UPDATE sim_topup_requests
                  SET status = 'cancelled',
                      processed_at = NOW(),
                      processed_by = $2
                WHERE id = $1
                  AND status = 'pending'
                  AND user_id = $3
            RETURNING user_id, cost_credits"#,
        )
        .bind(req_id).bind(actor_id).bind(owner)
        .fetch_optional(&mut *tx).await?,
        None => sqlx::query_as(
            r#"UPDATE sim_topup_requests
                  SET status = 'cancelled',
                      processed_at = NOW(),
                      processed_by = $2
                WHERE id = $1
                  AND status = 'pending'
            RETURNING user_id, cost_credits"#,
        )
        .bind(req_id).bind(actor_id)
        .fetch_optional(&mut *tx).await?,
    };

    let (user_id, cost) = match claim {
        Some(v) => v,
        None => {
            // 무엇 때문에 실패했는지 — 존재하지 않거나, 이미 처리됐거나, owner 가 아니거나
            tx.rollback().await?;
            // owner 검증을 위해 별도 조회
            let row: Option<(i64, String)> = sqlx::query_as(
                "SELECT user_id, status FROM sim_topup_requests WHERE id = $1",
            )
            .bind(req_id).fetch_optional(&state.db).await?;
            return match (row, require_owner) {
                (None, _) => Err(AppError::NotFound),
                (Some((owner, _)), Some(req_owner)) if owner != req_owner => Err(AppError::NotFound),
                (Some((_, s)), _) => Err(AppError::Conflict(format!(
                    "이미 처리된 요청입니다 (status={s}). 새로고침 해주세요."
                ))),
            };
        }
    };

    // 같은 tx 안에서 환불 — UPDATE users + INSERT credit_log
    let new_balance: i64 = sqlx::query_scalar(
        "UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits",
    )
    .bind(user_id).bind(cost)
    .fetch_one(&mut *tx).await?;

    sqlx::query(
        r#"INSERT INTO credit_log (user_id, delta, balance, reason, ref_id, note)
           VALUES ($1, $2, $3, 'sim_topup_refund', $4, $5)"#,
    )
    .bind(user_id).bind(cost).bind(new_balance)
    .bind(req_id).bind(reason)
    .execute(&mut *tx).await?;

    tx.commit().await?;

    // 누가 취소했는지에 따라 메시지 종류 다르게 — push 라우팅도 그에 맞게.
    //   user 본인 취소 → admin 알림 / admin 이 취소 → user 알림
    let kind = if require_owner.is_some() {
        "sim_topup_user_cancelled"
    } else {
        "sim_topup_admin_cancelled"
    };
    let _ = post_system_message_to_user_thread(
        state, user_id,
        &format!("SIM 충전 요청 #{req_id} 취소 — {}원 환불됨 ({reason})", cost),
        json!({"kind": kind, "request_id": req_id, "by": reason}),
    ).await;

    Ok(Json(json!({
        "ok":         true,
        "request_id": req_id,
        "refunded":   cost,
        "balance":    new_balance,
    })))
}

// ─── 헬퍼: 시스템 메시지를 사용자 스레드에 게시 ─────────
// chat 모듈에 있는 helper 를 부르고 싶지만, circular dep 회피 위해 여기 inlined.
async fn post_system_message_to_user_thread(
    state: &AppState,
    user_id: i64,
    body: &str,
    meta: Value,
) -> AppResult<()> {
    // 스레드 upsert
    let thread_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO chat_threads (user_id, last_message_at, last_message_text, unread_for_admin, unread_for_user)
           VALUES ($1, NOW(), $2, 1, 1)
           ON CONFLICT (user_id) DO UPDATE SET
             last_message_at   = EXCLUDED.last_message_at,
             last_message_text = EXCLUDED.last_message_text,
             unread_for_admin  = chat_threads.unread_for_admin + 1,
             unread_for_user   = chat_threads.unread_for_user  + 1
           RETURNING id"#,
    )
    .bind(user_id).bind(body)
    .fetch_one(&state.db).await?;

    sqlx::query(
        r#"INSERT INTO chat_messages (thread_id, sender_role, sender_id, body, meta)
           VALUES ($1, 'system', NULL, $2, $3)"#,
    )
    .bind(thread_id).bind(body).bind(&meta)
    .execute(&state.db).await?;

    // 푸시 — credits.rs 와 동일 규칙
    let kind = meta.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let to_admins = matches!(kind,
        "sim_topup_request"
        | "sim_topup_user_cancelled"
        | "credit_topup_request"
        | "credit_topup_user_cancelled"
    );
    let pool = state.db.clone();
    let fcm = state.fcm.clone();
    let body_owned = body.to_string();
    let meta_owned = meta;
    tokio::spawn(async move {
        if to_admins {
            crate::services::fcm::push_to_admins(
                fcm.as_deref(), &pool, Some(user_id),
                "새 요청", &body_owned, meta_owned,
            ).await;
        } else {
            crate::services::fcm::push_to_user(
                fcm.as_deref(), &pool, user_id,
                "충전 처리 알림", &body_owned, meta_owned,
            ).await;
        }
    });

    Ok(())
}
