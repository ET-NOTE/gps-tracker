// /api/v1/corporate/* — 법인차 운행 관리 전용 엔드포인트.
//
// 게이팅: account_type='corporate_fleet' 인 사용자만 (또는 디바이스 override).
//        리포트는 추가로 활성 'corporate_report' 구독 필요.
//
// 핵심 흐름:
//   1) 회사 정보 등록 (사업자번호, 회사명)
//   2) 직원 등록 (운전자 후보)
//   3) 운행 목록 조회 — events 테이블의 wake/sleep 쌍에서 동적 산출
//   4) 운행별 주석 저장 (용무, 운전자, 유류) — trip_annotations
//   5) HTML 리포트 출력 (PDF 인쇄용)

use axum::{
    extract::{Path, Query, State},
    routing::{get, post, delete, patch},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    services::{credits, kakao_geo},
    state::AppState,
};

const SUB_KIND: &str = "corporate_report";

pub fn router() -> Router<AppState> {
    Router::new()
        // 회사 정보
        .route("/corporate/info", get(get_info).put(put_info))
        // 직원
        .route("/corporate/staff",       get(list_staff).post(create_staff))
        .route("/corporate/staff/:id",   patch(update_staff).delete(remove_staff))
        // 운행
        .route("/corporate/devices/:id/trips",                get(list_trips))
        .route("/corporate/devices/:id/trips/annotation",     patch(upsert_annotation))
        .route("/corporate/devices/:id/trips.csv",            get(trips_csv))
        // (2026-07-28) Stage-4B-2: 월간 운행기록부 XLSX. type=nts|ours, month=YYYY-MM.
        .route("/corporate/report.xlsx",                      get(report_xlsx))
        // (2026-07-28) Stage-4D: 현재 캐시된 오피넷 유가 (프론트 badge 용).
        .route("/corporate/fuel-prices",                      get(get_fuel_prices))
        // 구독
        .route("/corporate/subscription", get(get_subscription).post(buy_subscription))
}

// ─── 회사 정보 ───────────────────────────────────────
#[derive(Debug, Serialize, FromRow)]
struct CorporateInfo {
    user_id:         i64,
    business_number: Option<String>,
    company_name:    Option<String>,
    address:         Option<String>,
    representative:  Option<String>,
    updated_at:      DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct UpdateInfo {
    business_number: Option<String>,
    company_name:    Option<String>,
    address:         Option<String>,
    representative:  Option<String>,
}

async fn get_info(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<CorporateInfo>> {
    sqlx::query("INSERT INTO corporate_info (user_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(user.user_id).execute(&state.db).await?;
    let row: CorporateInfo = sqlx::query_as(
        r#"SELECT user_id, business_number, company_name, address, representative, updated_at
             FROM corporate_info WHERE user_id = $1"#,
    )
    .bind(user.user_id).fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn put_info(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<UpdateInfo>,
) -> AppResult<Json<CorporateInfo>> {
    sqlx::query(
        r#"INSERT INTO corporate_info (user_id, business_number, company_name, address, representative, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             business_number = COALESCE(EXCLUDED.business_number, corporate_info.business_number),
             company_name    = COALESCE(EXCLUDED.company_name,    corporate_info.company_name),
             address         = COALESCE(EXCLUDED.address,         corporate_info.address),
             representative  = COALESCE(EXCLUDED.representative,  corporate_info.representative),
             updated_at      = NOW()"#,
    )
    .bind(user.user_id)
    .bind(req.business_number)
    .bind(req.company_name)
    .bind(req.address)
    .bind(req.representative)
    .execute(&state.db).await?;
    get_info(State(state), user).await
}

// ─── 직원 ────────────────────────────────────────────
#[derive(Debug, Serialize, FromRow)]
struct Staff {
    id:         i64,
    user_id:    i64,
    name:       String,
    role:       Option<String>,
    phone:      Option<String>,
    active:     bool,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct StaffPayload {
    name:   String,
    role:   Option<String>,
    phone:  Option<String>,
    active: Option<bool>,
}

async fn list_staff(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<Staff>>> {
    let rows = sqlx::query_as::<_, Staff>(
        r#"SELECT id, user_id, name, role, phone, active, created_at
             FROM staff
            WHERE user_id = $1
            ORDER BY active DESC, name"#,
    )
    .bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

async fn create_staff(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<StaffPayload>,
) -> AppResult<Json<Staff>> {
    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(AppError::BadRequest("name 1..=64".into()));
    }
    let row: Staff = sqlx::query_as(
        r#"INSERT INTO staff (user_id, name, role, phone, active)
           VALUES ($1, $2, $3, $4, COALESCE($5, TRUE))
           RETURNING id, user_id, name, role, phone, active, created_at"#,
    )
    .bind(user.user_id).bind(name).bind(req.role).bind(req.phone).bind(req.active)
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn update_staff(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<StaffPayload>,
) -> AppResult<Json<Staff>> {
    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(AppError::BadRequest("name 1..=64".into()));
    }
    let row: Option<Staff> = sqlx::query_as(
        r#"UPDATE staff SET name = $3, role = $4, phone = $5,
                            active = COALESCE($6, active)
            WHERE id = $1 AND user_id = $2
        RETURNING id, user_id, name, role, phone, active, created_at"#,
    )
    .bind(id).bind(user.user_id).bind(name).bind(req.role).bind(req.phone).bind(req.active)
    .fetch_optional(&state.db).await?;
    Ok(Json(row.ok_or(AppError::NotFound)?))
}

async fn remove_staff(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    // soft delete (active=FALSE) — 과거 운행 주석에서 driver_staff_id 참조 보존
    let n = sqlx::query("UPDATE staff SET active = FALSE WHERE id = $1 AND user_id = $2")
        .bind(id).bind(user.user_id)
        .execute(&state.db).await?
        .rows_affected();
    if n == 0 { return Err(AppError::NotFound); }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── 운행 (trip 산출 + annotation) ──────────────────
#[derive(Debug, Deserialize)]
struct TripQuery {
    from: Option<String>,    // ISO date or rfc3339
    to:   Option<String>,
}

#[derive(Debug, Serialize)]
struct Trip {
    started_at:    DateTime<Utc>,
    ended_at:      Option<DateTime<Utc>>,
    duration_min:  Option<i64>,
    distance_m:    f64,
    start_lat:     Option<f64>,
    start_lng:     Option<f64>,
    start_address: Option<String>,
    end_lat:       Option<f64>,
    end_lng:       Option<f64>,
    end_address:   Option<String>,
    annotation:    Option<TripAnnotation>,
}

#[derive(Debug, Serialize, FromRow, Clone)]
struct TripAnnotation {
    id:              i64,
    trip_started_at: DateTime<Utc>,
    purpose:         String,
    purpose_note:    Option<String>,
    driver_staff_id: Option<i64>,
    driver_name:     Option<String>,
    fuel_liters:     Option<f64>,
    fuel_cost:       Option<i32>,
    note:            Option<String>,
}

async fn list_trips(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    Query(q): Query<TripQuery>,
) -> AppResult<Json<Vec<Trip>>> {
    verify_device_owner(&state, user.user_id, device_id).await?;
    let (from, to) = parse_range(&q)?;
    Ok(Json(compute_trips_inner(&state, user.user_id, device_id, from, to).await?))
}

// (2026-07-28) Stage-4B-2: XLSX 리포트에서 재사용하기 위해 list_trips 의 코어 로직을
// 순수 함수로 분리. axum 추출자 없이 device 별 trip 을 계산.
async fn compute_trips_inner(
    state: &AppState,
    user_id: i64,
    device_id: i64,
    from: DateTime<Utc>,
    to:   DateTime<Utc>,
) -> AppResult<Vec<Trip>> {
    // 1) wake/sleep_enter 페어링으로 trip 경계 산출 — user_id 격리
    let events: Vec<(String, DateTime<Utc>, Option<serde_json::Value>)> = sqlx::query_as(
        r#"SELECT kind, occurred_at, data
             FROM events
            WHERE device_id = $1 AND user_id = $4
              AND kind IN ('wake','sleep_enter')
              AND occurred_at >= $2 AND occurred_at <= $3
            ORDER BY occurred_at ASC"#,
    )
    .bind(device_id).bind(from).bind(to).bind(user_id)
    .fetch_all(&state.db).await?;

    let mut trips = pair_trips(&events);

    // 2) sleep/wake 이벤트가 0건 → motion-based fallback
    if trips.is_empty() {
        trips = motion_based_trips(&state.db, device_id, user_id, from, to).await?;
    }

    // 3) trip endpoints
    let trip_rows = collect_trip_endpoints(&state.db, device_id, user_id, &trips, to).await?;

    // 4) 거리 계산용 fixes
    let all_fixes: Vec<(DateTime<Utc>, f64, f64)> = sqlx::query_as(
        r#"SELECT recorded_at, lat, lng FROM location_records
            WHERE device_id = $1 AND user_id = $4 AND fix = TRUE
              AND lat IS NOT NULL AND lng IS NOT NULL
              AND recorded_at >= $2 AND recorded_at <= $3
            ORDER BY recorded_at ASC"#,
    )
    .bind(device_id).bind(from).bind(to).bind(user_id)
    .fetch_all(&state.db).await?;

    // 5) batch reverse-geocode
    let mut coords_to_resolve: Vec<(f64, f64)> = Vec::new();
    let mut idx_map: Vec<(usize, usize)> = Vec::with_capacity(trips.len());
    for (_i, _t) in trips.iter().enumerate() {
        let row = trip_rows.get(_i);
        let s_idx = if let Some(r) = row {
            if let (Some(la), Some(ln)) = (r.start_lat, r.start_lng) {
                coords_to_resolve.push((la, ln));
                Some(coords_to_resolve.len() - 1)
            } else { None }
        } else { None };
        let e_idx = if let Some(r) = row {
            if let (Some(la), Some(ln)) = (r.end_lat, r.end_lng) {
                coords_to_resolve.push((la, ln));
                Some(coords_to_resolve.len() - 1)
            } else { None }
        } else { None };
        idx_map.push((s_idx.unwrap_or(usize::MAX), e_idx.unwrap_or(usize::MAX)));
    }
    let resolved = if coords_to_resolve.is_empty() { vec![] }
                   else { kakao_geo::reverse_many_cached(&state.db, &coords_to_resolve).await };

    // 6) annotations
    let annotations = load_annotations(state, device_id, user_id, from, to).await?;

    // 7) 최종 Trip 조립
    let mut out = Vec::with_capacity(trips.len());
    for (i, (s, e)) in trips.iter().enumerate() {
        let end = e.unwrap_or(to);
        let slice: Vec<(f64, f64)> = all_fixes.iter()
            .filter(|(t, _, _)| *t >= *s && *t <= end)
            .map(|(_, la, ln)| (*la, *ln))
            .collect();
        let distance_m = path_distance(&slice);

        let row = trip_rows.get(i).cloned().unwrap_or_default();
        let (s_idx, e_idx) = idx_map[i];
        let start_address = if s_idx < usize::MAX {
            resolved.get(s_idx).cloned().flatten().map(|r| r.short())
        } else { None };
        let end_address = if e_idx < usize::MAX {
            resolved.get(e_idx).cloned().flatten().map(|r| r.short())
        } else { None };

        let duration_min = e.map(|e| (e - *s).num_seconds() / 60);
        let annotation = annotations.iter().find(|a| a.trip_started_at == *s).cloned();

        out.push(Trip {
            started_at: *s,
            ended_at:   *e,
            duration_min,
            distance_m,
            start_lat:  row.start_lat,
            start_lng:  row.start_lng,
            start_address,
            end_lat:    row.end_lat,
            end_lng:    row.end_lng,
            end_address,
            annotation,
        });
    }
    Ok(out)
}

// ── 헬퍼: wake/sleep 이벤트 → trip 경계 ─────────────
//
// 원칙: 한 trip 은 wake → sleep_enter. 단, sleep_enter 누락 후 다음 wake 가 오면
//       그 시점에 이전 trip 을 닫는다 (None 상태로 두면 거리 계산이 다음날까지 늘어나는 버그).
//       마지막 trip 만 sleep_enter 누락 시 None 으로 남김 (디바이스가 아직 깨어있을 수 있음).
//
// sleep_enter 의 data.stopped_at: 펌웨어가 보낸 "진짜 정지 시각" (sleep timeout 역산).
// 있으면 그것을 trip 종료 시각으로 사용. 단 검증 통과해야:
//   - 파싱 가능
//   - 운행 시작(wake) 보다 늦음
//   - occurred_at 보다 미래 30초 이상 X (clock skew 한계)
// 무효 / 미제공 → occurred_at 사용 (구버전 펌웨어 호환).
fn pair_trips(events: &[(String, DateTime<Utc>, Option<serde_json::Value>)])
    -> Vec<(DateTime<Utc>, Option<DateTime<Utc>>)>
{
    let mut trips = Vec::new();
    let mut cur_start: Option<DateTime<Utc>> = None;
    for (kind, t, data) in events {
        match kind.as_str() {
            "wake" => {
                if let Some(s) = cur_start.take() { trips.push((s, Some(*t))); }
                cur_start = Some(*t);
            }
            "sleep_enter" => {
                if let Some(s) = cur_start.take() {
                    let end = effective_sleep_end(s, *t, data.as_ref());
                    trips.push((s, Some(end)));
                }
                // wake 없이 sleep_enter 만: 무시.
            }
            _ => {}
        }
    }
    if let Some(s) = cur_start.take() { trips.push((s, None)); }
    trips
}

// 검증된 진짜 정지 시각 결정 — fallback 안전장치 포함.
// 우선순위:
//   1) data.stopped_at (RFC3339) — 펌웨어가 epoch 시각 가지면 직접 표기
//   2) data.stopped_offset_s (정수, 초) — 펌웨어가 시각 못 가지면 "마지막 모션 후 N초"
//   3) occurred_at — 위 둘 다 없거나 invalid 면 이벤트 도착 시각으로 fallback
fn effective_sleep_end(
    wake_at: DateTime<Utc>,
    occurred_at: DateTime<Utc>,
    data: Option<&serde_json::Value>,
) -> DateTime<Utc> {
    // 1) stopped_at (RFC3339)
    if let Some(s) = data.and_then(|d| d.get("stopped_at")).and_then(|v| v.as_str()) {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(s) {
            let stopped = parsed.with_timezone(&Utc);
            if validate(stopped, wake_at, occurred_at) {
                return stopped;
            }
        }
    }
    // 2) stopped_offset_s (sec) — occurred_at - offset = stopped_at
    if let Some(off) = data.and_then(|d| d.get("stopped_offset_s")).and_then(|v| v.as_i64()) {
        if off >= 0 && off < 86_400 {   // 0초 ~ 24시간 사이만 허용
            let stopped = occurred_at - chrono::Duration::seconds(off);
            if validate(stopped, wake_at, occurred_at) {
                return stopped;
            }
        }
    }
    occurred_at
}

fn validate(
    stopped: DateTime<Utc>,
    wake_at: DateTime<Utc>,
    occurred_at: DateTime<Utc>,
) -> bool {
    //  - 운행 시작 이후여야 함 (시작 전이면 모순)
    //  - 도착 시각 + 30초 까지만 허용 (시계 skew 마진. 그 이상 미래는 잘못된 timestamp)
    //  - 도착 시각 - 24시간 이상 과거면 의심
    stopped > wake_at
        && stopped <= occurred_at + chrono::Duration::seconds(30)
        && stopped >= occurred_at - chrono::Duration::hours(24)
}

// ── 헬퍼: 짧은 gap 으로 갈라진 trip 들을 합침 (보류) ──
//
// 디바이스 펌웨어 sleep timeout 정책에서 일관 처리하기로 결정해 호출 안 함.
// 필요 시 list_trips() 의 2b) 단계에서 한 줄로 재활성:
//   trips = merge_short_gaps(trips, chrono::Duration::seconds(MOTION_GAP_SEC));
//
// fn merge_short_gaps(
//     trips: Vec<(DateTime<Utc>, Option<DateTime<Utc>>)>,
//     max_gap: chrono::Duration,
// ) -> Vec<(DateTime<Utc>, Option<DateTime<Utc>>)> {
//     let mut out: Vec<(DateTime<Utc>, Option<DateTime<Utc>>)> = Vec::with_capacity(trips.len());
//     for trip in trips {
//         if let Some(last) = out.last_mut() {
//             if let Some(last_end) = last.1 {
//                 if (trip.0 - last_end) < max_gap {
//                     last.1 = trip.1;
//                     continue;
//                 }
//             }
//         }
//         out.push(trip);
//     }
//     out
// }

// ── 헬퍼: 절전 안 쓰는 always-on 디바이스용 motion-based trip 추출 ──
//
// >10분 fix 공백 = 운행 경계로 간주. 한 운행은 연속 fix 시퀀스.
const MOTION_GAP_SEC: i64 = 10 * 60;
async fn motion_based_trips(
    db: &sqlx::PgPool,
    device_id: i64,
    user_id: i64,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> AppResult<Vec<(DateTime<Utc>, Option<DateTime<Utc>>)>> {
    let times: Vec<DateTime<Utc>> = sqlx::query_scalar(
        r#"SELECT recorded_at FROM location_records
            WHERE device_id = $1 AND user_id = $4 AND fix = TRUE
              AND recorded_at >= $2 AND recorded_at <= $3
            ORDER BY recorded_at ASC"#,
    )
    .bind(device_id).bind(from).bind(to).bind(user_id)
    .fetch_all(db).await?;
    if times.is_empty() { return Ok(vec![]); }

    let mut trips = Vec::new();
    let mut start = times[0];
    let mut last  = times[0];
    for &t in &times[1..] {
        if (t - last).num_seconds() > MOTION_GAP_SEC {
            trips.push((start, Some(last)));
            start = t;
        }
        last = t;
    }
    trips.push((start, Some(last)));
    Ok(trips)
}

// ── 헬퍼: 모든 trip 의 시작/끝 좌표를 한 SQL 로 일괄 추출 ──
//
// PostgreSQL UNNEST + LATERAL DISTINCT ON. trip 갯수만큼 round-trip 안 하고 1회.
#[derive(Debug, Default, Clone)]
struct TripEndpoint {
    start_lat: Option<f64>,
    start_lng: Option<f64>,
    end_lat:   Option<f64>,
    end_lng:   Option<f64>,
}

async fn collect_trip_endpoints(
    db: &sqlx::PgPool,
    device_id: i64,
    user_id: i64,
    trips: &[(DateTime<Utc>, Option<DateTime<Utc>>)],
    fallback_end: DateTime<Utc>,
) -> AppResult<Vec<TripEndpoint>> {
    if trips.is_empty() { return Ok(vec![]); }
    let starts: Vec<DateTime<Utc>> = trips.iter().map(|(s, _)| *s).collect();
    let ends:   Vec<DateTime<Utc>> = trips.iter().map(|(_, e)| e.unwrap_or(fallback_end)).collect();

    // 한 쿼리로 모든 trip 의 첫·마지막 fix 좌표 — user_id 격리
    let rows: Vec<(i32, Option<f64>, Option<f64>, Option<f64>, Option<f64>)> = sqlx::query_as(
        r#"
        WITH t AS (
            SELECT idx, s_at, e_at FROM
            UNNEST($2::TIMESTAMPTZ[], $3::TIMESTAMPTZ[])
                WITH ORDINALITY AS u(s_at, e_at, idx)
        )
        SELECT t.idx::INT4 AS idx,
               (SELECT lat FROM location_records lr
                  WHERE lr.device_id = $1 AND lr.user_id = $4 AND lr.fix = TRUE
                    AND lr.recorded_at >= t.s_at AND lr.recorded_at <= t.e_at
                  ORDER BY lr.recorded_at ASC LIMIT 1) AS start_lat,
               (SELECT lng FROM location_records lr
                  WHERE lr.device_id = $1 AND lr.user_id = $4 AND lr.fix = TRUE
                    AND lr.recorded_at >= t.s_at AND lr.recorded_at <= t.e_at
                  ORDER BY lr.recorded_at ASC LIMIT 1) AS start_lng,
               (SELECT lat FROM location_records lr
                  WHERE lr.device_id = $1 AND lr.user_id = $4 AND lr.fix = TRUE
                    AND lr.recorded_at >= t.s_at AND lr.recorded_at <= t.e_at
                  ORDER BY lr.recorded_at DESC LIMIT 1) AS end_lat,
               (SELECT lng FROM location_records lr
                  WHERE lr.device_id = $1 AND lr.user_id = $4 AND lr.fix = TRUE
                    AND lr.recorded_at >= t.s_at AND lr.recorded_at <= t.e_at
                  ORDER BY lr.recorded_at DESC LIMIT 1) AS end_lng
          FROM t
          ORDER BY t.idx
        "#,
    )
    .bind(device_id).bind(&starts).bind(&ends).bind(user_id)
    .fetch_all(db).await?;

    let mut out = vec![TripEndpoint::default(); trips.len()];
    for (idx, sla, sln, ela, eln) in rows {
        let i = (idx as usize).saturating_sub(1);
        if i < out.len() {
            out[i] = TripEndpoint {
                start_lat: sla, start_lng: sln,
                end_lat:   ela, end_lng:   eln,
            };
        }
    }
    Ok(out)
}

async fn load_annotations(
    state: &AppState,
    device_id: i64,
    user_id: i64,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> AppResult<Vec<TripAnnotation>> {
    let rows = sqlx::query_as::<_, TripAnnotation>(
        r#"SELECT a.id, a.trip_started_at, a.purpose, a.purpose_note,
                  a.driver_staff_id, s.name AS driver_name,
                  a.fuel_liters::FLOAT8 AS fuel_liters,
                  a.fuel_cost, a.note
             FROM trip_annotations a
        LEFT JOIN staff s ON s.id = a.driver_staff_id
            WHERE a.device_id = $1 AND a.user_id = $4
              AND a.trip_started_at >= $2 AND a.trip_started_at <= $3"#,
    )
    .bind(device_id).bind(from).bind(to).bind(user_id)
    .fetch_all(&state.db).await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
struct AnnotationPayload {
    trip_started_at: DateTime<Utc>,
    purpose:         Option<String>,        // commute|business|other|unspecified
    purpose_note:    Option<String>,
    driver_staff_id: Option<i64>,
    fuel_liters:     Option<f64>,
    fuel_cost:       Option<i32>,
    note:            Option<String>,
}

async fn upsert_annotation(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    Json(req): Json<AnnotationPayload>,
) -> AppResult<Json<TripAnnotation>> {
    verify_device_owner(&state, user.user_id, device_id).await?;
    let purpose = req.purpose.unwrap_or_else(|| "unspecified".into());
    if !["commute","business","other","unspecified"].contains(&purpose.as_str()) {
        return Err(AppError::BadRequest("invalid purpose".into()));
    }
    // driver_staff_id 가 있으면 본인 staff 인지 검증
    if let Some(sid) = req.driver_staff_id {
        let owner: Option<i64> = sqlx::query_scalar(
            "SELECT user_id FROM staff WHERE id = $1",
        ).bind(sid).fetch_optional(&state.db).await?.flatten();
        if owner != Some(user.user_id) {
            return Err(AppError::BadRequest("driver_staff_id 소유자 불일치".into()));
        }
    }

    sqlx::query(
        r#"INSERT INTO trip_annotations
              (device_id, user_id, trip_started_at, purpose, purpose_note, driver_staff_id, fuel_liters, fuel_cost, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (device_id, user_id, trip_started_at) DO UPDATE SET
              purpose         = EXCLUDED.purpose,
              purpose_note    = EXCLUDED.purpose_note,
              driver_staff_id = EXCLUDED.driver_staff_id,
              fuel_liters     = EXCLUDED.fuel_liters,
              fuel_cost       = EXCLUDED.fuel_cost,
              note            = EXCLUDED.note,
              updated_at      = NOW()"#,
    )
    .bind(device_id).bind(user.user_id).bind(req.trip_started_at).bind(purpose).bind(req.purpose_note)
    .bind(req.driver_staff_id).bind(req.fuel_liters).bind(req.fuel_cost).bind(req.note)
    .execute(&state.db).await?;

    let row: TripAnnotation = sqlx::query_as(
        r#"SELECT a.id, a.trip_started_at, a.purpose, a.purpose_note,
                  a.driver_staff_id, s.name AS driver_name,
                  a.fuel_liters::FLOAT8 AS fuel_liters,
                  a.fuel_cost, a.note
             FROM trip_annotations a
        LEFT JOIN staff s ON s.id = a.driver_staff_id
            WHERE a.device_id = $1 AND a.user_id = $2 AND a.trip_started_at = $3"#,
    )
    .bind(device_id).bind(user.user_id).bind(req.trip_started_at)
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

// ─── CSV 내보내기 ──────────────────────────────────
// 엑셀에서 바로 열리는 BOM 포함 UTF-8. 한글 헤더 그대로 사용.
async fn trips_csv(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    Query(q): Query<TripQuery>,
) -> AppResult<axum::response::Response> {
    use axum::response::IntoResponse;
    use axum::http::header;

    // list_trips 와 동일 로직 — 결과만 CSV 직렬화
    let trips_resp = list_trips(State(state.clone()), user.clone(), Path(device_id), Query(q)).await?;
    let trips = trips_resp.0;

    // 회사명 / 단말기명 으로 파일명
    let company: Option<String> = sqlx::query_scalar(
        "SELECT company_name FROM corporate_info WHERE user_id = $1",
    )
    .bind(user.user_id).fetch_optional(&state.db).await?.flatten();
    let device_name: Option<String> = sqlx::query_scalar(
        "SELECT COALESCE(display_name, device_uid) FROM devices WHERE id = $1",
    )
    .bind(device_id).fetch_optional(&state.db).await?.flatten();

    // \u{FEFF} BOM + CRLF (엑셀 친화)
    let mut s = String::new();
    s.push('\u{FEFF}');
    s.push_str("날짜,시작시각,종료시각,운행시간(분),용무,용무메모,출발지,출발좌표,도착지,도착좌표,주행거리(km),운전자,유류(리터),유류비(원),비고\r\n");

    for t in &trips {
        let kst = chrono::FixedOffset::east_opt(9*3600).unwrap();
        let s_kst = t.started_at.with_timezone(&kst);
        let e_kst = t.ended_at.map(|e| e.with_timezone(&kst));
        let date  = s_kst.format("%Y-%m-%d").to_string();
        let stime = s_kst.format("%H:%M").to_string();
        let etime = e_kst.map(|e| e.format("%H:%M").to_string()).unwrap_or_else(|| "—".into());
        let km = t.distance_m / 1000.0;
        let ann = t.annotation.as_ref();
        let purpose = match ann.map(|a| a.purpose.as_str()) {
            Some("commute")  => "출퇴근",
            Some("business") => "업무",
            Some("other")    => "기타",
            _                => "미지정",
        };
        let purpose_note = ann.and_then(|a| a.purpose_note.clone()).unwrap_or_default();
        let driver       = ann.and_then(|a| a.driver_name.clone()).unwrap_or_default();
        let fuel_l       = ann.and_then(|a| a.fuel_liters).map(|v| format!("{v:.2}")).unwrap_or_default();
        let fuel_c       = ann.and_then(|a| a.fuel_cost).map(|v| v.to_string()).unwrap_or_default();
        let note         = ann.and_then(|a| a.note.clone()).unwrap_or_default();
        let s_addr = t.start_address.clone().unwrap_or_default();
        let e_addr = t.end_address.clone().unwrap_or_default();
        let s_coord = match (t.start_lat, t.start_lng) {
            (Some(la), Some(ln)) => format!("{la:.5},{ln:.5}"),
            _ => String::new(),
        };
        let e_coord = match (t.end_lat, t.end_lng) {
            (Some(la), Some(ln)) => format!("{la:.5},{ln:.5}"),
            _ => String::new(),
        };
        let dur = t.duration_min.map(|m| m.to_string()).unwrap_or_default();

        let row = [
            csv_escape(&date),     csv_escape(&stime),  csv_escape(&etime),
            csv_escape(&dur),      csv_escape(purpose), csv_escape(&purpose_note),
            csv_escape(&s_addr),   csv_escape(&s_coord),
            csv_escape(&e_addr),   csv_escape(&e_coord),
            csv_escape(&format!("{km:.2}")),
            csv_escape(&driver),
            csv_escape(&fuel_l),   csv_escape(&fuel_c),
            csv_escape(&note),
        ];
        s.push_str(&row.join(","));
        s.push_str("\r\n");
    }

    // 파일명은 한글 안전하게 RFC5987 인코딩 (filename* utf-8). %escape 직접 구현.
    let prefix = company.as_deref().unwrap_or("법인운행");
    let dev    = device_name.as_deref().unwrap_or("device");
    let today  = chrono::Utc::now().format("%Y%m%d");
    let filename = format!("{}_{}_{}_운행일지.csv", prefix, dev, today);
    let pct = percent_encode(&filename);
    // ASCII fallback + UTF-8 RFC5987
    let cd = format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", pct, pct);

    Ok((
        [(header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
         (header::CONTENT_DISPOSITION, cd)],
        s,
    ).into_response())
}

// ═══════════════════════════════════════════════════════════════
// (2026-07-28) Stage-4B-2: 월간 XLSX 리포트 — 2종 (nts / ours).
// ═══════════════════════════════════════════════════════════════
use crate::services::xlsx_report;

#[derive(Debug, Deserialize)]
struct XlsxQuery {
    /// nts | ours
    #[serde(rename = "type")]
    kind:  Option<String>,
    /// YYYY-MM (default = 이번달 KST)
    month: Option<String>,
    /// device id 콤마 목록. 미지정 = 전체 owner device.
    device_ids: Option<String>,
    /// purpose 콤마 목록 (business|commute|other|unspecified). 미지정 = 전체.
    /// trip.annotation.purpose null 은 'unspecified' 로 취급.
    purposes: Option<String>,
    /// (2026-07-28) Stage-4G: 부서 콤마 목록. 미지정 = 전체.
    /// devices.department NULL/empty 은 '(부서없음)' 그룹으로 취급.
    /// value 에 '(부서없음)' 포함 시 department IS NULL 매칭.
    departments: Option<String>,
}

// (2026-07-28) Stage-4D: 오피넷 캐시된 유가 사용. env override 도 여전히 지원 (지역 특수가).
// XLSX 생성 시점의 캐시 스냅샷을 fn 클로저로 감싸 xlsx_report::ReportContext.fuel_price 에 전달.
fn make_fuel_price_fn(prices: crate::services::opinet::FuelPrices) -> impl Fn(&str) -> i64 + Send + Sync + 'static {
    // Copy each price out of the struct — closure는 'static life.
    let (g, d, l) = (prices.gasoline, prices.diesel, prices.lpg);
    move |fuel_type: &str| -> i64 {
        let env = |k: &str, dflt: i64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(dflt);
        match fuel_type {
            "gasoline" => env("FUEL_PRICE_GASOLINE_KRW", g),
            "diesel"   => env("FUEL_PRICE_DIESEL_KRW",   d),
            "lpg"      => env("FUEL_PRICE_LPG_KRW",      l),
            _          => 0,
        }
    }
}

async fn get_fuel_prices(
    State(state): State<AppState>,
    _user: AuthUser,
) -> AppResult<Json<crate::services::opinet::FuelPrices>> {
    // 캐시 없거나 stale 이면 refetch 시도 (실패해도 fallback 반환).
    let prices = state.opinet.get_or_fetch().await;
    Ok(Json(prices))
}

async fn report_xlsx(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<XlsxQuery>,
) -> AppResult<axum::response::Response> {
    use axum::response::IntoResponse;
    use axum::http::header;
    use chrono::{Datelike, TimeZone, NaiveDate};

    // 구독 활성 확인 — 리포트 종류와 무관하게 corporate_report 구독 필수.
    let sub_active: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"SELECT MAX(expires_at) FROM subscriptions
            WHERE user_id = $1 AND kind = $2 AND expires_at > NOW()"#,
    )
    .bind(user.user_id).bind(SUB_KIND).fetch_optional(&state.db).await?.flatten();
    if sub_active.is_none() {
        return Err(AppError::BadRequest("법인운행 리포트 구독이 필요합니다.".into()));
    }

    let kind = q.kind.as_deref().unwrap_or("ours");
    if kind != "nts" && kind != "ours" {
        return Err(AppError::BadRequest(format!("invalid type: {kind} (nts|ours)")));
    }

    // month 파싱 — 기본은 오늘 (KST) 기준 이번달
    let kst = chrono::FixedOffset::east_opt(9 * 3600).unwrap();
    let now_kst = Utc::now().with_timezone(&kst);
    let ym = q.month.clone().unwrap_or_else(|| now_kst.format("%Y-%m").to_string());
    let (y, m) = ym.split_once('-')
        .and_then(|(y, m)| Some((y.parse::<i32>().ok()?, m.parse::<u32>().ok()?)))
        .ok_or_else(|| AppError::BadRequest(format!("invalid month: {ym} (YYYY-MM)")))?;
    if !(2000..=2100).contains(&y) || !(1..=12).contains(&m) {
        return Err(AppError::BadRequest(format!("invalid month range: {ym}")));
    }
    let from_naive: NaiveDate = NaiveDate::from_ymd_opt(y, m, 1)
        .ok_or_else(|| AppError::BadRequest("invalid date".into()))?;
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let to_naive: NaiveDate = NaiveDate::from_ymd_opt(ny, nm, 1)
        .ok_or_else(|| AppError::BadRequest("invalid date".into()))?;
    let from = kst.from_local_datetime(&from_naive.and_hms_opt(0, 0, 0).unwrap())
        .single().ok_or_else(|| AppError::BadRequest("tz".into()))?.with_timezone(&Utc);
    let to   = kst.from_local_datetime(&to_naive.and_hms_opt(0, 0, 0).unwrap())
        .single().ok_or_else(|| AppError::BadRequest("tz".into()))?.with_timezone(&Utc);

    // 회사 정보
    #[derive(FromRow)]
    struct CorpRow {
        business_number: Option<String>, company_name: Option<String>,
        representative:  Option<String>, address:      Option<String>,
    }
    let corp: Option<CorpRow> = sqlx::query_as(
        "SELECT business_number, company_name, representative, address
           FROM corporate_info WHERE user_id = $1")
    .bind(user.user_id).fetch_optional(&state.db).await?;
    let corp_info = xlsx_report::CorpInfoLite {
        business_number: corp.as_ref().and_then(|c| c.business_number.clone()),
        company_name:    corp.as_ref().and_then(|c| c.company_name.clone()),
        representative:  corp.as_ref().and_then(|c| c.representative.clone()),
        address:         corp.as_ref().and_then(|c| c.address.clone()),
    };

    // 필터 파싱 — 콤마 분리, 공백 trim, 빈 항목 skip.
    let device_id_filter: Option<Vec<i64>> = q.device_ids.as_deref().map(|s|
        s.split(',').filter_map(|v| v.trim().parse::<i64>().ok()).collect::<Vec<_>>())
        .filter(|v| !v.is_empty());
    let purpose_filter: Option<Vec<String>> = q.purposes.as_deref().map(|s|
        s.split(',').map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect::<Vec<_>>())
        .filter(|v| !v.is_empty());
    // 부서 필터. '(부서없음)' sentinel → department IS NULL 매칭.
    let department_filter: Option<Vec<String>> = q.departments.as_deref().map(|s|
        s.split(',').map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect::<Vec<_>>())
        .filter(|v| !v.is_empty());
    let dep_include_null = department_filter.as_ref().map_or(false, |v| v.iter().any(|d| d == "(부서없음)"));
    let dep_names: Vec<String> = department_filter.as_ref().map_or(vec![], |v|
        v.iter().filter(|d| d.as_str() != "(부서없음)").cloned().collect());

    // owner 의 device 목록 (device_id 필터 적용)
    #[derive(FromRow)]
    struct DevRow {
        id: i64, display_name: Option<String>, device_uid: String,
        license_plate: Option<String>, model_year: Option<i32>, engine_cc: Option<i32>,
        purchase_price_krw: Option<i64>, acquired_at: Option<chrono::NaiveDate>,
        department: Option<String>, vehicle_type: Option<String>,
        fuel_efficiency_kmpl: Option<f32>, fuel_type: Option<String>,
    }
    // (Stage-4G) 부서 필터를 SQL WHERE 절로 결합 — SQL 이 복잡해지지만 필터 조합 3개 (id/부서/포함)
    // 각각 optional 이라 conditional 하게 다뤄야 한다.
    // 편의상 owner + department 필터로 먼저 좁힌 뒤, device_id 필터를 in-memory 로 추가 적용.
    let mut devs: Vec<DevRow> = if department_filter.is_some() && !(dep_include_null && dep_names.is_empty()) {
        // department 필터 있음
        if dep_include_null && !dep_names.is_empty() {
            sqlx::query_as(
                r#"SELECT id, display_name, device_uid, license_plate, model_year, engine_cc,
                          purchase_price_krw, acquired_at, department, vehicle_type,
                          fuel_efficiency_kmpl, fuel_type
                     FROM devices
                    WHERE owner_id = $1 AND (department IS NULL OR department = ANY($2::TEXT[]))
                    ORDER BY id"#)
            .bind(user.user_id).bind(&dep_names).fetch_all(&state.db).await?
        } else if !dep_names.is_empty() {
            sqlx::query_as(
                r#"SELECT id, display_name, device_uid, license_plate, model_year, engine_cc,
                          purchase_price_krw, acquired_at, department, vehicle_type,
                          fuel_efficiency_kmpl, fuel_type
                     FROM devices
                    WHERE owner_id = $1 AND department = ANY($2::TEXT[])
                    ORDER BY id"#)
            .bind(user.user_id).bind(&dep_names).fetch_all(&state.db).await?
        } else {
            sqlx::query_as(
                r#"SELECT id, display_name, device_uid, license_plate, model_year, engine_cc,
                          purchase_price_krw, acquired_at, department, vehicle_type,
                          fuel_efficiency_kmpl, fuel_type
                     FROM devices WHERE owner_id = $1 AND department IS NULL
                    ORDER BY id"#)
            .bind(user.user_id).fetch_all(&state.db).await?
        }
    } else {
        sqlx::query_as(
            r#"SELECT id, display_name, device_uid, license_plate, model_year, engine_cc,
                      purchase_price_krw, acquired_at, department, vehicle_type,
                      fuel_efficiency_kmpl, fuel_type
                 FROM devices WHERE owner_id = $1
                ORDER BY id"#)
        .bind(user.user_id).fetch_all(&state.db).await?
    };
    // device_id 필터 in-memory 후처리 (부서 필터와 AND 조합)
    if let Some(ref ids) = device_id_filter {
        let set: std::collections::HashSet<i64> = ids.iter().copied().collect();
        devs.retain(|d| set.contains(&d.id));
    }

    let devices_lite: Vec<xlsx_report::DeviceLite> = devs.iter().map(|d| xlsx_report::DeviceLite {
        id: d.id, display_name: d.display_name.clone(), device_uid: d.device_uid.clone(),
        license_plate: d.license_plate.clone(),
        model_year: d.model_year, engine_cc: d.engine_cc,
        purchase_price_krw: d.purchase_price_krw, acquired_at: d.acquired_at,
        department: d.department.clone(), vehicle_type: d.vehicle_type.clone(),
        fuel_efficiency_kmpl: d.fuel_efficiency_kmpl, fuel_type: d.fuel_type.clone(),
    }).collect();

    // device 별 trip 병렬 계산 — compute_trips_inner 재사용
    // purpose 필터: annotation 없는 trip 은 'unspecified' 로 취급.
    let mut per_device: Vec<(&xlsx_report::DeviceLite, Vec<xlsx_report::TripLite>)> = Vec::with_capacity(devices_lite.len());
    for (i, d) in devs.iter().enumerate() {
        let trips = compute_trips_inner(&state, user.user_id, d.id, from, to).await
            .unwrap_or_default();
        let lite: Vec<xlsx_report::TripLite> = trips.into_iter().filter_map(|t| {
            let purpose = t.annotation.as_ref().map(|a| a.purpose.clone())
                .unwrap_or_else(|| "unspecified".into());
            if let Some(ref allowed) = purpose_filter {
                if !allowed.iter().any(|p| p == &purpose) { return None; }
            }
            Some(xlsx_report::TripLite {
                started_at: t.started_at, ended_at: t.ended_at,
                distance_m: t.distance_m,
                start_address: t.start_address, end_address: t.end_address,
                start_lat: t.start_lat, start_lng: t.start_lng,
                end_lat: t.end_lat, end_lng: t.end_lng,
                purpose:      Some(purpose),
                purpose_note: t.annotation.as_ref().and_then(|a| a.purpose_note.clone()),
                driver_name:  t.annotation.as_ref().and_then(|a| a.driver_name.clone()),
                fuel_liters:  t.annotation.as_ref().and_then(|a| a.fuel_liters),
                fuel_cost_krw: t.annotation.as_ref().and_then(|a| a.fuel_cost.map(|v| v as i64)),
                note:         t.annotation.as_ref().and_then(|a| a.note.clone()),
            })
        }).collect();
        per_device.push((&devices_lite[i], lite));
    }

    // (Stage-4D) 오피넷 캐시 스냅샷 → 하드코딩 대신 최신 유가.
    let fuel_prices = state.opinet.get_or_fetch().await;
    let ctx = xlsx_report::ReportContext {
        month_ym: ym.clone(),
        corp: &corp_info,
        per_device,
        fuel_price: Box::new(make_fuel_price_fn(fuel_prices)),
    };
    let bytes = match kind {
        "nts"  => xlsx_report::build_nts(&ctx),
        "ours" => xlsx_report::build_ours(&ctx),
        _ => unreachable!(),
    }.map_err(|e| anyhow::anyhow!("xlsx build: {e}"))?;

    let kind_ko = if kind == "nts" { "국세청양식" } else { "우리양식" };
    let month_slug = ym.replace('-', "");
    let filename = format!("운행기록부_{}_{}.xlsx", month_slug, kind_ko);
    let pct = percent_encode(&filename);
    let cd = format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", pct, pct);

    // year/month unused 방지 (chrono::Datelike 는 import 확인용 재적용)
    let _ = (now_kst.year(), now_kst.month());

    Ok((
        [(header::CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()),
         (header::CONTENT_DISPOSITION, cd)],
        bytes,
    ).into_response())
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// RFC5987 percent encoding — Content-Disposition filename* 용.
/// 안전 문자만 통과시키고 나머지는 UTF-8 byte 단위 %XX.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' |
            b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ─── 구독 ────────────────────────────────────────────
#[derive(Debug, Serialize)]
struct SubscriptionView {
    active:      bool,
    expires_at:  Option<DateTime<Utc>>,
    price_krw:   i64,                  // 월 구독료 (현재 30,000원 고정 — 추후 ENV)
}

const SUB_PRICE: i64 = 30_000;

fn corporate_sub_price() -> i64 {
    std::env::var("CORPORATE_REPORT_PRICE")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(SUB_PRICE)
}

async fn get_subscription(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<SubscriptionView>> {
    let exp: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"SELECT MAX(expires_at) FROM subscriptions
            WHERE user_id = $1 AND kind = $2 AND expires_at > NOW()"#,
    )
    .bind(user.user_id).bind(SUB_KIND)
    .fetch_optional(&state.db).await?.flatten();
    Ok(Json(SubscriptionView {
        active: exp.is_some(),
        expires_at: exp,
        price_krw: corporate_sub_price(),
    }))
}

async fn buy_subscription(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<SubscriptionView>> {
    let price = corporate_sub_price();
    // 포인트에서 차감 — 부족하면 BadRequest
    credits::charge(
        &state.db, user.user_id, price,
        "subscription", None, Some("corporate_report 1개월"),
    ).await?;

    // 기존 active subscription 끝 시각 + 30일, 없으면 now + 30일
    let cur_exp: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"SELECT MAX(expires_at) FROM subscriptions
            WHERE user_id = $1 AND kind = $2 AND expires_at > NOW()"#,
    )
    .bind(user.user_id).bind(SUB_KIND).fetch_optional(&state.db).await?.flatten();
    let starts_at = cur_exp.unwrap_or_else(Utc::now);
    let expires_at = starts_at + chrono::Duration::days(30);

    sqlx::query(
        r#"INSERT INTO subscriptions (user_id, kind, starts_at, expires_at, paid_credits, note)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
    )
    .bind(user.user_id).bind(SUB_KIND).bind(starts_at).bind(expires_at).bind(price)
    .bind("self-purchase")
    .execute(&state.db).await?;

    Ok(Json(SubscriptionView {
        active: true,
        expires_at: Some(expires_at),
        price_krw: price,
    }))
}

// ─── 헬퍼 ────────────────────────────────────────────
async fn verify_device_owner(state: &AppState, uid: i64, device_id: i64) -> AppResult<()> {
    let owner: Option<i64> = sqlx::query_scalar(
        "SELECT owner_id FROM devices WHERE id = $1",
    )
    .bind(device_id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(uid) { return Err(AppError::NotFound); }
    Ok(())
}

fn parse_range(q: &TripQuery) -> AppResult<(DateTime<Utc>, DateTime<Utc>)> {
    let now = Utc::now();
    let from = match &q.from {
        Some(s) => parse_date_or_rfc3339(s)?,
        None    => now - chrono::Duration::days(31),
    };
    let to = match &q.to {
        Some(s) => parse_date_or_rfc3339_end(s)?,
        None    => now,
    };
    if to < from { return Err(AppError::BadRequest("to < from".into())); }
    Ok((from, to))
}

fn parse_date_or_rfc3339(s: &str) -> AppResult<DateTime<Utc>> {
    if let Ok(t) = DateTime::parse_from_rfc3339(s) { return Ok(t.with_timezone(&Utc)); }
    let t = DateTime::parse_from_rfc3339(&format!("{}T00:00:00+09:00", s))
        .map_err(|e| AppError::BadRequest(format!("bad date: {e}")))?;
    Ok(t.with_timezone(&Utc))
}
fn parse_date_or_rfc3339_end(s: &str) -> AppResult<DateTime<Utc>> {
    if let Ok(t) = DateTime::parse_from_rfc3339(s) { return Ok(t.with_timezone(&Utc)); }
    let t = DateTime::parse_from_rfc3339(&format!("{}T23:59:59+09:00", s))
        .map_err(|e| AppError::BadRequest(format!("bad date: {e}")))?;
    Ok(t.with_timezone(&Utc))
}

fn path_distance(pts: &[(f64, f64)]) -> f64 {
    if pts.len() < 2 { return 0.0; }
    let r = std::f64::consts::PI / 180.0;
    let mut m = 0.0;
    for i in 1..pts.len() {
        let (la1, lo1) = pts[i-1];
        let (la2, lo2) = pts[i];
        let d_la = (la2 - la1) * r;
        let d_lo = (lo2 - lo1) * r;
        let a = (d_la/2.0).sin().powi(2)
              + (la1*r).cos() * (la2*r).cos() * (d_lo/2.0).sin().powi(2);
        m += 2.0 * 6_371_000.0 * a.sqrt().asin();
    }
    m
}
