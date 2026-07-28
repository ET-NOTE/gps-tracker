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
    // 13_4 LC86G: 마지막 POST 의 안테나 상태 ("OK_EXT"/"OK_INT"/"OPEN"/"SHORT"/"?")
    // GPS fix 없어도 LTE POST 만 되면 갱신 — 안테나 결선 즉시 진단.
    pub last_antenna: Option<String>,
    // 마지막 payload 배터리 값 (fix 유무 무관, location_records 최신 row 에서 LATERAL JOIN).
    // 새로고침 후 device card 배터리 fallback — 실시간 WS 값 없어도 이걸로 최신 표시.
    pub last_vbat_mv: Option<i32>,
    pub last_cbc_mv:  Option<i32>,
    // (2026-07-28) 월간 리포트 유류비 추정용. migration 0044.
    pub fuel_efficiency_kmpl: Option<f32>,
    pub fuel_type:            Option<String>,
    // (2026-07-28) 국세청 별지 제73호 헤더 + 우리 전용 양식. migration 0045.
    pub license_plate:      Option<String>,
    pub model_year:         Option<i32>,
    pub engine_cc:          Option<i32>,
    pub purchase_price_krw: Option<i64>,
    pub acquired_at:        Option<chrono::NaiveDate>,
    pub department:         Option<String>,
    pub vehicle_type:       Option<String>,
    // (2026-07-28) Stage-4C-1: 차량 관리 (사용가능 toggle + 메모). migration 0046.
    pub enabled:            Option<bool>,   // NOT NULL DEFAULT TRUE — Option 은 sqlx bind 편의
    pub note:               Option<String>,
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
        .route("/devices/:id/reset",  post(reset_device))        // 원격 hardPowerCycle (LTE stuck 회복)
        .route("/devices/:id/range",  delete(delete_range))      // 사이클 단위 range 삭제 (연구소 토글)
        .route("/devices/:id/batch-stats", get(batch_stats))     // sss 24h: fixes array (batch) 통계
        .route("/devices/:id/post-interval", post(set_post_interval))   // POST 주기 원격 조정 (5~300s)
        .route("/devices/:id/locations/aggregated", get(locations_aggregated))   // TimescaleDB continuous aggregate (1m/1h bucket)
        .route("/devices/:id/fuel-info", patch(set_fuel_info))    // (2026-07-28) 연비/연료 종류 — 월간 리포트 유류비 추정용
        .route("/devices/:id/vehicle-info", patch(set_vehicle_info)) // (2026-07-28) 국세청 별지 제73호 헤더 필드
        .route("/timescaledb/storage-stats", get(timescaledb_storage_stats))      // P2: hypertable size + compression ratio
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

// ─── 원격 reset (hardPowerCycle) ─────────────────────────────
//
// LTE stale registration / SHCONN socket 누락 등 "응답하지만 stuck" 상태 회복용.
// UI 버튼 → 이 endpoint → devices.reset_pending = TRUE.
// 다음 ingest 호출 시 응답에 {"cmd":"reset"} 실어 보냄. 펌웨어가 받자마자 PWR_EN 토글 + ESP restart.
// 한계: 완전 stuck (POST 자체 무응답) 상태에선 cmd 전달 불가 → firmware-side 60s 무응답 watchdog 가 cover.
async fn reset_device(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let updated: Option<(i64,)> = sqlx::query_as(
        r#"UPDATE devices
              SET reset_pending      = TRUE,
                  reset_requested_at = NOW()
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
        "note": "다음 ingest (보통 15초 이내) 시 디바이스 hardPowerCycle. 완전 stuck 상태면 firmware watchdog 가 60s 후 자동 처리."
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
                  d.fuel_efficiency_kmpl, d.fuel_type,
                  d.license_plate, d.model_year, d.engine_cc,
                  d.purchase_price_krw, d.acquired_at,
                  d.department, d.vehicle_type,
                  d.enabled, d.note,
                  le.kind        AS last_event_kind,
                  le.occurred_at AS last_event_at,
                  la.antenna     AS last_antenna,
                  lv.vbat_mv     AS last_vbat_mv,
                  lv.cbc_mv      AS last_cbc_mv
             FROM devices d
        LEFT JOIN LATERAL (
                  SELECT kind, occurred_at
                    FROM events
                   WHERE device_id = d.id AND user_id = $1
                ORDER BY occurred_at DESC
                   LIMIT 1
             ) le ON TRUE
        LEFT JOIN LATERAL (
                  -- (2026-07-03) location_records + events 통합. Timer wake heartbeat 사이클은
                  --   fix 없이 wake event 만 발행 → events 에만 antenna 저장 → 이전 로직은
                  --   location_records 만 참조해 last_antenna=null (미보고) 표시. 두 소스 최신값.
                  SELECT antenna FROM (
                    SELECT raw ->>'antenna' AS antenna, recorded_at AS at
                      FROM location_records
                     WHERE device_id = d.id AND raw ? 'antenna'
                    UNION ALL
                    SELECT data->>'antenna' AS antenna, occurred_at AS at
                      FROM events
                     WHERE device_id = d.id AND data ? 'antenna'
                  ) x
                  WHERE x.antenna IS NOT NULL AND x.antenna <> ''
                  ORDER BY x.at DESC
                  LIMIT 1
             ) la ON TRUE
        LEFT JOIN LATERAL (
                  -- (2026-07-16) fix 유무 무관 최근 payload 배터리. Fix 안 잡히는 실내 device 도
                  --   새로고침 후 즉시 현재 vbat 표시. WS 실시간 값이 오면 웹에서 그것으로 override.
                  SELECT vbat_mv, (raw->>'cbc_mv')::int AS cbc_mv
                    FROM location_records
                   WHERE device_id = d.id AND vbat_mv IS NOT NULL
                ORDER BY recorded_at DESC
                   LIMIT 1
             ) lv ON TRUE
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
// (2026-07-28) 연비/연료 종류 설정 — 월간 리포트 유류비 자동 추정용.
// ===========================================================================
#[derive(Debug, Deserialize, Validate)]
pub struct FuelInfoRequest {
    /// 리터당 km. NULL 로 clear 가능.
    #[validate(range(min = 1.0, max = 100.0))]
    pub fuel_efficiency_kmpl: Option<f32>,
    /// gasoline | diesel | lpg | ev. NULL 로 clear.
    pub fuel_type: Option<String>,
}

async fn set_fuel_info(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<FuelInfoRequest>,
) -> AppResult<Json<DeviceView>> {
    if let Some(ref t) = req.fuel_type {
        if !matches!(t.as_str(), "gasoline"|"diesel"|"lpg"|"ev") {
            return Err(AppError::BadRequest(format!("invalid fuel_type: {t}")));
        }
    }
    // 소유권 확인 + atomic set. NULL 전달 시 컬럼 clear.
    let updated: Option<(i64,)> = sqlx::query_as(
        r#"UPDATE devices
              SET fuel_efficiency_kmpl = $1,
                  fuel_type            = $2
            WHERE id = $3 AND owner_id = $4
        RETURNING id"#,
    )
    .bind(req.fuel_efficiency_kmpl)
    .bind(req.fuel_type.as_deref())
    .bind(id)
    .bind(user.user_id)
    .fetch_optional(&state.db).await?;
    if updated.is_none() {
        return Err(AppError::NotFound);
    }
    fetch_device(&state, id, user.user_id).await
}

// ===========================================================================
// (2026-07-28) Stage-4B-1: 국세청 별지 제73호 (업무용승용차 운행기록부) 헤더
// 필드 + 우리 전용 양식 필드 (부서, 차량 유형).
// ===========================================================================
#[derive(Debug, Deserialize, Validate)]
pub struct VehicleInfoRequest {
    /// 차량번호 — "12가3456" 등. NULL 로 clear 가능.
    #[validate(length(min = 1, max = 20))]
    pub license_plate: Option<String>,
    /// 연식. 1990 ~ 현재+1.
    #[validate(range(min = 1990, max = 2100))]
    pub model_year: Option<i32>,
    /// 배기량 cc.
    #[validate(range(min = 50, max = 20000))]
    pub engine_cc: Option<i32>,
    /// 취득가액 원.
    #[validate(range(min = 0_i64, max = 10_000_000_000_i64))]
    pub purchase_price_krw: Option<i64>,
    /// 취득일 (YYYY-MM-DD).
    pub acquired_at: Option<chrono::NaiveDate>,
    /// 부서/그룹 (우리 전용).
    #[validate(length(min = 1, max = 40))]
    pub department: Option<String>,
    /// 차량 유형 — sedan|van|truck|special|ev.
    pub vehicle_type: Option<String>,
    /// (2026-07-28) 사용가능 / 사용정지 toggle. null 이면 변경 안 함.
    pub enabled: Option<bool>,
    /// (2026-07-28) 메모. 빈 문자열 or null 이면 clear.
    #[validate(length(max = 500))]
    pub note: Option<String>,
}

async fn set_vehicle_info(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<VehicleInfoRequest>,
) -> AppResult<Json<DeviceView>> {
    if let Some(ref t) = req.vehicle_type {
        if !matches!(t.as_str(), "sedan"|"van"|"truck"|"special"|"ev") {
            return Err(AppError::BadRequest(format!("invalid vehicle_type: {t}")));
        }
    }
    // NULL 전달 시 각 컬럼 clear. UNIQUE index 는 NULL 허용이라 여러 device 미입력 공존 OK.
    // enabled 는 NULL 로 clear 하지 않음 (컬럼 NOT NULL). 값이 왔을 때만 갱신.
    // COALESCE($8, enabled) → NULL 이면 기존 유지.
    let note_norm = req.note.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let updated: Option<(i64,)> = sqlx::query_as(
        r#"UPDATE devices
              SET license_plate      = $1,
                  model_year         = $2,
                  engine_cc          = $3,
                  purchase_price_krw = $4,
                  acquired_at        = $5,
                  department         = $6,
                  vehicle_type       = $7,
                  enabled            = COALESCE($8, enabled),
                  note               = $9
            WHERE id = $10 AND owner_id = $11
        RETURNING id"#,
    )
    .bind(req.license_plate.as_deref())
    .bind(req.model_year)
    .bind(req.engine_cc)
    .bind(req.purchase_price_krw)
    .bind(req.acquired_at)
    .bind(req.department.as_deref())
    .bind(req.vehicle_type.as_deref())
    .bind(req.enabled)
    .bind(note_norm)
    .bind(id)
    .bind(user.user_id)
    .fetch_optional(&state.db).await?;
    if updated.is_none() {
        return Err(AppError::NotFound);
    }
    fetch_device(&state, id, user.user_id).await
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
    /// (2026-07-29) 특정 kind 만 필터. 쉼표 구분 (예: "wake" / "wake,sleep_enter").
    /// 홈 뷰 `computeHomeSinceISO` 가 wake 1건만 필요할 때 이 파라미터로 노이즈 skip.
    /// 미제공 시 기본 화이트리스트 전체.
    pub kinds: Option<String>,
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
    // 기본 화이트리스트 — 사용자 지정 kinds 가 있으면 그것과 교집합. (허용 목록 밖 kind 는 자동 필터링)
    const ALLOWED: &[&str] = &[
        "wake","sleep_enter","low_batt","offline","online","signal_loss","stuck",
        "geofence_in","geofence_out","geofence_armed","brownout","gps_anomaly","lost",
    ];
    let kinds: Vec<String> = match q.kinds.as_deref() {
        Some(s) => s.split(',')
            .map(|k| k.trim())
            .filter(|k| !k.is_empty() && ALLOWED.contains(k))
            .map(|k| k.to_string())
            .collect(),
        None => ALLOWED.iter().map(|s| s.to_string()).collect(),
    };
    if kinds.is_empty() {
        // 잘못된 kinds 만 지정된 경우 — 빈 결과.
        return Ok(Json(vec![]));
    }
    let rows = sqlx::query_as::<_, DeviceEvent>(
        r#"SELECT id, kind, data, occurred_at
             FROM events
            WHERE device_id = $1 AND user_id = $2
              AND kind = ANY($5)
              AND ($3::timestamptz IS NULL OR occurred_at >= $3)
            ORDER BY occurred_at DESC
            LIMIT $4"#,
    )
    .bind(id).bind(user.user_id).bind(q.since).bind(limit).bind(&kinds)
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
    // devices.last_* 재계산 — 삭제된 좌표가 마지막이었을 경우 stale 값이 남아있으면
    // 프런트의 computeHomeSinceISO 가 todayHasFix=true 로 오판 → 삭제 후에도 오늘
    // 지도에 계속 그려지는 회귀. 남은 최신 fix/event 로 갱신 (없으면 모두 NULL).
    // GREATEST 는 NULL 인자를 무시하므로 한쪽만 있어도 정확한 값 반환.
    sqlx::query(
        "WITH last_loc AS ( \
           SELECT lat, lng, recorded_at FROM location_records \
             WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1 \
         ), last_ev AS ( \
           SELECT occurred_at FROM events \
             WHERE device_id = $1 ORDER BY occurred_at DESC LIMIT 1 \
         ) \
         UPDATE devices SET \
           last_lat  = (SELECT lat FROM last_loc), \
           last_lng  = (SELECT lng FROM last_loc), \
           last_fix_at = (SELECT recorded_at FROM last_loc), \
           last_seen_at = GREATEST( \
             (SELECT recorded_at FROM last_loc), \
             (SELECT occurred_at FROM last_ev) \
           ) \
         WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::info!(device_id = id, user_id = user.user_id, from = %q.from, until = %q.until, locs, evs, "cycle range deleted");
    Ok(Json(json!({ "deleted_locations": locs, "deleted_events": evs })))
}

// ===========================================================================
// POST 주기 원격 조정 — 24h 테스트용
// ===========================================================================
//
// 진단 페이지에서 N초 입력 → devices.post_interval_pending = N. 다음 ingest 응답에
// post_interval_s 동봉 + atomic 으로 NULL 토글. firmware 변수는 RAM only — reset/wake
// 시 자동 default 복귀라 hang 후 자동 회복.
#[derive(Debug, Deserialize)]
pub struct SetPostIntervalRequest {
    pub seconds: i32,
}

async fn set_post_interval(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<SetPostIntervalRequest>,
) -> AppResult<Json<Value>> {
    if !(5..=300).contains(&req.seconds) {
        return Err(AppError::BadRequest("seconds must be 5~300".into()));
    }
    let updated: Option<(i64,)> = sqlx::query_as(
        "UPDATE devices SET post_interval_pending = $3 \
         WHERE id = $1 AND owner_id = $2 RETURNING id"
    )
    .bind(id).bind(user.user_id).bind(req.seconds)
    .fetch_optional(&state.db).await?;
    if updated.is_none() { return Err(AppError::NotFound); }
    Ok(Json(json!({
        "ok": true, "device_id": id, "seconds": req.seconds,
        "note": "다음 ingest 시 device 가 받음. reset/wake 시 default 30s 자동 복귀."
    })))
}

// ===========================================================================
// sss 24h 테스트 — fixes array (batch) 통계
// ===========================================================================
//
// 한 ingest POST 안에 들어온 fix 들이 location_records 에 individual row 로 저장됨.
// 같은 POST 의 row 들은 raw->>'ts' + raw->>'at_ms' 가 같음 (== firmware 의 ingest payload 메타).
// 그 두 값으로 그룹화 → 각 POST 의 batch_size, avg_sat, recorded_at 범위 산출.
#[derive(Debug, Deserialize)]
pub struct BatchStatsQuery {
    #[serde(default = "default_batch_hours")]
    pub hours: i32,
}
fn default_batch_hours() -> i32 { 24 }

async fn batch_stats(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<BatchStatsQuery>,
) -> AppResult<Json<Value>> {
    // 소유 확인
    let owner_ok: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM devices WHERE id = $1 AND owner_id = $2"
    ).bind(id).bind(user.user_id).fetch_optional(&state.db).await?;
    if owner_ok.is_none() { return Err(AppError::NotFound); }

    let hours = q.hours.clamp(1, 168);

    // 최근 N batch (각 POST 별 통계).
    // Phase 6C-3: batch_size 는 column row COUNT(*) 대신 anchor 의 jsonb_array_length 사용
    // (column row 가 1개일 수도, N개일 수도 있음 — jsonb 가 진실).
    //   - 6B 이후 batch: anchor jsonb 가 있음 → COALESCE(jsonb_array_length, COUNT(*))
    //   - 6B 이전 batch: anchor jsonb 없음 → COUNT(*) 그대로 (legacy)
    let rows: Vec<(Option<String>, Option<String>, i64, Option<f64>, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT
              raw->>'ts'      AS uptime_s,
              raw->>'at_ms'   AS at_ms,
              COALESCE(
                  MAX(jsonb_array_length(fixes_jsonb))::bigint,
                  COUNT(*)
              )               AS batch_size,
              AVG(NULLIF(sat, 0))::float8 AS avg_sat,
              MIN(recorded_at) AS first_at,
              MAX(recorded_at) AS last_at
            FROM location_records
           WHERE device_id = $1
             AND raw ? 'fixes'
             AND recorded_at > now() - make_interval(hours => $2)
        GROUP BY raw->>'ts', raw->>'at_ms'
        ORDER BY MAX(recorded_at) DESC
        LIMIT 200"#,
    )
    .bind(id).bind(hours)
    .fetch_all(&state.db)
    .await?;

    // 집계
    let total_batches = rows.len() as i64;
    let total_fixes: i64 = rows.iter().map(|r| r.2).sum();
    let avg_batch = if total_batches > 0 { total_fixes as f64 / total_batches as f64 } else { 0.0 };
    let max_batch = rows.iter().map(|r| r.2).max().unwrap_or(0);
    let min_batch = rows.iter().map(|r| r.2).min().unwrap_or(0);

    let recent: Vec<Value> = rows.into_iter().map(|(uptime, _at_ms, sz, avg_sat, first, last)| {
        let span_s = (last - first).num_milliseconds() as f64 / 1000.0;
        json!({
            "uptime_s": uptime,
            "batch_size": sz,
            "avg_sat": avg_sat.map(|v| (v * 10.0).round() / 10.0),
            "first_at": first,
            "last_at": last,
            "span_s": (span_s * 10.0).round() / 10.0,
        })
    }).collect();

    Ok(Json(json!({
        "hours": hours,
        "total_batches": total_batches,
        "total_fixes": total_fixes,
        "avg_batch": (avg_batch * 100.0).round() / 100.0,
        "max_batch": max_batch,
        "min_batch": min_batch,
        "recent": recent,
    })))
}

// ===========================================================================
// Continuous aggregate 쿼리 — TimescaleDB 의 location_1min / location_1hour view.
// 시간 범위가 큰 historical chart 가속용. 사용자가 bucket 명시 (1m | 1h).
// ===========================================================================
#[derive(Debug, Deserialize)]
pub struct AggregatedQuery {
    pub bucket: String,                       // "1m" | "1h"
    pub since:  DateTime<Utc>,
    pub until:  Option<DateTime<Utc>>,
}

async fn locations_aggregated(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<AggregatedQuery>,
) -> AppResult<Json<Vec<Value>>> {
    let owner_ok: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM devices WHERE id = $1 AND owner_id = $2"
    ).bind(id).bind(user.user_id).fetch_optional(&state.db).await?;
    if owner_ok.is_none() { return Err(AppError::NotFound); }

    let table = match q.bucket.as_str() {
        "1m" => "location_1min",
        "5m" => "location_5min",
        "1h" => "location_1hour",
        _    => return Err(AppError::BadRequest("bucket must be '1m' | '5m' | '1h'".into())),
    };
    let until = q.until.unwrap_or_else(Utc::now);

    let rows: Vec<(DateTime<Utc>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f32>, Option<i32>, i64)> = sqlx::query_as(&format!(
        "SELECT bucket, lat_avg, lng_avg, lat_last, lng_last, sat_avg, vbat_avg, fix_count
           FROM {table}
          WHERE device_id = $1 AND bucket >= $2 AND bucket <= $3
          ORDER BY bucket ASC
          LIMIT 5000"
    ))
    .bind(id).bind(q.since).bind(until)
    .fetch_all(&state.db)
    .await?;

    let out: Vec<Value> = rows.into_iter().map(|(b, lat_a, lng_a, lat_l, lng_l, sat, vbat, count)| {
        json!({
            "bucket":     b,
            "lat_avg":    lat_a,
            "lng_avg":    lng_a,
            "lat_last":   lat_l,
            "lng_last":   lng_l,
            "sat_avg":    sat,
            "vbat_avg":   vbat,
            "fix_count":  count,
        })
    }).collect();

    Ok(Json(out))
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
                  d.fuel_efficiency_kmpl, d.fuel_type,
                  d.license_plate, d.model_year, d.engine_cc,
                  d.purchase_price_krw, d.acquired_at,
                  d.department, d.vehicle_type,
                  d.enabled, d.note,
                  le.kind        AS last_event_kind,
                  le.occurred_at AS last_event_at,
                  la.antenna     AS last_antenna,
                  lv.vbat_mv     AS last_vbat_mv,
                  lv.cbc_mv      AS last_cbc_mv
             FROM devices d
        LEFT JOIN LATERAL (
                  SELECT kind, occurred_at
                    FROM events
                   WHERE device_id = d.id AND user_id = $2
                ORDER BY occurred_at DESC
                   LIMIT 1
             ) le ON TRUE
        LEFT JOIN LATERAL (
                  -- (2026-07-03) location_records + events 통합. Timer wake heartbeat 사이클은
                  --   fix 없이 wake event 만 발행 → events 에만 antenna 저장 → 이전 로직은
                  --   location_records 만 참조해 last_antenna=null (미보고) 표시. 두 소스 최신값.
                  SELECT antenna FROM (
                    SELECT raw ->>'antenna' AS antenna, recorded_at AS at
                      FROM location_records
                     WHERE device_id = d.id AND raw ? 'antenna'
                    UNION ALL
                    SELECT data->>'antenna' AS antenna, occurred_at AS at
                      FROM events
                     WHERE device_id = d.id AND data ? 'antenna'
                  ) x
                  WHERE x.antenna IS NOT NULL AND x.antenna <> ''
                  ORDER BY x.at DESC
                  LIMIT 1
             ) la ON TRUE
        LEFT JOIN LATERAL (
                  SELECT vbat_mv, (raw->>'cbc_mv')::int AS cbc_mv
                    FROM location_records
                   WHERE device_id = d.id AND vbat_mv IS NOT NULL
                ORDER BY recorded_at DESC
                   LIMIT 1
             ) lv ON TRUE
            WHERE d.id = $1 AND d.owner_id = $2"#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

// ===========================================================================
// P2: TimescaleDB 운영 지표 — hypertable size + compression ratio + chunk 수
//
// DiagnosticPage 의 "🗄️ TimescaleDB 운영 지표" 카드용. Phase 6 (storage 1 row +
// jsonb) 결정의 데이터 근거 — compression 만으로 충분하면 Phase 6 skip 가능.
//
// 인증된 사용자라면 누구나 조회 가능 (장치 무관 hypertable 전체 통계).
// ===========================================================================
async fn timescaledb_storage_stats(
    State(state): State<AppState>,
    _user: AuthUser,
) -> AppResult<Json<Value>> {
    // hypertable 전체 size (bytes) + chunk 수 + row 수 — 항상 가능
    let total_bytes: Option<i64> = sqlx::query_scalar(
        "SELECT hypertable_size('location_records')::bigint"
    ).fetch_one(&state.db).await.ok();

    let chunk_count: Option<i64> = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM show_chunks('location_records')"
    ).fetch_one(&state.db).await.ok();

    let row_count: Option<i64> = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM location_records"
    ).fetch_one(&state.db).await.ok();

    // compression stats — hypertable_compression_stats 가 hypertable 단위 합계 1행 반환
    // (compression policy 미적용 시에는 모든 컬럼 NULL — 즉 압축된 chunk 가 없는 상태)
    let compression: Option<(Option<i64>, Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
        r#"SELECT
              total_chunks::bigint,
              number_compressed_chunks::bigint,
              before_compression_total_bytes::bigint,
              after_compression_total_bytes::bigint
             FROM hypertable_compression_stats('location_records')"#
    ).fetch_one(&state.db).await.ok();

    // continuous aggregate view 의 size (참고용)
    let cagg_sizes: Vec<(String, Option<i64>)> = sqlx::query_as(
        r#"SELECT view_name::text, hypertable_size(format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass)::bigint
             FROM timescaledb_information.continuous_aggregates
            WHERE view_name IN ('location_1min', 'location_5min', 'location_1hour')"#
    ).fetch_all(&state.db).await.unwrap_or_default();

    let mut aggregates = serde_json::Map::new();
    for (name, size) in cagg_sizes {
        aggregates.insert(name, json!(size));
    }

    let compression_json = compression.map(|(total, n, before, after)| {
        let ratio = match (before, after) {
            (Some(b), Some(a)) if a > 0 => Some((b as f64 / a as f64 * 10.0).round() / 10.0),
            _ => None,
        };
        json!({
            "total_chunks":      total,
            "compressed_chunks": n,
            "before_bytes":      before,
            "after_bytes":       after,
            "ratio":             ratio,
        })
    });

    Ok(Json(json!({
        "total_bytes":   total_bytes,
        "chunk_count":   chunk_count,
        "row_count":     row_count,
        "compression":   compression_json,
        "aggregates":    Value::Object(aggregates),
        "retention":     "permanent",  // 2026-06-27 결정 — 1년 retention policy 제거됨
    })))
}
