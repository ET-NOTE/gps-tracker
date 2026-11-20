//! Minimal rights workflow. Never equate FK SET NULL with anonymisation.
use crate::{
    auth::password,
    error::{AppError, AppResult},
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};

#[derive(Debug, Serialize, FromRow)]
pub struct RequestRow {
    pub id: i64,
    pub user_id: i64,
    pub kind: String,
    pub scope: String,
    pub status: String,
    pub revision: i32,
    pub assigned_to: Option<i64>,
    pub due_at: Option<DateTime<Utc>>,
    pub result_message: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub fn open(status: &str) -> bool {
    matches!(status, "received" | "in_review" | "needs_information")
}

pub fn validate_review(
    kind: &str,
    before: &str,
    after: &str,
    message: &str,
    evidence: &str,
    due: Option<DateTime<Utc>>,
) -> AppResult<()> {
    if !open(before) {
        return Err(AppError::Conflict("이미 종료된 요청입니다.".into()));
    }
    if !matches!(
        after,
        "in_review" | "needs_information" | "fulfilled" | "rejected"
    ) {
        return Err(AppError::BadRequest(
            "지원하지 않는 처리 상태입니다.".into(),
        ));
    }
    if matches!(kind, "erasure" | "account_closure") && after == "fulfilled" {
        return Err(AppError::Conflict(
            "파기 실행·백업 처리 검증 전에는 삭제 또는 탈퇴를 완료할 수 없습니다.".into(),
        ));
    }
    if message.trim().is_empty() || message.chars().count() > 2000 || evidence.chars().count() > 160
    {
        return Err(AppError::BadRequest(
            "사용자에게 전달할 처리 안내를 1~2,000자로 입력해 주세요.".into(),
        ));
    }
    if matches!(after, "fulfilled" | "rejected") && evidence.trim().is_empty() {
        return Err(AppError::BadRequest(
            "처리 근거의 내부 참조번호를 입력해 주세요.".into(),
        ));
    }
    if open(after) && due.is_none() {
        return Err(AppError::BadRequest("처리 기한을 지정해 주세요.".into()));
    }
    Ok(())
}

pub async fn create(
    db: &PgPool,
    user: i64,
    key: uuid::Uuid,
    kind: &str,
    scope: &str,
    supplied_password: &str,
) -> AppResult<RequestRow> {
    if !matches!(
        kind,
        "access" | "rectification" | "erasure" | "account_closure"
    ) || scope.trim().is_empty()
        || scope.chars().count() > 2000
    {
        return Err(AppError::BadRequest(
            "요청 종류와 대상 내용을 확인해 주세요.".into(),
        ));
    }
    let mut tx = db.begin().await?;
    sqlx::query("SELECT privacy_assert_account_active($1)")
        .bind(user)
        .execute(&mut *tx)
        .await?;
    // Serialize same-user requests and password changes; no device ownership changes.
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1 FOR UPDATE")
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if !password::verify(supplied_password, &hash) {
        return Err(AppError::BadRequest(
            "현재 비밀번호를 확인해 주세요.".into(),
        ));
    }
    let existing: Option<RequestRow> = sqlx::query_as(
        "SELECT * FROM privacy_requests WHERE user_id=$1 AND request_key=$2::text::uuid",
    )
    .bind(user)
    .bind(key.to_string())
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = existing {
        if row.kind != kind || row.scope != scope.trim() {
            return Err(AppError::Conflict(
                "같은 요청 번호에 다른 내용을 사용할 수 없습니다.".into(),
            ));
        }
        return Ok(row);
    }
    let existing: Option<RequestRow> = sqlx::query_as("SELECT * FROM privacy_requests WHERE user_id=$1 AND kind=$2 AND status IN ('received','in_review','needs_information')")
        .bind(user).bind(kind).fetch_optional(&mut *tx).await?;
    if existing.is_some() {
        return Err(AppError::Conflict(
            "같은 종류의 요청이 진행 중입니다. 기존 요청의 상태를 확인해 주세요.".into(),
        ));
    }
    let row: RequestRow = sqlx::query_as("INSERT INTO privacy_requests(user_id,request_key,kind,scope) VALUES($1,$2::text::uuid,$3,$4) RETURNING *")
        .bind(user).bind(key.to_string()).bind(kind).bind(scope.trim()).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status) VALUES($1,$2,1,'received')")
        .bind(row.id).bind(user).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}

/// Read-only inventory with capped counts and a per-query timeout. Counts stop
/// at 10,001; query cost still depends on existing indexes and data distribution.
/// Detached history is matched by collection owner.
pub async fn impact(db: &PgPool, user: i64) -> AppResult<Value> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let mut rows = Vec::new();
    for (table, column, label) in [
        ("devices", "owner_id", "연결 단말기"),
        (
            "location_records",
            "user_id",
            "수신 당시 본인 계정의 위치 기록",
        ),
        ("events", "user_id", "단말기 이벤트"),
        ("daily_stats", "user_id", "운행 통계"),
        ("trip_annotations", "user_id", "운행 메모·운전자 정보"),
        ("geofences", "owner_id", "개인 지오펜스"),
        ("share_tokens", "created_by", "공유 링크"),
        ("ai_analyses", "user_id", "AI 분석 결과"),
        ("device_documents", "user_id", "차량 첨부파일"),
        ("rental_photos", "user_id", "렌터카 사진"),
        (
            "location_subject_mappings",
            "subject_id",
            "본인 운전자 연결·동의 이력",
        ),
        (
            "location_provision_notices",
            "subject_id",
            "본인 위치정보 제공 통보",
        ),
        ("fleet_vehicles", "owner_id", "회사 차량"),
        ("staff", "user_id", "회사 사용자 명단"),
        ("fleet_staff_accounts", "account_id", "직원으로 연결한 회사"),
        ("fleet_sites", "owner_id", "회사 지점"),
        ("fleet_site_visits", "owner_id", "회사 지점 방문 이력"),
        ("fleet_trip_corrections", "owner_id", "운행 보정·원본 참조"),
        ("fleet_expenses", "owner_id", "회사 지출"),
        ("payment_orders", "user_id", "결제 주문"),
        ("credit_log", "user_id", "포인트 내역"),
        ("sim_topup_requests", "user_id", "SIM 충전 내역"),
    ] {
        // Table/column identifiers are a fixed compile-time allowlist.
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM (SELECT 1 FROM {table} WHERE {column}=$1 LIMIT 10001) AS scoped"
        ))
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
        rows.push(json!({"key":table,"label":label,"count":count.min(10000),"more":count>10000}));
    }
    tx.commit().await?;
    Ok(json!({"as_of":Utc::now(),"read_only":true,"items":rows,
        "manual_review":["회사에 보관된 직원 개인정보·운전자 스냅샷", "운전자 연결 동의·제공 통보·발송 증빙의 별도 보존 및 파기", "회사 처리 보고서·증빙과 검토 이력의 보관·삭제","법적 보존 대상 거래 자료와 보관 기한","서버 첨부파일·백업·배포 사본·외부 전달본","기존 소유자 미상(NULL) 자료와 공용 캐시"],
        "deletion_ready":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destructive_work_cannot_be_completed_by_intake() {
        for kind in ["erasure", "account_closure"] {
            assert!(
                validate_review(kind, "in_review", "fulfilled", "완료", "case-1", None).is_err()
            );
        }
        assert!(validate_review(
            "access",
            "in_review",
            "fulfilled",
            "전달 완료",
            "case-1",
            None
        )
        .is_ok());
        assert!(validate_review(
            "access",
            "fulfilled",
            "in_review",
            "재시도",
            "",
            Some(Utc::now())
        )
        .is_err());
        assert!(validate_review("access", "received", "in_review", "검토", "", None).is_err());
        assert!(validate_review("access", "in_review", "rejected", "사유", "", None).is_err());
    }
}
