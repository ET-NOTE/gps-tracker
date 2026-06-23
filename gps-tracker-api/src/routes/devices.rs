// /api/v1/devices/* — Phase 1 페어링 (사용자가 device_uid 직접 입력)
//
// Phase 2 (TODO): SIM7080G ICCID/IMSI/IMEI 기반 자동 페어링.

use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use validator::Validate;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Debug, Serialize, FromRow)]
pub struct DeviceView {
    pub id: i64,
    pub device_uid: String,
    pub display_name: Option<String>,
    pub color: Option<String>,
    pub icon:  Option<String>,
    pub iccid: Option<String>,
    pub imei:  Option<String>,
    pub imsi:  Option<String>,
    pub hw_version: Option<String>,
    pub fw_version: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub last_lat: Option<f64>,
    pub last_lng: Option<f64>,
    pub last_fix_at: Option<DateTime<Utc>>,
    pub paired_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,

    // Round 4: 마지막 lifecycle 이벤트 (wake/sleep_enter/low_batt/offline 등)
    pub last_event_kind: Option<String>,
    pub last_event_at:   Option<DateTime<Utc>>,
    // 펌웨어 13_1+ stationary 진단 (deep sleep 카운트다운 + GPS drift + LIS 헬스)
    pub last_stationary: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct PairRequest {
    // 둘 중 하나만 있어도 OK. 둘 다 있으면 ICCID 우선.
    #[validate(length(min = 1, max = 128))]
    pub device_uid: Option<String>,
    #[validate(length(min = 8, max = 24))]
    pub iccid: Option<String>,
    /// 단말기 별명 — 알림/푸시 식별용 필수. 1~32자.
    #[validate(length(min = 1, max = 32))]
    pub display_name: String,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateRequest {
    #[validate(length(min = 1, max = 64))]
    pub display_name: Option<String>,
    #[validate(length(min = 1, max = 16))]
    pub color: Option<String>,        // 예: "#e8b4b8"
    #[validate(length(min = 1, max = 32))]
    pub icon:  Option<String>,        // 예: "car", "person", "pet"
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices", get(list))
        .route("/devices/pair", post(pair))
        .route("/devices/:id", get(detail).patch(update).delete(unpair))
        .route("/devices/:id/wipe", post(wipe))                  // 데이터 완전 삭제
        .route("/devices/:id/audit", get(audit_log))             // 감사 로그
        .route("/devices/:id/sim", get(sim_info))                // 1NCE SIM 잔량 (캐시)
        .route("/devices/:id/sim/refresh", post(sim_info_refresh)) // 1NCE 강제 즉시 갱신
        .route("/devices/:id/events", get(events_log))           // 최근 lifecycle 이벤트
        .route("/devices/:id/beep",   post(beep_device))         // 부저 원격 트리거 (현장 식별)
        .route("/devices/:id/range",  delete(delete_range))      // 사이클 단위 range 삭제 (연구소 토글)
}

// ─── 부저 원격 트리거 ──────────────────────────────────────
//
// 현장 검증 시 여러 디바이스 동시 휴대할 때 어느 보드가 어느 단말인지 구분하기 위함.
// UI 버튼 → 이 endpoint → devices.beep_pending = TRUE.
// 다음 ingest 호출 시 응답에 {"cmd":"beep"} 가 실려 가고, 펌웨어가 받자마자 부저.
//
// owner 만 호출 가능 (admin 은 impersonate 후 사용). 멱등 — 이미 pending 이어도 다시 set 만.
async fn beep_device(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    // 소유권 확인 + atomic set (한 쿼리)
    let updated: Option<(i64,)> = sqlx::query_as(
        r#"UPDATE devices
              SET beep_pending      = TRUE,
                  beep_requested_at = NOW()
            WHERE id = $1 AND owner_id = $2
        RETURNING id"#,
    )
    .bind(id).bind(user.user_id)
    .fetch_optional(&state.db).await?;

    if updated.is_none() {
        return Err(AppError::NotFound);
    }

    Ok(Json(json!({
        "ok": true,
        "device_id": id,
        "note": "다음 ingest (보통 15초 이내) 시 디바이스 부저 울림"
    })))
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<DeviceView>>> {
    let rows = sqlx::query_as::<_, DeviceView>(
        r#"SELECT d.id, d.device_uid, d.display_name, d.color, d.icon,
                  d.iccid, d.imei, d.imsi, d.hw_version, d.fw_version,
                  d.last_seen_at, d.last_lat, d.last_lng, d.last_fix_at,
                  d.paired_at, d.created_at, d.last_stationary,
                  le.kind        AS last_event_kind,
                  le.occurred_at AS last_event_at
             FROM devices d
        LEFT JOIN LATERAL (
                  SELECT kind, occurred_at
                    FROM events
                   WHERE device_id = d.id AND user_id = $1
                ORDER BY occurred_at DESC
                   LIMIT 1
             ) le ON TRUE
            WHERE d.owner_id = $1
            ORDER BY COALESCE(d.last_seen_at, d.created_at) DESC"#,
    )
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn pair(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<PairRequest>,
) -> AppResult<Json<DeviceView>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;
    if req.device_uid.is_none() && req.iccid.is_none() {
        return Err(AppError::BadRequest("device_uid or iccid required".into()));
    }

    // 조회 우선순위: ICCID → device_uid (둘 다 있으면 ICCID 우선).
    //
    // ICCID 표기 양면: 1NCE canonical = 19자리, SIM 인쇄/AT+CCID = 20자리 (끝 1자리 Luhn).
    // 사용자가 OLED 보고 입력한 끝 8자리는 보통 19자리 기준 (1NCE) 이지만 SIM 표면 인쇄
    // 기준일 수도 있어 양쪽 다 매칭. stored iccid 가 20자리면 LEFT(iccid, len-1) 로 19자리화
    // 비교 → 어느 쪽이든 안전하게 잡힘.
    let row: Option<(i64, Option<i64>)> = if let Some(iccid) = req.iccid.as_deref() {
        if iccid.len() >= 18 {
            // 정확히 일치 (19/20 양쪽 모두) — 입력 길이가 19면 stored 20자리에 prefix 매칭.
            sqlx::query_as(
                "SELECT id, owner_id FROM devices \
                  WHERE iccid = $1 \
                     OR LEFT(iccid, GREATEST(LENGTH(iccid)-1, 0)) = $1 \
                     OR iccid = LEFT($1, GREATEST(LENGTH($1)-1, 0))",
            )
            .bind(iccid).fetch_optional(&state.db).await?
        } else {
            // suffix 매칭 — 짧은 입력 (보통 끝 8자리)
            let pattern = format!("%{iccid}");
            let rows: Vec<(i64, Option<i64>)> = sqlx::query_as(
                "SELECT id, owner_id FROM devices \
                  WHERE iccid LIKE $1 \
                     OR LEFT(iccid, GREATEST(LENGTH(iccid)-1, 0)) LIKE $1",
            )
            .bind(&pattern)
            .fetch_all(&state.db)
            .await?;
            if rows.len() > 1 {
                return Err(AppError::BadRequest(format!(
                    "ambiguous ICCID suffix — {} devices match. Enter more digits.",
                    rows.len()
                )));
            }
            rows.into_iter().next()
        }
    } else if let Some(uid) = req.device_uid.as_deref() {
        sqlx::query_as("SELECT id, owner_id FROM devices WHERE device_uid = $1")
            .bind(uid).fetch_optional(&state.db).await?
    } else {
        None
    };

    let device_id: i64 = match row {
        Some((id, Some(owner))) if owner == user.user_id => {
            // 이미 본인 소유 → 멱등 패치 (display_name 필수라 항상 갱신)
            sqlx::query("UPDATE devices SET display_name = $1 WHERE id = $2")
                .bind(&req.display_name).bind(id).execute(&state.db).await?;
            id
        }
        Some((_, Some(_))) => {
            return Err(AppError::Conflict("device already paired with another account".into()));
        }
        Some((id, None)) => {
            // 익명 행 클레임 — display_name 필수라 무조건 적용
            sqlx::query(
                r#"UPDATE devices
                      SET owner_id = $1,
                          display_name = $2,
                          paired_at = now()
                    WHERE id = $3"#,
            )
            .bind(user.user_id)
            .bind(&req.display_name)
            .bind(id)
            .execute(&state.db)
            .await?;
            log_audit(&state, id, "pair", user.user_id,
                      json!({"via": req.iccid.is_some().then_some("iccid").unwrap_or("device_uid")})).await;
            id
        }
        None => {
            // 새로 생성 (device_uid 가 없으면 ICCID 기반으로 sim-<끝8자리> 자동 생성)
            let uid = req.device_uid.clone().unwrap_or_else(|| {
                let iccid = req.iccid.as_deref().unwrap_or("");
                let n = iccid.len();
                let suffix = if n >= 8 { &iccid[n - 8..] } else { iccid };
                format!("sim-{suffix}")
            });
            sqlx::query_scalar::<_, i64>(
                r#"INSERT INTO devices (device_uid, iccid, owner_id, api_key_hash, display_name, paired_at)
                   VALUES ($1, $2, $3, '', $4, now())
                   RETURNING id"#,
            )
            .bind(&uid)
            .bind(&req.iccid)
            .bind(user.user_id)
            .bind(&req.display_name)
            .fetch_one(&state.db)
            .await?
        }
    };

    fetch_device(&state, device_id, user.user_id).await
}

async fn detail(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<DeviceView>> {
    fetch_device(&state, id, user.user_id).await
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<UpdateRequest>,
) -> AppResult<Json<DeviceView>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;

    let res = sqlx::query(
        r#"UPDATE devices
              SET display_name = COALESCE($1, display_name),
                  color        = COALESCE($2, color),
                  icon         = COALESCE($3, icon)
            WHERE id = $4 AND owner_id = $5"#,
    )
    .bind(&req.display_name)
    .bind(&req.color)
    .bind(&req.icon)
    .bind(id)
    .bind(user.user_id)
    .execute(&state.db)
    .await?;

    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    fetch_device(&state, id, user.user_id).await
}

// 페어링 해제 — 두 가지 모드
//
//   default (?purge=false): 데이터 보관. 본인 데이터(user_id 일치) 는 그대로 두고
//     디바이스 메타 (owner_id, display_name, color, last_*, account_type_override) 만 정리.
//     같은 사용자가 다시 페어링하면 자동 복구.
//
//   purge (?purge=true): 본인이 만든 데이터까지 영구 삭제.
//     - location_records, events, daily_stats, trip_annotations 중 user_id=본인 row 삭제
//     - geofences 중 owner_id=본인 row 삭제
//     - share_tokens 중 owner_id=본인 row 삭제
//     디바이스 자체는 남아 다른 사용자가 페어링 가능.
//
// 두 경우 모두 share_tokens 는 소유자 본인 것만 정리. SIM 정보 (1NCE) 는 외부 자산이라 건드리지 않음.
#[derive(Debug, serde::Deserialize)]
pub struct UnpairQuery {
    #[serde(default)]
    pub purge: bool,
}

async fn unpair(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<UnpairQuery>,
) -> AppResult<Json<serde_json::Value>> {
    // 1) 본인 소유 확인 — race-safe atomic claim 으로 처리
    let mut tx = state.db.begin().await?;

    let claimed: Option<i64> = sqlx::query_scalar(
        r#"UPDATE devices
              SET owner_id              = NULL,
                  paired_at             = NULL,
                  display_name          = NULL,
                  color                 = NULL,
                  account_type_override = NULL,
                  last_seen_at          = NULL,
                  last_lat              = NULL,
                  last_lng              = NULL,
                  last_fix_at           = NULL
            WHERE id = $1 AND owner_id = $2
        RETURNING id"#,
    )
    .bind(id).bind(user.user_id)
    .fetch_optional(&mut *tx).await?;

    if claimed.is_none() {
        tx.rollback().await?;
        return Err(AppError::NotFound);
    }

    // 2) 사용자 본인 share_tokens 수거 (privacy: 이전 공유 링크 무효화)
    // 테이블: share_tokens, 발급자 컬럼: created_by
    sqlx::query(
        "UPDATE share_tokens SET revoked_at = NOW() \
          WHERE device_id = $1 AND created_by = $2 AND revoked_at IS NULL",
    )
    .bind(id).bind(user.user_id)
    .execute(&mut *tx).await?;

    // 3) purge 모드: 본인 user_id tagged row 들 모두 삭제
    let mut purged = 0_u64;
    if q.purge {
        purged += sqlx::query("DELETE FROM location_records WHERE device_id = $1 AND user_id = $2")
            .bind(id).bind(user.user_id).execute(&mut *tx).await?.rows_affected();
        purged += sqlx::query("DELETE FROM events           WHERE device_id = $1 AND user_id = $2")
            .bind(id).bind(user.user_id).execute(&mut *tx).await?.rows_affected();
        purged += sqlx::query("DELETE FROM daily_stats      WHERE device_id = $1 AND user_id = $2")
            .bind(id).bind(user.user_id).execute(&mut *tx).await?.rows_affected();
        purged += sqlx::query("DELETE FROM trip_annotations WHERE device_id = $1 AND user_id = $2")
            .bind(id).bind(user.user_id).execute(&mut *tx).await?.rows_affected();
        purged += sqlx::query("DELETE FROM geofences        WHERE device_id = $1 AND owner_id = $2")
            .bind(id).bind(user.user_id).execute(&mut *tx).await?.rows_affected();
        // 디바이스 페어/SIM swap 이력 — purge 시 옛 페어링 추적 막기 위해 정리.
        purged += sqlx::query("DELETE FROM device_audit_log WHERE device_id = $1")
            .bind(id).execute(&mut *tx).await?.rows_affected();
        // stationary 진단 JSONB — sleep 패턴 / 마지막 위치 hint 남기지 않도록 클리어.
        sqlx::query("UPDATE devices SET last_stationary = NULL WHERE id = $1")
            .bind(id).execute(&mut *tx).await?;
        // ai_analyses, sim_topup_requests 는 사용자가 결제한 이력이라 보관.
    }
    tx.commit().await?;

    log_audit(&state, id, "unpair", user.user_id,
        json!({ "purge": q.purge, "purged_rows": purged })).await;
    Ok(Json(json!({
        "ok": true,
        "purge": q.purge,
        "purged_rows": purged,
    })))
}

// ===========================================================================
// Wipe — 본인 user_id tagged row 모두 삭제 + 디바이스 메타 정리 + unpair.
// 디바이스 row 자체는 보존 (다른 사용자가 그 SIM/하드웨어 페어링 가능).
// ===========================================================================
async fn wipe(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    // unpair purge=true 와 동일 동작
    unpair(
        State(state),
        user,
        Path(id),
        axum::extract::Query(UnpairQuery { purge: true }),
    ).await
}

// ===========================================================================
// Audit log 조회
// ===========================================================================
#[derive(Debug, Serialize, FromRow)]
pub struct AuditEntry {
    pub id:          i64,
    pub event_type:  String,
    pub actor:       Option<String>,
    pub data:        Option<serde_json::Value>,
    pub occurred_at: DateTime<Utc>,
}

async fn audit_log(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<AuditEntry>>> {
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
        .bind(id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }
    let rows = sqlx::query_as::<_, AuditEntry>(
        r#"SELECT id, event_type, actor, data, occurred_at
             FROM device_audit_log
            WHERE device_id = $1
            ORDER BY occurred_at DESC LIMIT 100"#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ===========================================================================
// 최근 lifecycle 이벤트 (wake / sleep_enter / low_batt / offline / ...)
// ===========================================================================
#[derive(Debug, Serialize, FromRow)]
pub struct DeviceEvent {
    pub id:          i64,
    pub kind:        String,
    pub data:        Option<serde_json::Value>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, Default)]
pub struct EventsQuery {
    /// recorded_at >= since (RFC3339).
    pub since: Option<DateTime<Utc>>,
    /// 결과 row 상한. 기본 50, 최대 1000 (진단 페이지가 긴 벤치 세션에서도 cover).
    pub limit: Option<i64>,
}

async fn events_log(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<EventsQuery>,
) -> AppResult<Json<Vec<DeviceEvent>>> {
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
        .bind(id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 1000);
    let rows = sqlx::query_as::<_, DeviceEvent>(
        r#"SELECT id, kind, data, occurred_at
             FROM events
            WHERE device_id = $1 AND user_id = $2
              AND kind IN ('wake','sleep_enter','low_batt','offline','online','signal_loss',
                           'geofence_in','geofence_out','geofence_armed','brownout','gps_anomaly','lost')
              AND ($3::timestamptz IS NULL OR occurred_at >= $3)
            ORDER BY occurred_at DESC
            LIMIT $4"#,
    )
    .bind(id).bind(user.user_id).bind(q.since).bind(limit)
    .fetch_all(&state.db).await?;
    Ok(Json(rows))
}

// ===========================================================================
// 사이클 단위 range 삭제 — 연구소 토글에서 호출.
// from / until (RFC3339) 사이의 events + location_records 를 user-scope 로 삭제.
// 디바이스 자체는 보존 (페어링 유지).
// ===========================================================================
#[derive(Debug, Deserialize)]
pub struct DeleteRangeQuery {
    pub from: DateTime<Utc>,
    pub until: DateTime<Utc>,
}

async fn delete_range(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<DeleteRangeQuery>,
) -> AppResult<Json<Value>> {
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
        .bind(id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }
    if q.until < q.from {
        return Err(AppError::BadRequest("until < from".into()));
    }
    let mut tx = state.db.begin().await?;
    let locs = sqlx::query(
        "DELETE FROM location_records WHERE device_id = $1 AND user_id = $2 \
           AND recorded_at >= $3 AND recorded_at <= $4",
    )
    .bind(id).bind(user.user_id).bind(q.from).bind(q.until)
    .execute(&mut *tx).await?.rows_affected();
    let evs = sqlx::query(
        "DELETE FROM events WHERE device_id = $1 AND user_id = $2 \
           AND occurred_at >= $3 AND occurred_at <= $4",
    )
    .bind(id).bind(user.user_id).bind(q.from).bind(q.until)
    .execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    tracing::info!(device_id = id, user_id = user.user_id, from = %q.from, until = %q.until, locs, evs, "cycle range deleted");
    Ok(Json(json!({ "deleted_locations": locs, "deleted_events": evs })))
}

// ===========================================================================
// 1NCE SIM 잔량 조회 (stub — 실제 호출은 ONCE_API_CLIENT_ID/SECRET 설정 시)
// ===========================================================================
// 캐시된 SIM 정보 즉시 반환. 1NCE API 직접 호출 안 함 — 외부 의존 제거 + 빠름.
// 백엔드 워커 (services::nce::spawn_cache_worker) 가 30분 주기로 채움.
async fn sim_info(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(Option<i64>, Option<String>, Option<serde_json::Value>, Option<DateTime<Utc>>, Option<String>)> =
        sqlx::query_as(
            "SELECT owner_id, iccid, sim_info_cache, sim_info_fetched_at, sim_info_error \
             FROM devices WHERE id = $1"
        ).bind(id).fetch_optional(&state.db).await?;

    let (owner, iccid, cache, fetched_at, err) = row.ok_or(AppError::NotFound)?;
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }
    let iccid = iccid.ok_or(AppError::BadRequest("device has no ICCID".into()))?;

    let has_oauth = std::env::var("ONCE_API_CLIENT_ID").map(|s| !s.is_empty()).unwrap_or(false)
                 && std::env::var("ONCE_API_CLIENT_SECRET").map(|s| !s.is_empty()).unwrap_or(false);
    let has_token = std::env::var("ONCE_API_TOKEN").map(|s| !s.is_empty()).unwrap_or(false);

    if !has_oauth && !has_token {
        return Ok(Json(json!({
            "iccid": iccid,
            "configured": false,
            "note": "set ONCE_API_TOKEN or ONCE_API_CLIENT_ID + ONCE_API_CLIENT_SECRET"
        })));
    }

    // 캐시 있으면 그대로 + last_fetched_at 메타 추가
    if let Some(mut v) = cache {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("cached".into(), json!(true));
            obj.insert("fetched_at".into(),
                fetched_at.map(|t| json!(t)).unwrap_or(json!(null)));
        }
        return Ok(Json(v));
    }

    // 캐시 없음 — 워커가 곧 채울 것이라는 안내
    Ok(Json(json!({
        "iccid":      iccid,
        "configured": true,
        "cached":     false,
        "pending":    true,
        "fetched_at": fetched_at,
        "error":      err,
        "note":       "처음 페어링된 디바이스는 30분 내 첫 캐시가 채워집니다.",
    })))
}

// 강제 갱신 — 1NCE 직접 호출해서 캐시 즉시 덮어쓰고 새 값 반환.
// 사용자가 "장치 통계"의 새로고침 버튼을 눌렀을 때 호출.
async fn sim_info_refresh(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT owner_id, iccid FROM devices WHERE id = $1"
    ).bind(id).fetch_optional(&state.db).await?;
    let (owner, iccid) = row.ok_or(AppError::NotFound)?;
    if owner != Some(user.user_id) {
        return Err(AppError::NotFound);
    }
    let iccid = iccid.ok_or(AppError::BadRequest("device has no ICCID".into()))?;

    let has_oauth = std::env::var("ONCE_API_CLIENT_ID").map(|s| !s.is_empty()).unwrap_or(false)
                 && std::env::var("ONCE_API_CLIENT_SECRET").map(|s| !s.is_empty()).unwrap_or(false);
    let has_token = std::env::var("ONCE_API_TOKEN").map(|s| !s.is_empty()).unwrap_or(false);
    if !has_oauth && !has_token {
        return Err(AppError::BadRequest("1NCE API 자격증명 미설정".into()));
    }

    match crate::services::nce::fetch_sim_usage(&iccid, "", "").await {
        Ok(mut v) => {
            sqlx::query(
                r#"UPDATE devices
                      SET sim_info_cache      = $2,
                          sim_info_fetched_at = NOW(),
                          sim_info_error      = NULL
                    WHERE id = $1"#,
            )
            .bind(id).bind(&v)
            .execute(&state.db).await?;

            // 응답 메타 추가 — 프론트가 갱신 시각 표시할 수 있게.
            if let Some(obj) = v.as_object_mut() {
                obj.insert("cached".into(), serde_json::json!(true));
                obj.insert("fetched_at".into(), serde_json::json!(chrono::Utc::now()));
            }
            Ok(Json(v))
        }
        Err(e) => {
            let msg = format!("{e:#}");
            let _ = sqlx::query(
                "UPDATE devices SET sim_info_fetched_at = NOW(), sim_info_error = $2 WHERE id = $1"
            ).bind(id).bind(&msg).execute(&state.db).await;
            Err(AppError::BadRequest(format!("1NCE 호출 실패: {msg}")))
        }
    }
}

// ===========================================================================
// audit 헬퍼
// ===========================================================================
async fn log_audit(state: &AppState, device_id: i64, event_type: &str, user_id: i64, data: serde_json::Value) {
    let actor = format!("user:{user_id}");
    let _ = sqlx::query(
        r#"INSERT INTO device_audit_log (device_id, event_type, actor, data)
           VALUES ($1, $2, $3, $4)"#,
    )
    .bind(device_id)
    .bind(event_type)
    .bind(&actor)
    .bind(&data)
    .execute(&state.db)
    .await;
}

async fn fetch_device(state: &AppState, id: i64, user_id: i64) -> AppResult<Json<DeviceView>> {
    let row = sqlx::query_as::<_, DeviceView>(
        r#"SELECT d.id, d.device_uid, d.display_name, d.color, d.icon,
                  d.iccid, d.imei, d.imsi, d.hw_version, d.fw_version,
                  d.last_seen_at, d.last_lat, d.last_lng, d.last_fix_at,
                  d.paired_at, d.created_at, d.last_stationary,
                  le.kind        AS last_event_kind,
                  le.occurred_at AS last_event_at
             FROM devices d
        LEFT JOIN LATERAL (
                  SELECT kind, occurred_at
                    FROM events
                   WHERE device_id = d.id AND user_id = $2
                ORDER BY occurred_at DESC
                   LIMIT 1
             ) le ON TRUE
            WHERE d.id = $1 AND d.owner_id = $2"#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}
