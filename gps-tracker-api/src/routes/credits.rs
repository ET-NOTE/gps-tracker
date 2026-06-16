// /api/v1/credits/* — 사용자 포인트 잔액 / 거래 이력 / 충전 요청.
//
// 흐름:
//   1) 사용자 POST /credits/requests { amount } — pending 요청 생성, 채팅 thread 에 시스템 메시지
//   2) 관리자 POST /admin/credits/requests/:id/approve — credits +amount, status=approved
//      (또는 reject — 상태만 변경, 잔액 변동 X)
//   3) 추후 PG 연동되면 webhook 이 직접 approve 호출.
//
// 개발/테스트 용도로 self-topup 은 ALLOW_SELF_TOPUP=1 일 때만 동작 (잔액 직접 +).

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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/credits/balance",          get(balance))
        .route("/credits/log",              get(log))
        .route("/credits/topup",            post(self_topup))
        .route("/credits/requests",         post(create_request).get(list_my_requests))
        .route("/credits/requests/:id/cancel", post(cancel_my_request))
}

pub fn router_admin() -> Router<AppState> {
    Router::new()
        .route("/admin/credits/requests",                get(list_all_requests))
        .route("/admin/credits/requests/:id/approve",    post(approve_request))
        .route("/admin/credits/requests/:id/reject",     post(reject_request))
}

#[derive(Debug, Serialize)]
struct BalanceView {
    balance: i64,
}

async fn balance(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<BalanceView>> {
    let v = credits::balance(&state.db, user.user_id).await?;
    Ok(Json(BalanceView { balance: v }))
}

#[derive(Debug, Serialize, FromRow)]
struct CreditLogRow {
    id:         i64,
    delta:      i64,
    balance:    i64,
    reason:     String,
    ref_id:     Option<i64>,
    note:       Option<String>,
    created_at: DateTime<Utc>,
}

async fn log(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<CreditLogRow>>> {
    let rows = sqlx::query_as::<_, CreditLogRow>(
        r#"SELECT id, delta, balance, reason, ref_id, note, created_at
             FROM credit_log
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 100"#,
    )
    .bind(user.user_id)
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ─── self-topup (개발용, ALLOW_SELF_TOPUP=1) ───────────────
#[derive(Debug, Deserialize)]
struct SelfTopupReq { amount: i64 }

async fn self_topup(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<SelfTopupReq>,
) -> AppResult<Json<Value>> {
    if std::env::var("ALLOW_SELF_TOPUP").ok().as_deref() != Some("1") {
        return Err(AppError::Forbidden);
    }
    if req.amount <= 0 || req.amount > 1_000_000 {
        return Err(AppError::BadRequest("amount must be 1..=1_000_000".into()));
    }
    let txn = credits::refund(
        &state.db, user.user_id, req.amount,
        "topup", None, Some("self-topup (dev)"),
    ).await?;
    Ok(Json(json!({ "ok": true, "balance": txn.balance })))
}

// ─── 충전 요청 (사용자) ─────────────────────────────────
#[derive(Debug, Deserialize)]
struct CreateRequestBody {
    amount: i64,
    note:   Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
struct CreditRequestRow {
    id:             i64,
    user_id:        i64,
    amount:         i64,
    status:         String,
    payment_method: Option<String>,
    payment_ref:    Option<String>,
    note:           Option<String>,
    requested_at:   DateTime<Utc>,
    processed_at:   Option<DateTime<Utc>>,
}

async fn create_request(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateRequestBody>,
) -> AppResult<Json<CreditRequestRow>> {
    if req.amount <= 0 || req.amount > 10_000_000 {
        return Err(AppError::BadRequest("amount must be 1..=10_000_000".into()));
    }

    // 기존 pending 요청이 너무 많으면 차단 (스팸 방지)
    let pending_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM credit_topup_requests WHERE user_id = $1 AND status = 'pending'",
    )
    .bind(user.user_id).fetch_one(&state.db).await?;
    if pending_count >= 5 {
        return Err(AppError::Conflict(
            "이미 처리 대기 중인 충전 요청이 5건 있습니다. 관리자 승인을 기다려주세요.".into(),
        ));
    }

    let row: CreditRequestRow = sqlx::query_as(
        r#"INSERT INTO credit_topup_requests (user_id, amount, note, payment_method)
           VALUES ($1, $2, $3, 'manual_admin')
           RETURNING id, user_id, amount, status,
                     payment_method, payment_ref, note,
                     requested_at, processed_at"#,
    )
    .bind(user.user_id).bind(req.amount).bind(&req.note)
    .fetch_one(&state.db).await?;

    // 채팅 thread 에 시스템 메시지 (관리자 inbox 자동 알림용)
    let body = format!(
        "포인트 충전 요청 #{}: {}원{}",
        row.id, row.amount,
        match req.note.as_deref() { Some(n) if !n.is_empty() => format!(" — {n}"), _ => "".into() },
    );
    let _ = post_system_message_to_user_thread(
        &state, user.user_id, &body,
        json!({"kind": "credit_topup_request", "request_id": row.id, "amount": row.amount}),
    ).await;

    Ok(Json(row))
}

async fn list_my_requests(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<CreditRequestRow>>> {
    let rows = sqlx::query_as::<_, CreditRequestRow>(
        r#"SELECT id, user_id, amount, status,
                  payment_method, payment_ref, note,
                  requested_at, processed_at
             FROM credit_topup_requests
            WHERE user_id = $1
            ORDER BY requested_at DESC
            LIMIT 50"#,
    )
    .bind(user.user_id)
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ─── 사용자 본인 취소 ───────────────────────────────────
// 아직 admin 이 승인하지 않은 pending 요청만 취소 가능.
// admin 의 approve 와 동시에 실행되면 FOR UPDATE row lock 으로 직렬화 →
// 먼저 lock 잡는 쪽이 승리, 진 쪽은 status != 'pending' 으로 Conflict.
async fn cancel_my_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;

    // owner 검증 + 잠금 + 상태 확인을 한 query 로
    let row: Option<(i64, i64, String)> = sqlx::query_as(
        r#"SELECT id, user_id, status
             FROM credit_topup_requests
            WHERE id = $1
              FOR UPDATE"#,
    )
    .bind(id).fetch_optional(&mut *tx).await?;
    let (req_id, owner_id, status) = row.ok_or(AppError::NotFound)?;
    if owner_id != user.user_id {
        // owner 가 아니면 존재 자체를 숨김 (권한 노출 회피)
        return Err(AppError::NotFound);
    }
    if status != "pending" {
        return Err(AppError::Conflict(format!(
            "이미 처리된 요청입니다 (status={status}). 새로고침 해주세요."
        )));
    }

    sqlx::query(
        r#"UPDATE credit_topup_requests
              SET status = 'cancelled',
                  processed_at = NOW(),
                  processed_by = $2
            WHERE id = $1"#,
    )
    .bind(req_id).bind(user.user_id)
    .execute(&mut *tx).await?;
    tx.commit().await?;

    let _ = post_system_message_to_user_thread(
        &state, user.user_id,
        &format!("포인트 충전 요청 #{req_id} 사용자 취소"),
        json!({"kind":"credit_topup_user_cancelled","request_id":req_id}),
    ).await;

    Ok(Json(json!({ "ok": true, "request_id": req_id })))
}

// ─── 충전 요청 (관리자) ────────────────────────────────
// cancelled_by_user 플래그로 "사용자 본인 취소" 식별
#[derive(Debug, Serialize, FromRow)]
struct AdminCreditRequestRow {
    id:                 i64,
    user_id:            i64,
    user_email:         Option<String>,
    user_display:       Option<String>,
    amount:             i64,
    status:             String,
    payment_method:     Option<String>,
    note:               Option<String>,
    requested_at:       DateTime<Utc>,
    processed_at:       Option<DateTime<Utc>>,
    processed_by:       Option<i64>,
    processed_by_email: Option<String>,
    cancelled_by_user:  Option<bool>,
}

async fn list_all_requests(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<AdminCreditRequestRow>>> {
    let rows = sqlx::query_as::<_, AdminCreditRequestRow>(
        r#"SELECT r.id, r.user_id,
                  u.email AS user_email, u.display_name AS user_display,
                  r.amount, r.status, r.payment_method, r.note,
                  r.requested_at, r.processed_at,
                  r.processed_by,
                  pu.email AS processed_by_email,
                  CASE WHEN r.status = 'cancelled' AND r.processed_by = r.user_id
                       THEN TRUE ELSE FALSE END AS cancelled_by_user
             FROM credit_topup_requests r
        LEFT JOIN users u  ON u.id  = r.user_id
        LEFT JOIN users pu ON pu.id = r.processed_by
            ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
            LIMIT 200"#,
    )
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// 동시성: conditional UPDATE 'pending' → 'approved' 한 번으로 claim.
// 같은 row 에 user cancel 이 동시에 들어오면 Postgres 가 row-level lock 으로
// 직렬화 → 한 쪽만 1행 영향, 다른 쪽은 0행 → Conflict.
// 잔액 추가도 같은 tx 안 → status 와 credits 가 항상 일관.
async fn approve_request(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;

    let claim: Option<(i64, i64)> = sqlx::query_as(
        r#"UPDATE credit_topup_requests
              SET status = 'approved',
                  processed_at = NOW(),
                  processed_by = $2
            WHERE id = $1 AND status = 'pending'
        RETURNING user_id, amount"#,
    )
    .bind(id).bind(admin.user_id)
    .fetch_optional(&mut *tx).await?;

    let (user_id, amount) = match claim {
        Some(v) => v,
        None => {
            tx.rollback().await?;
            let cur: Option<String> = sqlx::query_scalar(
                "SELECT status FROM credit_topup_requests WHERE id = $1",
            )
            .bind(id).fetch_optional(&state.db).await?;
            return match cur {
                Some(s) => Err(AppError::Conflict(format!("이미 {s} 상태입니다. 새로고침 해주세요."))),
                None    => Err(AppError::NotFound),
            };
        }
    };
    let req_id = id;

    // 같은 tx 안에서 잔액 +amount + credit_log
    let new_balance: i64 = sqlx::query_scalar(
        "UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits",
    )
    .bind(user_id).bind(amount)
    .fetch_one(&mut *tx).await?;

    sqlx::query(
        r#"INSERT INTO credit_log (user_id, delta, balance, reason, ref_id, note)
           VALUES ($1, $2, $3, 'topup', $4, $5)"#,
    )
    .bind(user_id).bind(amount).bind(new_balance)
    .bind(req_id).bind(format!("admin approve req#{req_id}"))
    .execute(&mut *tx).await?;

    tx.commit().await?;

    let _ = post_system_message_to_user_thread(
        &state, user_id,
        &format!("포인트 충전 요청 #{req_id} 승인 완료 — {}원 충전됨 (잔액 {}원)",
            amount, new_balance),
        json!({
            "kind": "credit_topup_approved",
            "request_id": req_id,
            "amount": amount,
            "balance": new_balance,
        }),
    ).await;

    Ok(Json(json!({
        "ok":         true,
        "request_id": req_id,
        "amount":     amount,
        "balance":    new_balance,
    })))
}

#[derive(Debug, Deserialize, Default)]
struct RejectBody { reason: Option<String> }

async fn reject_request(
    admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Option<Json<RejectBody>>,
) -> AppResult<Json<Value>> {
    let reason = body.and_then(|b| b.0.reason).unwrap_or_default();
    let reason_opt = if reason.is_empty() { None } else { Some(reason.clone()) };

    // conditional UPDATE — user cancel 과 race 시 한쪽만 성공
    let row: Option<(i64, i64)> = sqlx::query_as(
        r#"UPDATE credit_topup_requests
              SET status = 'rejected',
                  processed_at = NOW(),
                  processed_by = $2,
                  note = COALESCE($3, note)
            WHERE id = $1 AND status = 'pending'
        RETURNING user_id, amount"#,
    )
    .bind(id).bind(admin.user_id).bind(reason_opt.as_ref())
    .fetch_optional(&state.db).await?;

    let (user_id, amount) = match row {
        Some(v) => v,
        None => {
            let cur: Option<String> = sqlx::query_scalar(
                "SELECT status FROM credit_topup_requests WHERE id = $1",
            )
            .bind(id).fetch_optional(&state.db).await?;
            return match cur {
                Some(s) => Err(AppError::Conflict(format!("이미 {s} 상태입니다."))),
                None    => Err(AppError::NotFound),
            };
        }
    };
    let req_id = id;

    let body = if reason.is_empty() {
        format!("포인트 충전 요청 #{req_id} 반려됨 ({}원)", amount)
    } else {
        format!("포인트 충전 요청 #{req_id} 반려됨 ({}원) — {}", amount, reason)
    };
    let _ = post_system_message_to_user_thread(
        &state, user_id, &body,
        json!({"kind":"credit_topup_rejected","request_id":req_id,"amount":amount}),
    ).await;

    Ok(Json(json!({ "ok": true, "request_id": req_id })))
}

// ─── helper: chat thread 에 시스템 메시지 + FCM 푸시 ─────
async fn post_system_message_to_user_thread(
    state: &AppState,
    user_id: i64,
    body: &str,
    meta: Value,
) -> AppResult<()> {
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

    // 시스템 메시지의 종류로 push 대상 결정:
    //   request_*  / *_user_cancelled : 관리자 inbox (사용자 액션)
    //   *_approved / *_rejected       : 사용자 (관리자 액션)
    let kind = meta.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let to_admins = matches!(kind,
        "credit_topup_request"
        | "credit_topup_user_cancelled"
        | "sim_topup_request"
        | "sim_topup_user_cancelled"
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
