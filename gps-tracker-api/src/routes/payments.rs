// /api/v1/payments/* — Toss Payments 직접 결제 (포인트 충전).
//
// 흐름:
//   1) POST /payments/toss/init { amount }
//      → payment_orders row(pending) 생성, 응답: { order_id, amount, client_key }
//   2) 프론트가 TossPayments SDK 로 requestPayment 호출
//      → Toss 결제 UI → 사용자 결제 완료 → successUrl 로 redirect (paymentKey, orderId, amount 쿼리)
//   3) 프론트 success 페이지가 POST /payments/toss/confirm { paymentKey, orderId, amount } 호출
//      → 백엔드가 Toss API 로 confirm → 성공 시 credits +amount, status='confirmed'
//      → 실패 시 status='failed', 사용자에 사유 응답
//
// race-safe: confirm 은 status='pending' AND amount 일치 조건의 conditional UPDATE 로 1회만 적용.

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;

use base64::Engine;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    services::{credits, toss},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/payments/toss/config",  get(get_config))
        .route("/payments/toss/init",    post(init_payment))
        .route("/payments/toss/confirm", post(confirm_payment))
        .route("/payments/toss/fail",    post(mark_failed))
        .route("/payments/toss/webhook", post(webhook))      // Toss → 우리 (가상계좌 입금 등 비동기)
        .route("/payments/orders",       get(list_my_orders))
        .route("/payments/orders/:id",   get(get_order))
}

// ─── 클라이언트 키 노출 ──────────────────────────────────
// frontend 가 SDK 초기화 시 필요. 클라이언트 키는 공개 가능 (test_ck_/live_ck_).
#[derive(Debug, Serialize)]
struct TossConfig {
    client_key: Option<String>,
    enabled:    bool,
}

async fn get_config(_user: AuthUser) -> AppResult<Json<TossConfig>> {
    let key = toss::client_key();
    Ok(Json(TossConfig {
        enabled:    key.is_some(),
        client_key: key,
    }))
}

// ─── 결제 초기화 ────────────────────────────────────────
#[derive(Debug, Deserialize)]
struct InitReq {
    amount: i64,
}

#[derive(Debug, Serialize)]
struct InitRes {
    order_id:   String,
    amount:     i64,
    order_name: String,
    client_key: String,
}

async fn init_payment(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<InitReq>,
) -> AppResult<Json<InitRes>> {
    if req.amount < 1_000 || req.amount > 1_000_000 {
        return Err(AppError::BadRequest("amount must be 1,000 ~ 1,000,000 KRW".into()));
    }
    let client_key = toss::client_key()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("TOSS_CLIENT_KEY 미설정")))?;

    // 짧은 unique order_id — 충돌 risk 낮은 short uuid prefix
    let order_id = format!("ord_{}", uuid::Uuid::new_v4().simple());
    let order_id = order_id.chars().take(48).collect::<String>();

    sqlx::query(
        r#"INSERT INTO payment_orders (order_id, user_id, amount)
           VALUES ($1, $2, $3)"#,
    )
    .bind(&order_id).bind(user.user_id).bind(req.amount)
    .execute(&state.db).await?;

    let order_name = format!("포인트 {}원 충전", req.amount);
    Ok(Json(InitRes { order_id, amount: req.amount, order_name, client_key }))
}

// ─── 결제 confirm ────────────────────────────────────────
#[derive(Debug, Deserialize)]
struct ConfirmReq {
    #[serde(rename = "paymentKey")]
    payment_key: String,
    #[serde(rename = "orderId")]
    order_id:    String,
    amount:      i64,
}

#[derive(Debug, Serialize)]
struct ConfirmRes {
    ok:      bool,
    balance: i64,
    amount:  i64,
    /// 'confirmed' (즉시 적립 완료) | 'waiting' (가상계좌 입금 대기)
    status:  String,
    /// status='waiting' 일 때만 — 가상계좌 정보 (계좌번호, 은행, 예금주, 만료시각)
    virtual_account: Option<Value>,
}

async fn confirm_payment(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ConfirmReq>,
) -> AppResult<Json<ConfirmRes>> {
    // 1) 우리 DB 의 order 검증
    let row: Option<(i64, i64, String)> = sqlx::query_as(
        r#"SELECT user_id, amount, status FROM payment_orders WHERE order_id = $1"#,
    )
    .bind(&req.order_id).fetch_optional(&state.db).await?;
    let (owner_id, db_amount, status) = row.ok_or(AppError::NotFound)?;
    if owner_id != user.user_id { return Err(AppError::NotFound); }
    if status != "pending" {
        return Err(AppError::Conflict(format!("이미 처리된 주문 (status={status})")));
    }
    if db_amount != req.amount {
        return Err(AppError::BadRequest(format!(
            "금액 불일치: 주문 {db_amount}원 ↔ 요청 {}원", req.amount
        )));
    }

    // 2) Toss API 로 confirm
    let toss_resp = match toss::confirm_payment(&req.payment_key, &req.order_id, req.amount).await {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("{e:#}");
            let _ = sqlx::query(
                r#"UPDATE payment_orders
                      SET status = 'failed', fail_reason = $2
                    WHERE order_id = $1 AND status = 'pending'"#,
            )
            .bind(&req.order_id).bind(&msg).execute(&state.db).await;
            return Err(AppError::BadRequest(format!("결제 승인 실패: {msg}")));
        }
    };

    let payment_key  = toss_resp.get("paymentKey").and_then(|v| v.as_str()).unwrap_or(&req.payment_key).to_string();
    let method       = toss_resp.get("method").and_then(|v| v.as_str()).map(|s| s.to_string());
    let receipt_url  = toss_resp.get("receipt").and_then(|r| r.get("url")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let toss_status  = toss_resp.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // 가상계좌인 경우 toss_status = "WAITING_FOR_DEPOSIT" 으로 옴.
    // 카드/계좌이체는 즉시 "DONE".
    let is_done    = toss_status == "DONE";
    let is_waiting = toss_status == "WAITING_FOR_DEPOSIT";

    if is_waiting {
        // ─ 가상계좌 발급 — 입금 전이라 포인트 적립 안 함, status='waiting' ─
        let va_info = toss_resp.get("virtualAccount").cloned();
        sqlx::query(
            r#"UPDATE payment_orders
                  SET status = 'waiting',
                      payment_key = $2,
                      method = $3,
                      receipt_url = $4,
                      raw_response = $5,
                      virtual_account_info = $6,
                      issued_at = NOW()
                WHERE order_id = $1 AND status = 'pending'"#,
        )
        .bind(&req.order_id).bind(&payment_key).bind(&method).bind(&receipt_url)
        .bind(&toss_resp).bind(&va_info)
        .execute(&state.db).await?;
        let bal = credits::balance(&state.db, user.user_id).await.unwrap_or(0);
        return Ok(Json(ConfirmRes {
            ok: true, balance: bal, amount: req.amount,
            status: "waiting".into(),
            virtual_account: va_info,
        }));
    }

    if !is_done {
        // 알 수 없는 상태 — 안전하게 failed 처리
        let _ = sqlx::query(
            r#"UPDATE payment_orders SET status='failed', fail_reason=$2 WHERE order_id=$1 AND status='pending'"#,
        )
        .bind(&req.order_id).bind(format!("unexpected toss status: {toss_status}"))
        .execute(&state.db).await;
        return Err(AppError::BadRequest(format!("예상치 못한 결제 상태: {toss_status}")));
    }

    // ─ 즉시 결제 (카드/계좌이체) — 포인트 적립 ─
    let bal = credit_payment(
        &state.db, &req.order_id, user.user_id,
        &payment_key, method.as_deref(), receipt_url.as_deref(),
        &toss_resp,
    ).await?;

    Ok(Json(ConfirmRes {
        ok: true, balance: bal, amount: req.amount,
        status: "confirmed".into(),
        virtual_account: None,
    }))
}

/// pending → confirmed atomic claim + 포인트 적립. 멱등.
/// 같은 order 가 confirm/webhook 양쪽에서 호출돼도 한 번만 적립.
async fn credit_payment(
    db: &sqlx::PgPool,
    order_id: &str,
    user_id: i64,
    payment_key: &str,
    method: Option<&str>,
    receipt_url: Option<&str>,
    raw: &Value,
) -> AppResult<i64> {
    let mut tx = db.begin().await?;
    let claimed: Option<i64> = sqlx::query_scalar(
        r#"UPDATE payment_orders
              SET status       = 'confirmed',
                  payment_key  = COALESCE($2, payment_key),
                  method       = COALESCE($3, method),
                  receipt_url  = COALESCE($4, receipt_url),
                  raw_response = $5,
                  confirmed_at = NOW()
            WHERE order_id = $1 AND status IN ('pending','waiting')
        RETURNING amount"#,
    )
    .bind(order_id).bind(payment_key).bind(method).bind(receipt_url).bind(raw)
    .fetch_optional(&mut *tx).await?;

    if claimed.is_none() {
        // 이미 confirmed — 멱등 응답
        tx.rollback().await?;
        return Ok(credits::balance(db, user_id).await.unwrap_or(0));
    }
    let amount = claimed.unwrap();

    let new_balance: i64 = sqlx::query_scalar(
        "UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits",
    )
    .bind(user_id).bind(amount)
    .fetch_one(&mut *tx).await?;

    sqlx::query(
        r#"INSERT INTO credit_log (user_id, delta, balance, reason, ref_id, note)
           VALUES ($1, $2, $3, 'topup', NULL, $4)"#,
    )
    .bind(user_id).bind(amount).bind(new_balance)
    .bind(format!("Toss order {order_id}"))
    .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(new_balance)
}

// ─── fail 콜백 ───────────────────────────────────────────
// Toss 가 failUrl 로 redirect 했을 때 프론트가 호출 — 단순 row 마킹.
#[derive(Debug, Deserialize)]
struct FailReq {
    #[serde(rename = "orderId")]
    order_id: String,
    code:     Option<String>,
    message:  Option<String>,
}

async fn mark_failed(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<FailReq>,
) -> AppResult<Json<Value>> {
    let reason = format!("{} {}",
        req.code.as_deref().unwrap_or(""),
        req.message.as_deref().unwrap_or(""),
    );
    sqlx::query(
        r#"UPDATE payment_orders
              SET status = 'failed', fail_reason = $3
            WHERE order_id = $1 AND user_id = $2 AND status = 'pending'"#,
    )
    .bind(&req.order_id).bind(user.user_id).bind(reason)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

// ─── 사용자 본인 주문 이력 ─────────────────────────────
#[derive(Debug, Serialize, FromRow)]
struct OrderRow {
    id:           i64,
    order_id:     String,
    amount:       i64,
    status:       String,
    method:       Option<String>,
    receipt_url:  Option<String>,
    fail_reason:  Option<String>,
    created_at:   DateTime<Utc>,
    confirmed_at: Option<DateTime<Utc>>,
}

async fn list_my_orders(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<OrderRow>>> {
    let rows = sqlx::query_as::<_, OrderRow>(
        r#"SELECT id, order_id, amount, status, method, receipt_url, fail_reason,
                  created_at, confirmed_at
             FROM payment_orders
            WHERE user_id = $1
            ORDER BY created_at DESC LIMIT 50"#,
    )
    .bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

async fn get_order(
    State(state): State<AppState>,
    user: AuthUser,
    Path(order_id): Path<String>,
) -> AppResult<Json<OrderRow>> {
    let row: Option<OrderRow> = sqlx::query_as(
        r#"SELECT id, order_id, amount, status, method, receipt_url, fail_reason,
                  created_at, confirmed_at
             FROM payment_orders
            WHERE order_id = $1 AND user_id = $2"#,
    )
    .bind(&order_id).bind(user.user_id).fetch_optional(&state.db).await?;
    Ok(Json(row.ok_or(AppError::NotFound)?))
}

// ─── Webhook ────────────────────────────────────────────
//
// Toss → 우리. 비동기 결제 (가상계좌 입금 등) 또는 결제 상태 변경 시 호출.
// 인증 없는 공개 엔드포인트라 반드시 서명 검증으로 발신자 확인.
//
// 검증: HMAC-SHA256(body, TOSS_WEBHOOK_SECRET) 결과의 base64 가
//       request header 의 어떤 필드와 일치해야 함.
// (정확한 헤더명은 Toss 콘솔 webhook 등록 화면 안내 참조 — 'TossPayments-Signature' 또는
//  'X-Toss-Signature' 등. 일단 두 이름 모두 받아 처리.)
//
// 처리 이벤트:
//   - DONE  (status 변경) → 우리 order 적립
//   - CANCELED / EXPIRED → status='failed'/'cancelled'

#[derive(Debug, Deserialize)]
struct WebhookEvent {
    #[serde(rename = "eventType", default)]
    event_type: String,
    #[serde(default)]
    data: Value,
}

async fn webhook(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<Json<Value>> {
    // 1) 서명 검증
    let secret = std::env::var("TOSS_WEBHOOK_SECRET").ok().filter(|s| !s.is_empty());
    let provided = headers.get("toss-signature")
        .or_else(|| headers.get("tosspayments-signature"))
        .or_else(|| headers.get("x-toss-signature"))
        .and_then(|v| v.to_str().ok());

    match (secret.as_deref(), provided) {
        (Some(sec), Some(sig)) => {
            // HMAC-SHA256 — `hmac` crate 의 `verify_slice` 가 constant-time 비교.
            use hmac::{Hmac, Mac};
            use sha2::Sha256;
            type HmacSha256 = Hmac<Sha256>;

            let mut mac = HmacSha256::new_from_slice(sec.as_bytes())
                .map_err(|e| AppError::Internal(anyhow::anyhow!("hmac key: {e}")))?;
            mac.update(&body);
            let expected_bytes = mac.finalize().into_bytes();
            let expected_b64 = base64::engine::general_purpose::STANDARD.encode(expected_bytes);

            // Toss 가 sig 를 `t=,v1=` 같은 envelope 로 감쌀 수 있어 substring 매칭 유지하되,
            // 비교는 base64 디코드 후 constant-time 으로. envelope 안에서 base64 부분만 추출.
            // 가장 일반적 형식: raw base64 또는 `v1=BASE64`. 둘 다 핸들링.
            let candidate = sig
                .split([',', ' '])
                .filter_map(|part| {
                    let p = part.trim();
                    p.strip_prefix("v1=").or_else(|| Some(p))
                })
                .find_map(|cand| base64::engine::general_purpose::STANDARD.decode(cand).ok());

            let ok = match candidate {
                Some(provided_bytes) => {
                    // constant-time: 동일 길이일 때만 의미. 다르면 fail.
                    // verify_slice 는 비교용으로 다시 HMAC 계산 — 길이 mismatch 도 안전 처리.
                    let mut m2 = HmacSha256::new_from_slice(sec.as_bytes())
                        .map_err(|e| AppError::Internal(anyhow::anyhow!("hmac key: {e}")))?;
                    m2.update(&body);
                    m2.verify_slice(&provided_bytes).is_ok()
                }
                None => false,
            };

            if !ok {
                tracing::warn!(provided = %sig, expected_prefix = %&expected_b64[..8.min(expected_b64.len())],
                    "toss webhook signature mismatch");
                return Err(AppError::Unauthorized);
            }
        }
        // 시크릿이 등록돼 있는데 서명 헤더 누락 → 위조/오설정 의심, 거부.
        (Some(_), None) => {
            tracing::warn!("toss webhook: secret configured but no signature header — rejecting");
            return Err(AppError::Unauthorized);
        }
        // 시크릿 미설정 (개발 환경) → 통과시키되 경고.
        (None, _) => {
            tracing::warn!("toss webhook: TOSS_WEBHOOK_SECRET not set — accepting (dev mode)");
        }
    }

    // 2) 본문 파싱
    let ev: WebhookEvent = serde_json::from_slice(&body)
        .map_err(|e| AppError::BadRequest(format!("invalid webhook body: {e}")))?;

    let order_id = ev.data.get("orderId").and_then(|v| v.as_str()).unwrap_or("");
    let payment_key = ev.data.get("paymentKey").and_then(|v| v.as_str()).unwrap_or("");
    let toss_status = ev.data.get("status").and_then(|v| v.as_str()).unwrap_or("");

    if order_id.is_empty() {
        return Ok(Json(json!({"ok": true, "ignored": "no orderId"})));
    }

    tracing::info!(event_type=%ev.event_type, order_id, toss_status, "toss webhook received");

    // 3) 우리 DB 의 주문 확인
    let row: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT user_id, amount, status FROM payment_orders WHERE order_id = $1",
    )
    .bind(order_id).fetch_optional(&state.db).await?;
    let Some((user_id, _amount, our_status)) = row else {
        return Ok(Json(json!({"ok": true, "ignored": "order not found"})));
    };

    match (ev.event_type.as_str(), toss_status) {
        // DONE → 적립 (멱등)
        (_, "DONE") if our_status != "confirmed" => {
            let method      = ev.data.get("method").and_then(|v| v.as_str()).map(|s| s.to_string());
            let receipt_url = ev.data.get("receipt").and_then(|r| r.get("url")).and_then(|v| v.as_str()).map(|s| s.to_string());
            let _ = credit_payment(
                &state.db, order_id, user_id,
                payment_key, method.as_deref(), receipt_url.as_deref(),
                &ev.data,
            ).await;
        }
        // 취소/만료 → 실패 마킹
        (_, "CANCELED") | (_, "EXPIRED") | (_, "ABORTED") => {
            let _ = sqlx::query(
                r#"UPDATE payment_orders
                      SET status = CASE WHEN $2 = 'CANCELED' THEN 'cancelled' ELSE 'failed' END,
                          fail_reason = $2,
                          raw_response = $3
                    WHERE order_id = $1 AND status IN ('pending','waiting')"#,
            )
            .bind(order_id).bind(toss_status).bind(&ev.data)
            .execute(&state.db).await;
        }
        _ => {
            // 그 외 이벤트는 단순 raw_response 갱신만
            let _ = sqlx::query(
                "UPDATE payment_orders SET raw_response = $2 WHERE order_id = $1",
            )
            .bind(order_id).bind(&ev.data).execute(&state.db).await;
        }
    }
    Ok(Json(json!({"ok": true})))
}
