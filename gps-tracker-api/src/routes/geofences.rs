// /api/v1/geofences/* — 지오펜스 CRUD.
// 진입/이탈 자동 감지는 ingest 핸들러에서 처리 (services/geofence.rs).

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use validator::Validate;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    services::geofence::haversine_m,
    state::AppState,
};

/// SIM 당 지오펜스 최대 개수 (device-specific + owner-wide 합산 effective).
pub const MAX_GEOFENCES_PER_SIM: i64 = 20;

/// 지오펜스 생성 직전 cap 검증.
/// - target_device=Some(d): 디바이스 d 기준 effective count = device-specific(d) + owner-wide
/// - target_device=None  : owner 의 모든 디바이스 중 effective count 가 가장 큰 값을 사용
async fn enforce_geofence_cap(
    state: &AppState,
    owner_id: i64,
    target_device: Option<i64>,
) -> AppResult<()> {
    let owner_wide_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM geofences WHERE owner_id = $1 AND device_id IS NULL",
    )
    .bind(owner_id)
    .fetch_one(&state.db)
    .await?;

    match target_device {
        Some(d) => {
            let dev_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM geofences WHERE owner_id = $1 AND device_id = $2",
            )
            .bind(owner_id).bind(d).fetch_one(&state.db).await?;
            let total = dev_count + owner_wide_count;
            if total >= MAX_GEOFENCES_PER_SIM {
                return Err(AppError::Conflict(format!(
                    "이 SIM 의 지오펜스가 이미 {}개입니다 (최대 {})",
                    total, MAX_GEOFENCES_PER_SIM
                )));
            }
        }
        None => {
            // owner-wide 펜스를 추가하면 모든 디바이스의 effective count 가 +1.
            // 디바이스가 없으면 owner_wide_count 만 검증.
            let device_ids: Vec<i64> =
                sqlx::query_scalar("SELECT id FROM devices WHERE owner_id = $1")
                    .bind(owner_id).fetch_all(&state.db).await?;
            if device_ids.is_empty() {
                if owner_wide_count >= MAX_GEOFENCES_PER_SIM {
                    return Err(AppError::Conflict(format!(
                        "지오펜스가 이미 {}개입니다 (최대 {})",
                        owner_wide_count, MAX_GEOFENCES_PER_SIM
                    )));
                }
                return Ok(());
            }
            for d in device_ids {
                let dev_count: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM geofences WHERE owner_id = $1 AND device_id = $2",
                )
                .bind(owner_id).bind(d).fetch_one(&state.db).await?;
                let total = dev_count + owner_wide_count;
                if total >= MAX_GEOFENCES_PER_SIM {
                    return Err(AppError::Conflict(format!(
                        "디바이스 #{} 의 지오펜스가 이미 {}개입니다 (최대 {})",
                        d, total, MAX_GEOFENCES_PER_SIM
                    )));
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, FromRow)]
pub struct GeofenceView {
    pub id:         i64,
    pub owner_id:   i64,
    pub device_id:  Option<i64>,
    pub name:       String,
    pub center_lat: f64,
    pub center_lng: f64,
    pub radius_m:   i32,
    pub active:     bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct CreateRequest {
    #[validate(length(min = 1, max = 64))]
    pub name:       String,
    pub center_lat: f64,
    pub center_lng: f64,
    #[validate(range(min = 10, max = 100000))]
    pub radius_m:   i32,
    pub device_id:  Option<i64>,   // None = 모든 본인 디바이스
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateRequest {
    #[validate(length(min = 1, max = 64))]
    pub name:       Option<String>,
    pub center_lat: Option<f64>,
    pub center_lng: Option<f64>,
    #[validate(range(min = 10, max = 100000))]
    pub radius_m:   Option<i32>,
    pub active:     Option<bool>,
    pub device_id:  Option<Option<i64>>, // 명시적 null 허용 (Some(None) → device_id를 NULL로)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/geofences", get(list).post(create))
        .route("/geofences/history", get(history_all))
        .route("/geofences/:id", get(detail).patch(update).delete(remove))
        .route("/geofences/:id/history", get(history_one))
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<GeofenceView>>> {
    let rows = sqlx::query_as::<_, GeofenceView>(
        r#"SELECT id, owner_id, device_id, name, center_lat, center_lng,
                  radius_m, active, created_at, updated_at
             FROM geofences
            WHERE owner_id = $1
            ORDER BY id DESC"#,
    )
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// 좌표 sanity — NaN/Infinity 또는 범위 외 거부.
// validator crate 가 f64 range 를 지원 안 해 수동 체크.
fn check_lat_lng(lat: f64, lng: f64) -> AppResult<()> {
    if !lat.is_finite() || !lng.is_finite() {
        return Err(AppError::BadRequest("좌표 값이 유효하지 않습니다".into()));
    }
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return Err(AppError::BadRequest("좌표가 범위를 벗어났습니다".into()));
    }
    Ok(())
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateRequest>,
) -> AppResult<Json<GeofenceView>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;
    check_lat_lng(req.center_lat, req.center_lng)?;

    // device_id 지정 시 본인 소유 확인
    if let Some(did) = req.device_id {
        let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
            .bind(did)
            .fetch_optional(&state.db)
            .await?
            .flatten();
        if owner != Some(user.user_id) {
            return Err(AppError::NotFound);
        }
    }

    // SIM 당 20개 cap 검증
    enforce_geofence_cap(&state, user.user_id, req.device_id).await?;

    let id: i64 = sqlx::query_scalar(
        r#"INSERT INTO geofences (owner_id, device_id, name, center_lat, center_lng, radius_m, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $1) RETURNING id"#,
    )
    .bind(user.user_id)
    .bind(req.device_id)
    .bind(&req.name)
    .bind(req.center_lat)
    .bind(req.center_lng)
    .bind(req.radius_m)
    .fetch_one(&state.db)
    .await?;

    // 활성화 확인 알람 — 펜스 생성 직후, 영향 디바이스 각각에 대해
    //   1) geofence_states 초기 상태 기록 (이후 ingest 에서 트랜지션 정확히 검출)
    //   2) 'geofence_armed' 이벤트 삽입 → FCM 으로 운영자에게 "펜스 활성됨"을 알림
    arm_geofence_for_devices(&state, id, user.user_id, &req).await;

    fetch(&state, id, user.user_id).await
}

async fn arm_geofence_for_devices(
    state: &AppState,
    geofence_id: i64,
    owner_id: i64,
    req: &CreateRequest,
) {
    // device_id 지정시 그 디바이스만, 아니면 owner의 모든 디바이스
    let device_ids: Vec<(i64, Option<f64>, Option<f64>)> = match req.device_id {
        Some(did) => sqlx::query_as(
            "SELECT id, last_lat, last_lng FROM devices WHERE id = $1 AND owner_id = $2"
        ).bind(did).bind(owner_id).fetch_all(&state.db).await.unwrap_or_default(),
        None => sqlx::query_as(
            "SELECT id, last_lat, last_lng FROM devices WHERE owner_id = $1"
        ).bind(owner_id).fetch_all(&state.db).await.unwrap_or_default(),
    };

    for (did, lat, lng) in device_ids {
        // 위치 모를 때도 초기 행은 inside=false 로 기록 — 이후 첫 fix 시 ingest 의
        // `check_after_ingest` 가 prev 를 false 로 보고 정확히 진입 이벤트 발사.
        let (dist, inside): (Option<f64>, bool) = match (lat, lng) {
            (Some(la), Some(ln)) => {
                let d = haversine_m(la, ln, req.center_lat, req.center_lng);
                (Some(d), d <= req.radius_m as f64)
            }
            _ => (None, false),
        };

        // 초기 상태는 항상 기록 (이후 ingest 가 정확한 트랜지션 검출하려면 필요).
        let _ = sqlx::query(
            r#"INSERT INTO geofence_states (geofence_id, device_id, inside)
               VALUES ($1, $2, $3)
               ON CONFLICT (geofence_id, device_id)
               DO UPDATE SET inside = EXCLUDED.inside"#,
        )
        .bind(geofence_id).bind(did).bind(inside)
        .execute(&state.db).await;

        // 알림은 "이미 안에 있는" 경우에만 발송 (밖이면 조용히 활성).
        if inside {
            let dist_i = dist.map(|d| d as i64).unwrap_or(0);
            let _ = sqlx::query(
                r#"INSERT INTO events (device_id, kind, occurred_at, data, user_id)
                   VALUES ($1, 'geofence_armed', now(), $2,
                           (SELECT owner_id FROM devices WHERE id = $1))"#,
            )
            .bind(did)
            .bind(serde_json::json!({
                "geofence_id":   geofence_id,
                "geofence_name": req.name,
                "inside":        true,
                "distance_m":    dist_i,
                "radius_m":      req.radius_m,
            }))
            .execute(&state.db).await;
        }
    }
}

async fn detail(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<GeofenceView>> {
    fetch(&state, id, user.user_id).await
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<UpdateRequest>,
) -> AppResult<Json<GeofenceView>> {
    req.validate().map_err(|e| AppError::BadRequest(format!("invalid: {e}")))?;
    // [2026-08-14] 부분 업데이트 개별 검증 — 기존엔 lat/lng 둘 다 보낼 때만 검증해, 하나만 보내면
    //   (나머지는 DB 유지) 범위 밖 값(lat=999)이 저장돼 haversine 거리 오염 → 스퓨리어스 이탈 push.
    if let Some(la) = req.center_lat {
        if !(-90.0..=90.0).contains(&la) { return Err(AppError::BadRequest("center_lat out of range".into())); }
    }
    if let Some(ln) = req.center_lng {
        if !(-180.0..=180.0).contains(&ln) { return Err(AppError::BadRequest("center_lng out of range".into())); }
    }

    // device_id 변경 시 권한 확인
    if let Some(Some(did)) = req.device_id {
        let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id = $1")
            .bind(did)
            .fetch_optional(&state.db)
            .await?
            .flatten();
        if owner != Some(user.user_id) {
            return Err(AppError::NotFound);
        }
    }

    let res = sqlx::query(
        r#"UPDATE geofences
              SET name       = COALESCE($1, name),
                  center_lat = COALESCE($2, center_lat),
                  center_lng = COALESCE($3, center_lng),
                  radius_m   = COALESCE($4, radius_m),
                  active     = COALESCE($5, active),
                  device_id  = CASE WHEN $7 THEN $6 ELSE device_id END,
                  updated_at = now()
            WHERE id = $8 AND owner_id = $9"#,
    )
    .bind(&req.name)
    .bind(req.center_lat)
    .bind(req.center_lng)
    .bind(req.radius_m)
    .bind(req.active)
    .bind(req.device_id.flatten())          // Some(Some(did))→did, Some(None)→NULL, None→NULL
    .bind(req.device_id.is_some())          // device_id 필드 자체를 보냈는지
    .bind(id)
    .bind(user.user_id)
    .execute(&state.db)
    .await?;

    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    // [2026-08-14] 위치/반경 변경 또는 재활성화 시 geofence_states 리셋 → 다음 ingest 가 첫 측정으로
    //   재arm(이벤트 없음). 기존엔 stale prev(inside) 기준으로 허위 "이탈" push 를 쏘던 것 차단.
    if req.center_lat.is_some() || req.center_lng.is_some() || req.radius_m.is_some()
        || req.active == Some(true) {
        let _ = sqlx::query("DELETE FROM geofence_states WHERE geofence_id = $1")
            .bind(id).execute(&state.db).await;
    }
    fetch(&state, id, user.user_id).await
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let res = sqlx::query("DELETE FROM geofences WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(user.user_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(serde_json::json!({"ok": true})))
}

// ─── 펜스 이력 (geofence_armed / geofence_in / geofence_out) ──────────────

#[derive(Debug, Serialize, FromRow)]
pub struct GeofenceEvent {
    pub id:            i64,
    pub device_id:     i64,
    pub device_name:   Option<String>,
    pub geofence_id:   Option<i64>,
    pub geofence_name: Option<String>,
    pub kind:          String,             // geofence_armed | geofence_in | geofence_out
    pub distance_m:    Option<i64>,
    pub inside:        Option<bool>,       // armed 일 때만
    pub occurred_at:   DateTime<Utc>,
}

async fn history_all(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<GeofenceEvent>>> {
    let rows = sqlx::query_as::<_, GeofenceEvent>(HISTORY_SQL_ALL)
        .bind(user.user_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}

async fn history_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<GeofenceEvent>>> {
    // 본인 펜스 확인
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM geofences WHERE id = $1")
        .bind(id).fetch_optional(&state.db).await?;
    if owner != Some(user.user_id) { return Err(AppError::NotFound); }

    let rows = sqlx::query_as::<_, GeofenceEvent>(HISTORY_SQL_ONE)
        .bind(user.user_id)
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}

const HISTORY_SQL_ALL: &str = r#"
    SELECT
      e.id,
      e.device_id,
      d.display_name                                          AS device_name,
      NULLIF((e.data->>'geofence_id'),'')::bigint            AS geofence_id,
      e.data->>'geofence_name'                               AS geofence_name,
      e.kind,
      NULLIF((e.data->>'distance_m'),'')::bigint             AS distance_m,
      CASE WHEN e.data ? 'inside'
           THEN (e.data->>'inside')::boolean
           ELSE NULL END                                      AS inside,
      e.occurred_at
    FROM events e
    JOIN devices d ON d.id = e.device_id
    WHERE d.owner_id = $1 AND e.user_id = $1
      AND e.kind IN ('geofence_in','geofence_out','geofence_armed')
    ORDER BY e.occurred_at DESC
    LIMIT 100
"#;

const HISTORY_SQL_ONE: &str = r#"
    SELECT
      e.id,
      e.device_id,
      d.display_name                                          AS device_name,
      NULLIF((e.data->>'geofence_id'),'')::bigint            AS geofence_id,
      e.data->>'geofence_name'                               AS geofence_name,
      e.kind,
      NULLIF((e.data->>'distance_m'),'')::bigint             AS distance_m,
      CASE WHEN e.data ? 'inside'
           THEN (e.data->>'inside')::boolean
           ELSE NULL END                                      AS inside,
      e.occurred_at
    FROM events e
    JOIN devices d ON d.id = e.device_id
    WHERE d.owner_id = $1 AND e.user_id = $1
      AND e.kind IN ('geofence_in','geofence_out','geofence_armed')
      AND NULLIF((e.data->>'geofence_id'),'')::bigint = $2
    ORDER BY e.occurred_at DESC
    LIMIT 100
"#;

async fn fetch(state: &AppState, id: i64, owner_id: i64) -> AppResult<Json<GeofenceView>> {
    let row = sqlx::query_as::<_, GeofenceView>(
        r#"SELECT id, owner_id, device_id, name, center_lat, center_lng,
                  radius_m, active, created_at, updated_at
             FROM geofences
            WHERE id = $1 AND owner_id = $2"#,
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}
