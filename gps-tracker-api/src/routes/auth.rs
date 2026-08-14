use axum::{
    extract::State,
    http::HeaderMap,
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use validator::Validate;

use crate::{
    auth::{extractor::AuthUser, jwt, password},
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Debug, Deserialize, Validate)]
pub struct RegisterRequest {
    #[validate(email)]
    pub email: String,
    #[validate(length(min = 8))]
    pub password: String,
    /// 알림톡/푸시 personalization 에 사용 — 필수. 1~20자.
    #[validate(length(min = 1, max = 20))]
    pub display_name: String,
    pub phone:    String,                  // 휴대폰 (digits-only 또는 dash 포함)
    pub otp_code: String,                  // 4자리 인증번호 (send-otp 후 받은 값)
}

#[derive(Debug, Deserialize, Validate)]
pub struct LoginRequest {
    #[validate(email)]
    pub email: String,
    pub password: String,
    /// "로그인 기억하기" — true 면 30일 (기본 정책 jwt_refresh_ttl_days),
    /// false 면 짧은 세션 (1일). 미전송 시 false 로 간주.
    #[serde(default)]
    pub remember_me: bool,
}

/// remember_me 에 따른 refresh TTL 산정.
/// remember_me=true → config.jwt_refresh_ttl_days (운영 default 30일)
/// remember_me=false → 1일 (브라우저 닫으면 어차피 sessionStorage 에서 사라지지만 백엔드도 만료시킴)
fn refresh_ttl_for(state: &AppState, remember_me: bool) -> i64 {
    if remember_me { state.config.jwt_refresh_ttl_days } else { 1 }
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: &'static str,
    pub expires_in: i64, // access TTL in seconds
    pub user_id: i64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/register",  post(register))
        .route("/auth/send-otp",  post(send_otp))
        .route("/auth/login", post(login))
        .route("/auth/refresh", post(refresh))
        .route("/auth/fcm-token", post(register_fcm_token))
        .route("/auth/fcm-token/revoke", post(unregister_fcm_token))
        .route("/auth/ping", get(|| async { "pong" }))
        // 아이디 찾기 (2-step: phone OTP → 결과)
        .route("/auth/find-id/send-otp", post(find_id_send_otp))
        .route("/auth/find-id/verify",   post(find_id_verify))
        // 비밀번호 재설정 (email + phone OTP → reset)
        .route("/auth/password-reset/send-otp", post(reset_send_otp))
        .route("/auth/password-reset/verify", post(reset_verify))
        // ── Phase A: 사용자 프로필
        .route("/auth/me", get(me).patch(update_me))
        .route("/auth/me/password", post(change_password))
        .route("/auth/me/cleanup", post(cleanup_me))
        .route("/auth/me", delete(delete_me))
        // 사용자 UI 환경설정 (filter_device_id 등) — JSONB top-level 병합
        .route("/auth/me/prefs", get(get_prefs).patch(patch_prefs))
}

pub async fn get_prefs(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT prefs FROM users WHERE id = $1",
    )
    .bind(user.user_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(row.unwrap_or_else(|| serde_json::json!({}))))
}

pub async fn patch_prefs(
    State(state): State<AppState>,
    user: AuthUser,
    Json(patch): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    if !patch.is_object() {
        return Err(crate::error::AppError::BadRequest("body must be a JSON object".into()));
    }
    sqlx::query(
        "UPDATE users SET prefs = COALESCE(prefs, '{}'::jsonb) || $2::jsonb WHERE id = $1",
    )
    .bind(user.user_id)
    .bind(&patch)
    .execute(&state.db)
    .await?;
    get_prefs(State(state), user).await
}

// ===========================================================================
// /auth/me — 프로필 조회 / 수정 / 비번 변경 / 회원탈퇴
// ===========================================================================

#[derive(Debug, Serialize, FromRow)]
pub struct MeResponse {
    pub id:              i64,
    pub email:           String,
    pub display_name:    Option<String>,
    pub phone:           String,           // OTP 인증된 가입 번호 (NOT NULL — 마이그레이션 0024)
    pub phone_verified:  bool,
    pub secondary_phone: Option<String>,
    pub role:            String,
    pub created_at:      DateTime<Utc>,
}

pub async fn me(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<MeResponse>> {
    let row: MeResponse = sqlx::query_as(
        r#"SELECT id, email, display_name, phone, phone_verified, secondary_phone, role, created_at
             FROM users WHERE id = $1"#,
    )
    .bind(user.user_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct UpdateMeRequest {
    pub display_name:    Option<String>,
    pub secondary_phone: Option<String>,
}

pub async fn update_me(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<UpdateMeRequest>,
) -> AppResult<Json<MeResponse>> {
    // COALESCE: 보낸 필드만 갱신, 안 보낸 건 그대로
    sqlx::query(
        r#"UPDATE users
              SET display_name    = COALESCE($2, display_name),
                  secondary_phone = COALESCE($3, secondary_phone)
            WHERE id = $1"#,
    )
    .bind(user.user_id)
    .bind(&req.display_name)
    .bind(&req.secondary_phone)
    .execute(&state.db)
    .await?;
    me(State(state), user).await
}

#[derive(Debug, Deserialize, Validate)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    #[validate(length(min = 8))]
    pub new_password:     String,
}

pub async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ChangePasswordRequest>,
) -> AppResult<Json<serde_json::Value>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;

    let cur_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
        .bind(user.user_id)
        .fetch_one(&state.db)
        .await?;

    if !password::verify(&req.current_password, &cur_hash) {
        return Err(AppError::Unauthorized);
    }

    let new_hash = password::hash(&req.new_password)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("hash: {e}")))?;

    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user.user_id)
        .bind(&new_hash)
        .execute(&state.db)
        .await?;

    // 보안: 모든 기존 refresh 토큰 무효화 → 다른 세션 강제 로그아웃
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL")
        .bind(user.user_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({"ok": true})))
}

#[derive(Debug, Deserialize)]
pub struct DeleteMeRequest {
    pub password: String,
}

// ─── 마이페이지 일괄 정리 ─────────────────────────────────
//
// 사용자가 한 번 만들었지만 더 이상 안 쓰는 부수 데이터들을 선택적으로 정리.
// 비밀번호로 명시적 인증 후 처리. (delete_me 처럼 강한 확인.)
#[derive(Debug, Deserialize)]
pub struct CleanupRequest {
    pub password: String,
    /// corporate_info row 삭제 (사업자 등록번호 / 회사명 / 주소 / 대표자)
    #[serde(default)]
    pub corporate_info:    bool,
    /// staff (직원 명단) 모두 삭제. 단 trip_annotations.driver_staff_id 는 SET NULL 로 보존.
    #[serde(default)]
    pub staff:             bool,
    /// 보유 디바이스의 account_type_override 모두 NULL — user.account_type 으로 통일
    #[serde(default)]
    pub device_overrides:  bool,
}

pub async fn cleanup_me(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CleanupRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let cur_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
        .bind(user.user_id)
        .fetch_one(&state.db)
        .await?;
    if !password::verify(&req.password, &cur_hash) {
        return Err(AppError::Unauthorized);
    }

    let mut tx = state.db.begin().await?;
    let mut summary = serde_json::Map::new();

    if req.corporate_info {
        let r = sqlx::query("DELETE FROM corporate_info WHERE user_id = $1")
            .bind(user.user_id).execute(&mut *tx).await?;
        summary.insert("corporate_info_deleted".into(), r.rows_affected().into());
    }

    if req.staff {
        // staff_id 가 trip_annotations 에 박혀있을 수 있으나 FK 가 ON DELETE SET NULL 이라 안전
        let r = sqlx::query("DELETE FROM staff WHERE user_id = $1")
            .bind(user.user_id).execute(&mut *tx).await?;
        summary.insert("staff_deleted".into(), r.rows_affected().into());
    }

    if req.device_overrides {
        let r = sqlx::query(
            "UPDATE devices SET account_type_override = NULL WHERE owner_id = $1 AND account_type_override IS NOT NULL",
        )
        .bind(user.user_id).execute(&mut *tx).await?;
        summary.insert("device_overrides_cleared".into(), r.rows_affected().into());
    }

    tx.commit().await?;
    Ok(Json(serde_json::Value::Object(summary)))
}

pub async fn delete_me(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<DeleteMeRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let cur_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
        .bind(user.user_id)
        .fetch_one(&state.db)
        .await?;

    if !password::verify(&req.password, &cur_hash) {
        return Err(AppError::Unauthorized);
    }

    let mut tx = state.db.begin().await?;

    // 1) 보유 device 의 user-specific 메타 reset — unpair 와 동일 효과.
    //    devices.owner_id 는 어차피 FK ON DELETE SET NULL 이지만, 그것만으론 display_name /
    //    color / paired_at / last_lat 같은 이전 사용자 흔적이 device row 에 남음 → 다른 사용자
    //    페어링 시 잠시 노출 가능. 명시적으로 NULL 처리.
    sqlx::query(
        r#"UPDATE devices
              SET display_name          = NULL,
                  color                 = NULL,
                  paired_at             = NULL,
                  last_seen_at          = NULL,
                  last_lat              = NULL,
                  last_lng              = NULL,
                  last_fix_at           = NULL,
                  account_type_override = NULL
            WHERE owner_id = $1"#,
    )
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?;

    // 2) users row 삭제 — FK CASCADE/SET NULL 이 부수 처리:
    //    - CASCADE: refresh_tokens, fcm_tokens, share_tokens, geofences, notification_settings,
    //      credit_log, payment_orders, ai_analyses, ai_usage_log, sim_topup_requests, chat_threads,
    //      corporate_info, staff, subscriptions, user_phones — 즉시 row 삭제
    //    - SET NULL: devices.owner_id, location_records.user_id, events.user_id, daily_stats.user_id,
    //      trip_annotations.user_id, chat_messages.sender_id, ...processed_by — row 보존, 익명화
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

#[derive(Debug, Deserialize)]
pub struct FcmTokenRequest {
    pub token: String,
    pub platform: String,            // "android" / "ios"
    pub app_version: Option<String>,
}

pub async fn register_fcm_token(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<FcmTokenRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if req.token.is_empty() {
        return Err(AppError::BadRequest("token is empty".into()));
    }

    // Upsert: same token (UNIQUE) → reassign to this user, mark active.
    sqlx::query(
        r#"
        INSERT INTO fcm_tokens (user_id, token, platform, app_version, active, last_used_at)
        VALUES ($1, $2, $3, $4, TRUE, now())
        ON CONFLICT (token) DO UPDATE
           SET user_id      = EXCLUDED.user_id,
               platform     = EXCLUDED.platform,
               app_version  = EXCLUDED.app_version,
               active       = TRUE,
               last_used_at = now()
        "#,
    )
    .bind(user.user_id)
    .bind(&req.token)
    .bind(&req.platform)
    .bind(&req.app_version)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({"ok": true})))
}

#[derive(Debug, Deserialize)]
pub struct FcmTokenDelete {
    pub token: String,
}

pub async fn unregister_fcm_token(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<FcmTokenDelete>,
) -> AppResult<Json<serde_json::Value>> {
    sqlx::query(
        r#"UPDATE fcm_tokens SET active = FALSE WHERE token = $1 AND user_id = $2"#,
    )
    .bind(&req.token)
    .bind(user.user_id)
    .execute(&state.db)
    .await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

fn hash_refresh(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

async fn issue_pair(state: &AppState, user_id: i64, user_agent: Option<&str>, ttl_days: i64) -> AppResult<TokenPair> {
    let access = jwt::issue_access(user_id, &state.config.jwt_secret, state.config.jwt_access_ttl_min)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("jwt access: {e}")))?;
    let refresh = jwt::issue_refresh(user_id, &state.config.jwt_secret, ttl_days)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("jwt refresh: {e}")))?;

    let token_hash = hash_refresh(&refresh);
    let expires_at = Utc::now() + Duration::days(ttl_days);

    sqlx::query(
        r#"INSERT INTO refresh_tokens (user_id, token_hash, user_agent, expires_at, ttl_days)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(user_id)
    .bind(&token_hash)
    .bind(user_agent)
    .bind(expires_at)
    .bind(ttl_days as i32)
    .execute(&state.db)
    .await?;

    Ok(TokenPair {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: state.config.jwt_access_ttl_min * 60,
        user_id,
    })
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> AppResult<Json<TokenPair>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;

    // 1) 휴대폰 정규화 + OTP 검증
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호를 입력하세요".into()))?;

    // OTP 검증 + 소모 (constant-time + atomic — auth/otp.rs)
    crate::auth::otp::verify_and_consume(&state.db, &phone, &["register"], &req.otp_code).await?;

    // 휴대폰 글로벌 중복 차단 없음 — 0027 정책 (OTP 통과만으로 가입 허용).
    // 단, 메인 보유자 cap (글로벌 3계정) 은 적용. 가입 시 phone 은 자동으로 메인이 되므로.
    crate::routes::phones::assert_main_cap(&state.db, &phone, None).await?;

    // 2) 패스워드 해시
    let pw_hash = password::hash(&req.password)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("hash: {e}")))?;

    // 3) 사용자 생성 (OTP 는 이미 위에서 소모됨)
    let mut tx = state.db.begin().await?;
    let user_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO users (email, password_hash, display_name, phone, phone_verified)
           VALUES ($1, $2, $3, $4, TRUE) RETURNING id"#,
    )
    .bind(&req.email).bind(&pw_hash).bind(&req.display_name).bind(&phone)
    .fetch_one(&mut *tx).await
    .map_err(|e| {
        if let sqlx::Error::Database(db) = &e {
            if db.code().as_deref() == Some("23505") {
                return AppError::Conflict("이미 가입된 이메일 또는 휴대폰입니다".into());
            }
        }
        AppError::Database(e)
    })?;
    tx.commit().await?;

    let ua = headers.get("user-agent").and_then(|v| v.to_str().ok());
    // 가입 직후엔 기본 정책 (30일) — 신규 사용자는 보통 계속 로그인 유지 원함.
    let pair = issue_pair(&state, user_id, ua, state.config.jwt_refresh_ttl_days).await?;

    // 환영 알림톡 발송 (fire-and-forget) — 발송 실패해도 가입 자체는 성공 응답.
    // Bizm 응답 지연 또는 네트워크 이슈가 가입 흐름을 막지 않도록 spawn.
    let phone_for_at = phone.clone();
    let name_for_at = req.display_name.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::services::alimtalk::send_signup_welcome(&phone_for_at, &name_for_at).await {
            tracing::warn!(phone = %phone_for_at, "signup welcome alimtalk failed: {e:#}");
        }
    });

    Ok(Json(pair))
}

// ─── OTP 발송 ──────────────────────────────────────────
//
// 회원가입 단계에서 호출. 동일 휴대폰 5회/일 발송 제한.
// 코드는 4자리, 3분 만료. consumed_at 마킹 전까진 유효.
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
    /// SMS_DEV_MODE=1 일 때만 — 실 운영에선 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev_code: Option<String>,
}

pub async fn send_otp(
    State(state): State<AppState>,
    Json(req): Json<SendOtpRequest>,
) -> AppResult<Json<SendOtpResponse>> {
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호를 입력하세요".into()))?;

    // 같은 휴대폰 24h 내 5회 제한
    let today_count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM otp_codes
            WHERE phone = $1 AND created_at > NOW() - INTERVAL '24 hours'"#,
    )
    .bind(&phone).fetch_one(&state.db).await?;
    if today_count >= 5 {
        return Err(AppError::BadRequest("하루 발송 횟수(5회)를 초과했습니다. 내일 다시 시도해주세요".into()));
    }

    // 글로벌 중복 차단 없음 — 0027 정책.

    let code = crate::services::sms::generate_code();
    let expires = Utc::now() + Duration::minutes(3);

    sqlx::query(
        r#"INSERT INTO otp_codes (phone, code, purpose, expires_at)
           VALUES ($1, $2, 'register', $3)"#,
    )
    .bind(&phone).bind(&code).bind(expires)
    .execute(&state.db).await?;

    // 실 발송 — 실패해도 row 는 남음. 사용자가 재시도하면 다른 row 가 latest 가 됨.
    if let Err(e) = crate::services::sms::send_otp(&phone, &code).await {
        tracing::warn!(%phone, "sms send failed: {e:#}");
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

// [2026-08-14] 로그인 brute-force 방어 임계 (15분 창).
const LOGIN_WINDOW_MIN: i64 = 15;
const LOGIN_MAX_PER_EMAIL: i64 = 10;   // 이메일당 실패 상한
const LOGIN_MAX_PER_IP: i64 = 30;      // IP당 실패 상한 (여러 이메일 스프레이 차단)

fn client_ip(headers: &HeaderMap) -> String {
    headers.get("x-real-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        // x-forwarded-for 는 "client, proxy1, ..." 형식일 수 있어 첫 항목만.
        .map(|s| s.split(',').next().unwrap_or(s).trim().to_string())
        .unwrap_or_else(|| "unknown".into())
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<TokenPair>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;
    let ip = client_ip(&headers);

    // ── rate limit: 최근 15분 실패 횟수로 잠금 (이메일 단위 + IP 단위) ──
    let email_fails: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM login_attempts
            WHERE email = $1 AND success = FALSE
              AND created_at > NOW() - ($2 || ' minutes')::interval"#,
    )
    .bind(&req.email).bind(LOGIN_WINDOW_MIN.to_string())
    .fetch_one(&state.db).await?;
    let ip_fails: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM login_attempts
            WHERE ip = $1 AND success = FALSE
              AND created_at > NOW() - ($2 || ' minutes')::interval"#,
    )
    .bind(&ip).bind(LOGIN_WINDOW_MIN.to_string())
    .fetch_one(&state.db).await?;
    if email_fails >= LOGIN_MAX_PER_EMAIL || ip_fails >= LOGIN_MAX_PER_IP {
        tracing::warn!(email = %req.email, %ip, email_fails, ip_fails, "login locked (rate limit)");
        return Err(AppError::TooManyRequests(
            format!("로그인 시도가 너무 많습니다. {LOGIN_WINDOW_MIN}분 후 다시 시도해주세요.")
        ));
    }

    let row: Option<(i64, String)> = sqlx::query_as(
        r#"SELECT id, password_hash FROM users WHERE email = $1"#,
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await?;

    // 실패(계정 없음 / 비번 불일치) 는 동일하게 기록 + 동일 에러 → enumeration·잠금 우회 방지.
    let ok = match &row {
        Some((_, pw_hash)) => password::verify(&req.password, pw_hash),
        None => false,
    };
    if !ok {
        let _ = sqlx::query(
            "INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, FALSE)",
        ).bind(&req.email).bind(&ip).execute(&state.db).await;
        return Err(AppError::Unauthorized);
    }
    let user_id = row.unwrap().0;

    // 성공 → 이 이메일의 실패 기록 소거(즉시 잠금 해제) + 성공 기록.
    let _ = sqlx::query("DELETE FROM login_attempts WHERE email = $1 AND success = FALSE")
        .bind(&req.email).execute(&state.db).await;
    let _ = sqlx::query("INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, TRUE)")
        .bind(&req.email).bind(&ip).execute(&state.db).await;

    let ua = headers.get("user-agent").and_then(|v| v.to_str().ok());
    let ttl_days = refresh_ttl_for(&state, req.remember_me);
    let pair = issue_pair(&state, user_id, ua, ttl_days).await?;
    Ok(Json(pair))
}

pub async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RefreshRequest>,
) -> AppResult<Json<TokenPair>> {
    let claims = jwt::verify(&req.refresh_token, &state.config.jwt_secret, "refresh")
        .map_err(|_| AppError::Unauthorized)?;
    let user_id: i64 = claims.sub.parse().map_err(|_| AppError::Unauthorized)?;

    let token_hash = hash_refresh(&req.refresh_token);

    // 회전: DB에 살아있는 행을 revoke 처리. 0건이면 인증 실패.
    // RETURNING ttl_days 로 원래 세션 정책 (remember_me 여부) 을 새 토큰에 propagate.
    let row: Option<i32> = sqlx::query_scalar(
        r#"UPDATE refresh_tokens
              SET revoked_at = now()
            WHERE token_hash = $1
              AND user_id    = $2
              AND revoked_at IS NULL
              AND expires_at > now()
        RETURNING ttl_days"#,
    )
    .bind(&token_hash)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let ttl_days = match row {
        Some(d) => d as i64,
        None    => return Err(AppError::Unauthorized),
    };

    let ua = headers.get("user-agent").and_then(|v| v.to_str().ok());
    let pair = issue_pair(&state, user_id, ua, ttl_days).await?;
    Ok(Json(pair))
}

// ===========================================================================
// 아이디 찾기 / 비밀번호 재설정
// ===========================================================================

#[derive(Debug, Deserialize)]
pub struct FindIdSendOtpRequest {
    pub phone: String,
}

#[derive(Debug, Serialize)]
pub struct FindIdSendOtpResponse {
    pub ok: bool,
    pub expires_in_sec: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FindIdVerifyRequest {
    pub phone:    String,
    pub otp_code: String,
}

#[derive(Debug, Serialize)]
pub struct FindIdAccount {
    pub email_masked: String,
    pub created_at:   DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct FindIdVerifyResponse {
    pub accounts: Vec<FindIdAccount>,
}

fn mask_email(email: &str) -> String {
    // ab***@naver.com — local 첫 2자만 노출, 나머지 ***
    if let Some(at) = email.find('@') {
        let (local, domain) = email.split_at(at);
        let visible = local.chars().take(2).collect::<String>();
        format!("{visible}***{domain}")
    } else {
        "***".into()
    }
}

// ─── 아이디 찾기 step1: phone OTP 발송 ──────────────────
pub async fn find_id_send_otp(
    State(state): State<AppState>,
    Json(req): Json<FindIdSendOtpRequest>,
) -> AppResult<Json<FindIdSendOtpResponse>> {
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호를 입력하세요".into()))?;

    // 24h 5회 제한 (otp_codes 공유)
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM otp_codes WHERE phone = $1 AND created_at > NOW() - INTERVAL '24 hours'",
    ).bind(&phone).fetch_one(&state.db).await?;
    if today_count >= 5 {
        return Err(AppError::BadRequest("하루 발송 횟수(5회)를 초과했습니다".into()));
    }

    let code = crate::services::sms::generate_code();
    let expires = Utc::now() + Duration::minutes(3);
    sqlx::query(
        "INSERT INTO otp_codes (phone, code, purpose, expires_at) VALUES ($1, $2, 'find_id', $3)",
    ).bind(&phone).bind(&code).bind(expires).execute(&state.db).await?;

    if let Err(e) = crate::services::sms::send_otp(&phone, &code).await {
        tracing::warn!(%phone, "find_id send-otp failed: {e:#}");
        return Err(AppError::Internal(anyhow::anyhow!("SMS 발송 실패: {e}")));
    }

    let dev_code = if std::env::var("SMS_DEV_MODE").ok().as_deref() == Some("1") {
        Some(code.clone())
    } else { None };
    Ok(Json(FindIdSendOtpResponse { ok: true, expires_in_sec: 180, dev_code }))
}

// ─── 아이디 찾기 step2: OTP 검증 + 메인 보유자 (≤3) 반환 ─
//
// 정책: 메인(is_primary=TRUE) 으로 이 번호를 가진 계정만 노출. 서브는 노출하지 않음.
// 메인 cap=3 이므로 결과는 0~3 개.
pub async fn find_id_verify(
    State(state): State<AppState>,
    Json(req): Json<FindIdVerifyRequest>,
) -> AppResult<Json<FindIdVerifyResponse>> {
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호".into()))?;

    crate::auth::otp::verify_and_consume(&state.db, &phone, &["find_id"], &req.otp_code).await?;

    // 메인 보유자만 (is_primary=TRUE & is_verified=TRUE).
    // user_phones 가 없는 legacy 사용자 fallback 으로 users.phone 도 union.
    let rows: Vec<(String, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT DISTINCT u.email, u.created_at
          FROM users u
         WHERE u.id IN (
              SELECT user_id FROM user_phones
                WHERE phone = $1 AND is_primary = TRUE AND is_verified = TRUE
              UNION
              SELECT id FROM users
                WHERE phone = $1 AND phone_verified = TRUE
                  AND NOT EXISTS (SELECT 1 FROM user_phones p WHERE p.user_id = users.id)
         )
         ORDER BY u.created_at ASC
         LIMIT 3
        "#,
    ).bind(&phone).fetch_all(&state.db).await?;

    let accounts = rows.into_iter()
        .map(|(email, created_at)| FindIdAccount { email_masked: mask_email(&email), created_at })
        .collect();
    Ok(Json(FindIdVerifyResponse { accounts }))
}

#[derive(Debug, Deserialize)]
pub struct ResetSendOtpRequest {
    pub email: String,
    pub phone: String,
}

#[derive(Debug, Serialize)]
pub struct ResetSendOtpResponse {
    pub ok: bool,
    pub expires_in_sec: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev_code: Option<String>,
}

// 비밀번호 재설정 OTP 발송.
// (email, phone) 두 값이 모두 일치하는 사용자가 있어야 발송됨.
// phone 은 메인/서브 무관 — user_phones 의 인증된 행 또는 users.phone(legacy) 매칭.
pub async fn reset_send_otp(
    State(state): State<AppState>,
    Json(req): Json<ResetSendOtpRequest>,
) -> AppResult<Json<ResetSendOtpResponse>> {
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호를 입력하세요".into()))?;

    let user_id: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT u.id FROM users u
         WHERE u.email = $1
           AND (
                EXISTS (SELECT 1 FROM user_phones p
                         WHERE p.user_id = u.id AND p.phone = $2 AND p.is_verified = TRUE)
             OR (u.phone = $2 AND u.phone_verified = TRUE)
           )
        "#,
    )
    .bind(&req.email)
    .bind(&phone)
    .fetch_optional(&state.db)
    .await?;

    if user_id.is_none() {
        // 정보 노출 줄이기 위해 동일 메시지 — 단, 같이 SMS 안 보냄.
        return Err(AppError::BadRequest("일치하는 계정을 찾을 수 없습니다".into()));
    }

    // 24h 5회 제한 (otp_codes 공유 카운트)
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM otp_codes WHERE phone = $1 AND created_at > NOW() - INTERVAL '24 hours'",
    ).bind(&phone).fetch_one(&state.db).await?;
    if today_count >= 5 {
        return Err(AppError::BadRequest("하루 발송 횟수(5회)를 초과했습니다".into()));
    }

    let code = crate::services::sms::generate_code();
    let expires = Utc::now() + Duration::minutes(3);
    sqlx::query(
        "INSERT INTO otp_codes (phone, code, purpose, expires_at) VALUES ($1, $2, 'reset', $3)",
    ).bind(&phone).bind(&code).bind(expires).execute(&state.db).await?;

    if let Err(e) = crate::services::sms::send_otp(&phone, &code).await {
        tracing::warn!(%phone, "reset send-otp failed: {e:#}");
        return Err(AppError::Internal(anyhow::anyhow!("SMS 발송 실패: {e}")));
    }

    let dev_code = if std::env::var("SMS_DEV_MODE").ok().as_deref() == Some("1") {
        Some(code.clone())
    } else { None };

    Ok(Json(ResetSendOtpResponse { ok: true, expires_in_sec: 180, dev_code }))
}

#[derive(Debug, Deserialize, Validate)]
pub struct ResetVerifyRequest {
    pub email:    String,
    pub phone:    String,
    pub otp_code: String,
    #[validate(length(min = 8))]
    pub new_password: String,
}

#[derive(Debug, Serialize)]
pub struct ResetVerifyResponse {
    pub ok: bool,
}

pub async fn reset_verify(
    State(state): State<AppState>,
    Json(req): Json<ResetVerifyRequest>,
) -> AppResult<Json<ResetVerifyResponse>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;
    let phone = crate::services::sms::normalize_phone(&req.phone)
        .ok_or_else(|| AppError::BadRequest("올바른 휴대폰 번호".into()))?;

    // (email, phone) 매칭되는 user 확인 (재확인)
    let user_id: i64 = sqlx::query_scalar(
        r#"
        SELECT u.id FROM users u
         WHERE u.email = $1
           AND (
                EXISTS (SELECT 1 FROM user_phones p
                         WHERE p.user_id = u.id AND p.phone = $2 AND p.is_verified = TRUE)
             OR (u.phone = $2 AND u.phone_verified = TRUE)
           )
        "#,
    )
    .bind(&req.email).bind(&phone)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| AppError::BadRequest("일치하는 계정을 찾을 수 없습니다".into()))?;

    // OTP 검증 + 소모 (atomic + constant-time)
    crate::auth::otp::verify_and_consume(&state.db, &phone, &["reset"], &req.otp_code).await?;

    let new_hash = password::hash(&req.new_password)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("hash: {e}")))?;

    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user_id).bind(&new_hash).execute(&mut *tx).await?;
    // 모든 refresh 무효화 (보안)
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL")
        .bind(user_id).execute(&mut *tx).await?;
    tx.commit().await?;

    Ok(Json(ResetVerifyResponse { ok: true }))
}
