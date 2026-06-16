// 다중 전화번호 관리 (auth 필요).
// seriallink 패턴 참조 — list / send / verify / primary / delete.
//
// 정책:
//  - 한 사용자가 여러 번호 보유 가능. 그 중 1개만 is_primary.
//  - 번호 추가는 OTP 인증 거쳐야 등록됨 (인증 전엔 user_phones 에도 안 들어감).
//  - 글로벌 중복 차단 없음. 같은 번호가 여러 계정 (메인/서브 임의 조합) 에 등록돼도 허용.
//    OTP 인증 = 순간의 소유 증명만 보장. (마이그레이션 0027 에서 글로벌 unique 인덱스 제거)
//  - 단, 한 번호가 메인(is_primary=TRUE)인 계정은 글로벌 최대 3개로 제한 (MAX_MAIN_HOLDERS).
//    서브는 무제한, 메인 승격 시점에 cap 검증.
//  - 메인 변경은 트랜잭션으로 user_phones.is_primary + users.phone 동기화.
//  - 메인 삭제 차단 — 다른 번호를 메인 승격 후 삭제 가능.

use axum::{
    extract::{Path, State},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

pub const MAX_MAIN_HOLDERS: i64 = 3;

/// 해당 phone 을 메인(is_primary=TRUE) 으로 가지고 있는 사용자 수.
/// `except_user_id` 가 Some 이면 그 사용자는 제외 (자신이 이미 보유한 경우의 self-count 방지).
pub async fn count_main_holders(
    db: &sqlx::PgPool,
    phone: &str,
    except_user_id: Option<i64>,
) -> Result<i64, sqlx::Error> {
    // -1 sentinel — user_id 는 BIGSERIAL (>=1) 이라 충돌 없음.
    let except = except_user_id.unwrap_or(-1);
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_phones \
          WHERE phone = $1 AND is_primary = TRUE AND is_verified = TRUE \
            AND user_id <> $2",
    ).bind(phone).bind(except).fetch_one(db).await
}

/// MAX_MAIN_HOLDERS 초과 시 Conflict 반환.
pub async fn assert_main_cap(
    db: &sqlx::PgPool,
    phone: &str,
    except_user_id: Option<i64>,
) -> AppResult<()> {
    let n = count_main_holders(db, phone, except_user_id).await?;
    if n >= MAX_MAIN_HOLDERS {
        return Err(AppError::Conflict(format!(
            "이 번호는 이미 {} 개 계정의 메인으로 사용 중입니다 (최대 {})", n, MAX_MAIN_HOLDERS
        )));
    }
    Ok(())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/phones",                 get(list).post(send_otp))
        .route("/auth/phones/verify",          post(verify))
        .route("/auth/phones/:id/primary",     put(set_primary))
        .route("/auth/phones/:id",             delete(delete_phone))
}

#[derive(Debug, Serialize, FromRow)]
pub struct PhoneRow {
    pub id:          i64,
    pub phone:       String,
    pub is_verified: bool,
    pub is_primary:  bool,
    pub created_at:  DateTime<Utc>,
    pub verified_at: Option<DateTime<Utc>>,
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<PhoneRow>>> {
    let rows = sqlx::query_as::<_, PhoneRow>(
        r#"SELECT id, phone, is_verified, is_primary, created_at, verified_at
             FROM user_phones
            WHERE user_id = $1
            ORDER BY is_primary DESC, created_at ASC"#,
    )
    .bind(user.user_id)
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ─── 1) OTP 발송 (POST /auth/phones) ────────────────────
//
// 새 번호 추가 또는 기존 메인 번호 변경의 시작점.
// otp_codes 테이블에 purpose='phone_add' 로 적재 (회원가입 OTP 와 분리).

#[derive(Debug, Deserialize)]
pub struct SendOtpRequest {
    pub phone: String,
}

#[derive(Debug, Serialize)]
pub struct SendOtpResponse {
    pub ok: bool,
    pub phone: String,
    pub expires_in_sec: i64,
    pub remaining_today: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev_code: Option<String>,
}

async fn send_otp(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<SendOtpRequest>,
) -> AppResult<Json<SendOtpResponse>> {
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호를 입력하세요".into()))?;

    // 글로벌 중복 차단 없음 — 정책상 OTP 통과만으로 충분 (0027).

    // 같은 휴대폰 24h 5회 제한 (회원가입 OTP 와 통합 카운트 — otp_codes 테이블 공유).
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM otp_codes \
          WHERE phone = $1 AND created_at > NOW() - INTERVAL '24 hours'",
    ).bind(&phone).fetch_one(&state.db).await?;
    if today_count >= 5 {
        return Err(AppError::BadRequest("하루 발송 횟수(5회)를 초과했습니다".into()));
    }

    let code = crate::services::sms::generate_code();
    let expires = Utc::now() + Duration::minutes(3);
    sqlx::query(
        "INSERT INTO otp_codes (phone, code, purpose, expires_at) \
         VALUES ($1, $2, 'phone_add', $3)",
    ).bind(&phone).bind(&code).bind(expires).execute(&state.db).await?;

    if let Err(e) = crate::services::sms::send_otp(&phone, &code).await {
        tracing::warn!(%phone, "phones send_otp failed: {e:#}");
        return Err(AppError::Internal(anyhow::anyhow!("SMS 발송 실패: {e}")));
    }

    let dev_code = if std::env::var("SMS_DEV_MODE").ok().as_deref() == Some("1") {
        Some(code.clone())
    } else { None };

    Ok(Json(SendOtpResponse {
        ok: true,
        phone,
        expires_in_sec: 180,
        remaining_today: 5 - (today_count + 1),
        dev_code,
    }))
}

// ─── 2) OTP 검증 + 등록/메인승격 (POST /auth/phones/verify) ─

#[derive(Debug, Deserialize)]
pub struct VerifyRequest {
    pub phone:       String,
    pub otp_code:    String,
    /// true 면 등록 후 즉시 메인 번호로 승격 (users.phone 동기화).
    #[serde(default)]
    pub set_primary: bool,
}

#[derive(Debug, Serialize)]
pub struct VerifyResponse {
    pub ok: bool,
    pub phone_id: i64,
    pub is_primary: bool,
}

async fn verify(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<VerifyRequest>,
) -> AppResult<Json<VerifyResponse>> {
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호".into()))?;

    // OTP 검증 + 소모 (atomic + constant-time — phone_add / register 둘 다 허용)
    crate::auth::otp::verify_and_consume(&state.db, &phone, &["phone_add", "register"], &req.otp_code).await?;

    // 글로벌 중복 재확인 없음 — 0027 정책.

    let mut tx = state.db.begin().await?;

    // 같은 번호가 본인 user_phones 에 이미 있으면 update, 없으면 insert.
    let phone_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO user_phones (user_id, phone, is_verified, verified_at)
                VALUES ($1, $2, TRUE, NOW())
           ON CONFLICT (user_id, phone) DO UPDATE
                SET is_verified = TRUE,
                    verified_at = NOW()
           RETURNING id"#,
    ).bind(user.user_id).bind(&phone).fetch_one(&mut *tx).await?;

    let mut is_primary = false;
    if req.set_primary {
        // 메인 cap (자기 자신 제외 < 3 이어야 승격 가능)
        assert_main_cap(&state.db, &phone, Some(user.user_id)).await?;
        // 다른 메인 해제
        sqlx::query(
            "UPDATE user_phones SET is_primary = FALSE \
              WHERE user_id = $1 AND is_primary = TRUE AND id <> $2",
        ).bind(user.user_id).bind(phone_id).execute(&mut *tx).await?;
        // 이걸 메인으로
        sqlx::query("UPDATE user_phones SET is_primary = TRUE WHERE id = $1")
            .bind(phone_id).execute(&mut *tx).await?;
        // users.phone + phone_verified 동기화
        sqlx::query(
            "UPDATE users SET phone = $1, phone_verified = TRUE WHERE id = $2",
        ).bind(&phone).bind(user.user_id).execute(&mut *tx).await?;
        is_primary = true;
    } else {
        // 첫 번호 (사용자가 set_primary=false 라도) → 자동 primary 보장.
        let primary_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM user_phones WHERE user_id = $1 AND is_primary = TRUE",
        ).bind(user.user_id).fetch_one(&mut *tx).await?;
        if primary_count == 0 {
            // 자동 메인 승격에도 cap 검증.
            assert_main_cap(&state.db, &phone, Some(user.user_id)).await?;
            sqlx::query("UPDATE user_phones SET is_primary = TRUE WHERE id = $1")
                .bind(phone_id).execute(&mut *tx).await?;
            sqlx::query(
                "UPDATE users SET phone = $1, phone_verified = TRUE WHERE id = $2",
            ).bind(&phone).bind(user.user_id).execute(&mut *tx).await?;
            is_primary = true;
        }
    }

    tx.commit().await?;
    Ok(Json(VerifyResponse { ok: true, phone_id, is_primary }))
}

// ─── 3) 메인 승격 (PUT /auth/phones/:id/primary) ────────

async fn set_primary(
    State(state): State<AppState>,
    user: AuthUser,
    Path(phone_id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.db.begin().await?;

    // 본인 소유 + 인증된 번호인지
    let row: Option<(String, bool, bool)> = sqlx::query_as(
        "SELECT phone, is_verified, is_primary FROM user_phones \
          WHERE id = $1 AND user_id = $2",
    ).bind(phone_id).bind(user.user_id).fetch_optional(&mut *tx).await?;
    let (phone, is_verified, already_primary) = row.ok_or(AppError::NotFound)?;
    if !is_verified {
        return Err(AppError::BadRequest("인증되지 않은 번호는 메인으로 설정할 수 없습니다".into()));
    }
    if already_primary {
        tx.commit().await?;
        return Ok(Json(serde_json::json!({ "ok": true, "noop": true })));
    }

    // 메인 cap (자기 자신 제외 < 3 이어야 승격 가능)
    assert_main_cap(&state.db, &phone, Some(user.user_id)).await?;

    // 기존 메인 해제
    sqlx::query(
        "UPDATE user_phones SET is_primary = FALSE WHERE user_id = $1 AND is_primary = TRUE",
    ).bind(user.user_id).execute(&mut *tx).await?;
    // 새 메인 설정
    sqlx::query("UPDATE user_phones SET is_primary = TRUE WHERE id = $1")
        .bind(phone_id).execute(&mut *tx).await?;
    // users.phone 동기화
    sqlx::query("UPDATE users SET phone = $1, phone_verified = TRUE WHERE id = $2")
        .bind(&phone).bind(user.user_id).execute(&mut *tx).await?;

    tx.commit().await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── 4) 삭제 (DELETE /auth/phones/:id) ──────────────────

async fn delete_phone(
    State(state): State<AppState>,
    user: AuthUser,
    Path(phone_id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(bool,)> = sqlx::query_as(
        "SELECT is_primary FROM user_phones WHERE id = $1 AND user_id = $2",
    ).bind(phone_id).bind(user.user_id).fetch_optional(&state.db).await?;
    let (is_primary,) = row.ok_or(AppError::NotFound)?;
    if is_primary {
        return Err(AppError::BadRequest("메인 번호는 삭제할 수 없습니다. 다른 번호를 메인으로 승격 후 삭제하세요".into()));
    }

    sqlx::query("DELETE FROM user_phones WHERE id = $1").bind(phone_id).execute(&state.db).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
