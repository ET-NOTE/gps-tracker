// /api/v1/devices/:id/shares  (auth)  + /share/:token (public)
//
// 공유 토큰 — 1회 생성, TTL 동안 read-only 위치 조회 허용.
// 받는 쪽은 로그인 없이 토큰만으로 접근.

use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use validator::Validate;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    services::credits,
    state::AppState,
};

// 공유 링크 1시간당 차감 포인트.
// 24h = 120, 7일 = 840, 30일 = 3,600. AI(20/회), SIM 100MB(100원) 와 형평.
pub const CREDITS_PER_HOUR: i64 = 5;
pub const MAX_TTL_HOURS:    i64 = 720;   // 30일

pub fn router_authed() -> Router<AppState> {
    Router::new()
        .route("/devices/:id/shares", get(list_shares).post(create_share))
        .route("/shares/:share_id", delete(revoke_share))
        .route("/shares/:share_id/extend", post(extend_share))
}

pub fn router_public() -> Router<AppState> {
    Router::new()
        .route("/share/:token",              get(public_view))
        .route("/share/:token/locations",    get(public_locations))
        .route("/share/:token/daily_stats",  get(public_daily_stats))
}

// ==========================================================================
// Authed: 공유 링크 생성/조회/철회
// ==========================================================================

#[derive(Debug, Deserialize, Validate)]
pub struct CreateShareRequest {
    /// 만료까지 시간 (단위: hour). 기본 24, 최대 720(=30일).
    #[validate(range(min = 1, max = 720))]
    pub ttl_hours: Option<i64>,
    #[validate(length(max = 200))]
    pub note: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ShareView {
    pub id: i64,
    pub token: String,
    pub device_id: i64,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub view_count: i32,
    pub last_viewed_at: Option<DateTime<Utc>>,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub credits_spent: i32,
}

async fn create_share(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    Json(req): Json<CreateShareRequest>,
) -> AppResult<Json<ShareView>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;

    // 본인 소유 확인
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
        .bind(device_id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }

    let ttl = req.ttl_hours.unwrap_or(24);
    let cost = ttl * CREDITS_PER_HOUR;

    // 포인트 먼저 차감 — 부족하면 BadRequest 로 실패. 토큰 미생성.
    credits::charge(
        &state.db, user.user_id, cost,
        "share_create", Some(device_id),
        Some(&format!("share token, {ttl}h")),
    ).await?;

    let expires_at = Utc::now() + Duration::hours(ttl);
    let token = generate_token();

    let row: ShareView = sqlx::query_as(
        r#"INSERT INTO share_tokens (token, device_id, created_by, expires_at, note, credits_spent)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, token, device_id, expires_at, revoked_at,
                     view_count, last_viewed_at, note, created_at, credits_spent"#,
    )
    .bind(&token)
    .bind(device_id)
    .bind(user.user_id)
    .bind(expires_at)
    .bind(&req.note)
    .bind(cost as i32)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

#[derive(Debug, Deserialize, Validate)]
pub struct ExtendShareRequest {
    /// 추가할 시간 (단위: hour). 1 ~ 720, 단 expires_at 가 (지금 + 30일) 이내여야 함.
    #[validate(range(min = 1, max = 720))]
    pub extra_hours: i64,
}

async fn extend_share(
    State(state): State<AppState>,
    user: AuthUser,
    Path(share_id): Path<i64>,
    Json(req): Json<ExtendShareRequest>,
) -> AppResult<Json<ShareView>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;

    // 본인 디바이스의 (revoke 안 된) 토큰만
    let cur: Option<(i64, DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT s.id, s.expires_at
             FROM share_tokens s
             JOIN devices d ON d.id = s.device_id
            WHERE s.id = $1 AND d.owner_id = $2 AND s.revoked_at IS NULL"#,
    ).bind(share_id).bind(user.user_id)
    .fetch_optional(&state.db).await?;
    let (_, cur_expires) = cur.ok_or(AppError::NotFound)?;

    // 만료된 링크는 연장 불가 (revoke 와 사실상 동일 처리; 새로 만드세요).
    if cur_expires < Utc::now() {
        return Err(AppError::BadRequest("이미 만료된 링크입니다 — 새 링크를 생성하세요.".into()));
    }
    // 누적 만료 30일 cap
    let new_expires = cur_expires + Duration::hours(req.extra_hours);
    let max_expires = Utc::now() + Duration::hours(MAX_TTL_HOURS);
    if new_expires > max_expires {
        return Err(AppError::BadRequest(format!(
            "총 만료까지 {MAX_TTL_HOURS}시간(30일) 을 넘을 수 없습니다."
        )));
    }

    let cost = req.extra_hours * CREDITS_PER_HOUR;
    credits::charge(
        &state.db, user.user_id, cost,
        "share_extend", Some(share_id),
        Some(&format!("share extend +{}h", req.extra_hours)),
    ).await?;

    let row: ShareView = sqlx::query_as(
        r#"UPDATE share_tokens
              SET expires_at    = $2,
                  credits_spent = credits_spent + $3
            WHERE id = $1
        RETURNING id, token, device_id, expires_at, revoked_at,
                  view_count, last_viewed_at, note, created_at, credits_spent"#,
    )
    .bind(share_id)
    .bind(new_expires)
    .bind(cost as i32)
    .fetch_one(&state.db).await?;

    Ok(Json(row))
}

async fn list_shares(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
) -> AppResult<Json<Vec<ShareView>>> {
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
        .bind(device_id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }

    let rows = sqlx::query_as::<_, ShareView>(
        r#"SELECT id, token, device_id, expires_at, revoked_at,
                  view_count, last_viewed_at, note, created_at, credits_spent
             FROM share_tokens
            WHERE device_id = $1
            ORDER BY created_at DESC
            LIMIT 50"#,
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn revoke_share(
    State(state): State<AppState>,
    user: AuthUser,
    Path(share_id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    // 본인 디바이스의 토큰만 철회 가능
    let res = sqlx::query(
        r#"UPDATE share_tokens
              SET revoked_at = now()
            WHERE id = $1
              AND revoked_at IS NULL
              AND device_id IN (SELECT id FROM devices WHERE owner_id = $2)"#,
    )
    .bind(share_id)
    .bind(user.user_id)
    .execute(&state.db)
    .await?;

    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ==========================================================================
// Public: 토큰으로 위치 조회 (인증 없음)
// ==========================================================================

#[derive(Debug, Serialize)]
pub struct PublicShareView {
    pub device_name: Option<String>,
    pub device_color: Option<String>,
    pub device_icon: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub last_lat: Option<f64>,
    pub last_lng: Option<f64>,
    pub expires_at: DateTime<Utc>,
    pub note: Option<String>,
}

async fn public_view(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<Json<PublicShareView>> {
    let (device_id, expires_at, note) = resolve_token(&state, &token).await?;

    let row: Option<(Option<String>, Option<String>, Option<String>,
                     Option<DateTime<Utc>>, Option<f64>, Option<f64>)> = sqlx::query_as(
        r#"SELECT display_name, color, icon, last_seen_at, last_lat, last_lng
             FROM devices WHERE id = $1"#,
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let (name, color, icon, last_seen, last_lat, last_lng) = row.ok_or(AppError::NotFound)?;

    // view_count 증가 (best-effort)
    let _ = sqlx::query(
        r#"UPDATE share_tokens
              SET view_count = view_count + 1, last_viewed_at = now()
            WHERE token = $1"#,
    )
    .bind(&token)
    .execute(&state.db)
    .await;

    Ok(Json(PublicShareView {
        device_name: name,
        device_color: color,
        device_icon: icon,
        last_seen_at: last_seen,
        last_lat,
        last_lng,
        expires_at,
        note,
    }))
}

#[derive(Debug, Deserialize)]
pub struct PublicLocQuery {
    pub limit:    Option<i64>,
    pub since:    Option<DateTime<Utc>>,
    pub until:    Option<DateTime<Utc>>,
    pub fix_only: Option<bool>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PublicLocationRow {
    pub recorded_at: DateTime<Utc>,
    pub fix:         bool,
    pub lat:         Option<f64>,
    pub lng:         Option<f64>,
}

async fn public_locations(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<PublicLocQuery>,
) -> AppResult<Json<Vec<PublicLocationRow>>> {
    let (device_id, _, _) = resolve_token(&state, &token).await?;
    // 10000 까지 허용 — 하루치 활발한 디바이스 (~5초당 1 fix) 도 다 받게.
    let limit = q.limit.unwrap_or(500).clamp(1, 10000);

    let rows = sqlx::query_as::<_, PublicLocationRow>(
        r#"SELECT recorded_at, fix, lat, lng
             FROM location_records
            WHERE device_id = $1
              AND ($2::timestamptz IS NULL OR recorded_at >= $2)
              AND ($3::timestamptz IS NULL OR recorded_at <= $3)
              AND ($4::bool        IS NULL OR fix = $4)
            ORDER BY recorded_at DESC
            LIMIT $5"#,
    )
    .bind(device_id)
    .bind(q.since)
    .bind(q.until)
    .bind(q.fix_only)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct PublicStatsQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PublicDayRow {
    pub date:      chrono::NaiveDate,
    pub fix_count: i32,
}

// 공유 토큰의 디바이스에 대해 일별 fix 카운트. 시커 날짜 리스트용.
async fn public_daily_stats(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<PublicStatsQuery>,
) -> AppResult<Json<Vec<PublicDayRow>>> {
    let (device_id, _, _) = resolve_token(&state, &token).await?;
    let limit = q.limit.unwrap_or(30).clamp(1, 90);

    let rows = sqlx::query_as::<_, PublicDayRow>(
        r#"SELECT date, fix_count
             FROM daily_stats
            WHERE device_id = $1 AND fix_count > 0
            ORDER BY date DESC
            LIMIT $2"#,
    )
    .bind(device_id).bind(limit)
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ==========================================================================
// Helpers
// ==========================================================================

async fn resolve_token(
    state: &AppState,
    token: &str,
) -> AppResult<(i64, DateTime<Utc>, Option<String>)> {
    let row: Option<(i64, DateTime<Utc>, Option<DateTime<Utc>>, Option<String>)> =
        sqlx::query_as(
            r#"SELECT device_id, expires_at, revoked_at, note
                 FROM share_tokens
                WHERE token = $1"#,
        )
        .bind(token)
        .fetch_optional(&state.db)
        .await?;

    let (device_id, expires_at, revoked_at, note) = row.ok_or(AppError::NotFound)?;
    if revoked_at.is_some() {
        return Err(AppError::Forbidden);
    }
    if expires_at < Utc::now() {
        return Err(AppError::Forbidden);
    }
    Ok((device_id, expires_at, note))
}

fn generate_token() -> String {
    // 32 byte random → URL-safe base64 (without padding) ≈ 43 chars
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    url_safe_base64(&buf)
}

fn url_safe_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        buf = (buf << 8) | (b as u32);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            let idx = ((buf >> bits) & 0x3F) as usize;
            out.push(ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buf << (6 - bits)) & 0x3F) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out
}
