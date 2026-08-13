// 사용자 포인트 차감/환불 헬퍼.
//
// charge: UPDATE … SET credits = credits - $cost WHERE id = $uid AND credits >= $cost RETURNING credits
//          → 부족하면 NotEnough 반환. 한 SQL 안에서 잠금 + 검사 + 차감 + 로그 → 동시성 안전.
// refund: 단순 +. 실패 케이스(AI 분석 실패, SIM 충전 실패)에 호출.
// grant : 관리자 수동 충전 / 사용자 self-topup (결제 PG 연동 전 임시 흐름)

use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
pub struct CreditTxn {
    pub id:      i64,
    pub balance: i64,
}

/// 차감 (호출측 트랜잭션 내에서 수행). 잔액 부족이면 `AppError::BadRequest`.
/// 구독 구매처럼 "차감 + 후속 INSERT" 를 한 트랜잭션으로 원자 처리해야 하는 곳에서 사용 —
/// 후속 작업이 실패하면 호출측이 tx 를 rollback 해 차감도 함께 취소된다.
pub async fn charge_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
    cost: i64,
    reason: &str,
    ref_id: Option<i64>,
    note: Option<&str>,
) -> AppResult<CreditTxn> {
    if cost <= 0 {
        return Err(AppError::BadRequest("invalid cost".into()));
    }
    // 원자적 차감 — credits >= cost 보장. 부족하면 None.
    let updated: Option<i64> = sqlx::query_scalar(
        r#"UPDATE users SET credits = credits - $2
            WHERE id = $1 AND credits >= $2
        RETURNING credits"#,
    )
    .bind(user_id).bind(cost)
    .fetch_optional(&mut **tx).await?;

    let balance = updated.ok_or_else(|| AppError::BadRequest(
        format!("포인트가 부족합니다 (필요 {cost}원).")
    ))?;

    // 거래 로그
    let log_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO credit_log (user_id, delta, balance, reason, ref_id, note)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id"#,
    )
    .bind(user_id)
    .bind(-cost)
    .bind(balance)
    .bind(reason)
    .bind(ref_id)
    .bind(note)
    .fetch_one(&mut **tx).await?;

    Ok(CreditTxn { id: log_id, balance })
}

/// 차감 (자체 트랜잭션). 후속 작업 없는 단순 차감용.
pub async fn charge(
    db: &PgPool,
    user_id: i64,
    cost: i64,
    reason: &str,
    ref_id: Option<i64>,
    note: Option<&str>,
) -> AppResult<CreditTxn> {
    let mut tx = db.begin().await?;
    let txn = charge_tx(&mut tx, user_id, cost, reason, ref_id, note).await?;
    tx.commit().await?;
    Ok(txn)
}

/// 환불 — charge 의 역. fail 시 0 으로 fallback (오류 가시성을 위해 실패는 trace).
pub async fn refund(
    db: &PgPool,
    user_id: i64,
    amount: i64,
    reason: &str,
    ref_id: Option<i64>,
    note: Option<&str>,
) -> AppResult<CreditTxn> {
    if amount <= 0 {
        return Err(AppError::BadRequest("invalid amount".into()));
    }
    let mut tx = db.begin().await?;
    let balance: i64 = sqlx::query_scalar(
        "UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits",
    )
    .bind(user_id).bind(amount)
    .fetch_one(&mut *tx).await?;

    let log_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO credit_log (user_id, delta, balance, reason, ref_id, note)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id"#,
    )
    .bind(user_id).bind(amount).bind(balance)
    .bind(reason).bind(ref_id).bind(note)
    .fetch_one(&mut *tx).await?;

    tx.commit().await?;
    Ok(CreditTxn { id: log_id, balance })
}

/// 잔액 단순 조회.
pub async fn balance(db: &PgPool, user_id: i64) -> AppResult<i64> {
    let v: Option<i64> = sqlx::query_scalar("SELECT credits FROM users WHERE id = $1")
        .bind(user_id).fetch_optional(db).await?;
    Ok(v.unwrap_or(0))
}
