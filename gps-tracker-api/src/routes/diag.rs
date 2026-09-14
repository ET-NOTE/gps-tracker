// DHT11 온습도 진단 타임시리즈 (2026-09-10, UNO+SIM7080G 쉴드 야간 안정성 시험용).
//
// - POST /gps-tracker/dht          : 디바이스 익명 ingest (nginx: http://gps.serial.kr/dht)
// - GET  /gps-tracker/diagnostic   : 조회 페이지 (nginx: https://gps.serial.kr/diagnostic)
// - GET  /gps-tracker/diagnostic/data : JSON, 최신순, KST 절대시각 문자열 포함
//
// ingest 와 동일하게 익명 (시험용 임시 계측 — 위치/개인정보 없음).

use axum::{
    extract::{Query, State},
    response::Html,
    Json,
};
use chrono::FixedOffset;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{error::AppResult, state::AppState};

#[derive(Debug, Deserialize)]
pub struct DhtPayload {
    pub device_uid: String,
    pub temp_c: Option<f32>,
    pub hum_pct: Option<f32>,
    pub up_ms: Option<i64>,
}

pub async fn dht_ingest(
    State(state): State<AppState>,
    Json(p): Json<DhtPayload>,
) -> AppResult<Json<Value>> {
    // 익명 endpoint 최소 방어: uid 길이 제한 + 물리적으로 불가능한 값 거절.
    let uid: String = p.device_uid.chars().take(64).collect();
    let temp = p.temp_c.filter(|v| (-40.0..=85.0).contains(v));
    let hum = p.hum_pct.filter(|v| (0.0..=100.0).contains(v));

    sqlx::query(
        "INSERT INTO diag_dht (device_uid, temp_c, hum_pct, up_ms) VALUES ($1, $2, $3, $4)",
    )
    .bind(&uid)
    .bind(temp)
    .bind(hum)
    .bind(p.up_ms)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct DataQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub device_uid: Option<String>,
}

pub async fn diag_data(
    State(state): State<AppState>,
    Query(q): Query<DataQuery>,
) -> AppResult<Json<Value>> {
    let limit = q.limit.unwrap_or(300).clamp(1, 5000);
    let offset = q.offset.unwrap_or(0).max(0);
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM diag_dht WHERE ($1::text IS NULL OR device_uid = $1)",
    )
    .bind(&q.device_uid)
    .fetch_one(&state.db)
    .await?;
    let rows = sqlx::query(
        r#"SELECT device_uid, temp_c, hum_pct, up_ms, recorded_at
             FROM diag_dht
            WHERE ($2::text IS NULL OR device_uid = $2)
            ORDER BY recorded_at DESC
            LIMIT $1 OFFSET $3"#,
    )
    .bind(limit)
    .bind(&q.device_uid)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let kst = FixedOffset::east_opt(9 * 3600).expect("KST offset");
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let at: chrono::DateTime<chrono::Utc> = r.get("recorded_at");
            json!({
                "device_uid": r.get::<String, _>("device_uid"),
                "temp_c": r.get::<Option<f32>, _>("temp_c"),
                "hum_pct": r.get::<Option<f32>, _>("hum_pct"),
                "up_ms": r.get::<Option<i64>, _>("up_ms"),
                "kst": at.with_timezone(&kst).format("%Y-%m-%d %H:%M:%S").to_string(),
            })
        })
        .collect();

    Ok(Json(json!({ "count": items.len(), "total": total, "offset": offset, "items": items })))
}

pub async fn diag_page() -> Html<&'static str> {
    Html(include_str!("diag_page.html"))
}

// ── [2026-09-14 KC] 단말 수신 로그 페이지 — GPS 없이도 매 POST 를 리스트업 ──
// 익명 접근이지만 env DIAG_DEVICE_ALLOWLIST (콤마구분 uid) 에 있는 단말만 조회 가능
// (임의 uid 로 운용 단말 telemetry 를 열람하는 것 방지 — KC 시험 단말 전용).

// 허용 조건 (셋 중 하나) — 인증센터에서 유심/계정이 바뀌어도 안 막히도록:
//  ① uid 가 esp- 프리픽스 (KC 시험빌드 단말은 항상 esp-, 운영 단말은 sim-/phone- 로 수렴)
//  ② env DIAG_ALLOW_OWNER_EMAILS(콤마구분) 계정에 페어링된 장치 — 시험 계정이 페어링하면 즉시 허용
//  ③ env DIAG_DEVICE_ALLOWLIST(콤마구분) 에 명시된 uid
async fn device_allowed(db: &sqlx::PgPool, uid: &str) -> bool {
    if uid.starts_with("esp-") {
        return true;
    }
    let in_env = |var: &str, needle: &str| {
        std::env::var(var)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .any(|u| !u.is_empty() && u.eq_ignore_ascii_case(needle))
    };
    if in_env("DIAG_DEVICE_ALLOWLIST", uid) {
        return true;
    }
    let owner_email: Option<String> = sqlx::query_scalar(
        "SELECT u.email FROM devices d JOIN users u ON u.id = d.owner_id WHERE d.device_uid = $1",
    )
    .bind(uid)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    matches!(owner_email, Some(e) if in_env("DIAG_ALLOW_OWNER_EMAILS", &e))
}

#[derive(Debug, Deserialize)]
pub struct DeviceLogQuery {
    pub uid: String,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub async fn device_log_data(
    State(state): State<AppState>,
    Query(q): Query<DeviceLogQuery>,
) -> AppResult<Json<Value>> {
    if !device_allowed(&state.db, &q.uid).await {
        return Ok(Json(json!({ "error": "not allowed", "items": [], "total": 0 })));
    }
    let limit = q.limit.unwrap_or(240).clamp(1, 2000);
    let offset = q.offset.unwrap_or(0).max(0);
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM location_records lr JOIN devices d ON d.id = lr.device_id \
          WHERE d.device_uid = $1",
    )
    .bind(&q.uid)
    .fetch_one(&state.db)
    .await?;
    let rows = sqlx::query(
        r#"SELECT lr.recorded_at,
                  lr.raw->>'ts'      AS ts,
                  lr.raw->>'csq'     AS csq,
                  lr.raw->>'reg'     AS reg,
                  lr.raw->>'band'    AS band,
                  lr.raw->>'vbat_mv' AS vbat_mv,
                  lr.raw->>'cbc_mv'  AS cbc_mv,
                  lr.raw->'l80'->>'fix' AS fix,
                  lr.raw->'l80'->>'sat' AS sat
             FROM location_records lr
             JOIN devices d ON d.id = lr.device_id
            WHERE d.device_uid = $1
            ORDER BY lr.recorded_at DESC
            LIMIT $2 OFFSET $3"#,
    )
    .bind(&q.uid)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;
    let kst = FixedOffset::east_opt(9 * 3600).expect("KST offset");
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let at: chrono::DateTime<chrono::Utc> = r.get("recorded_at");
            json!({
                "kst": at.with_timezone(&kst).format("%Y-%m-%d %H:%M:%S").to_string(),
                "ts": r.get::<Option<String>, _>("ts"),
                "csq": r.get::<Option<String>, _>("csq"),
                "reg": r.get::<Option<String>, _>("reg"),
                "band": r.get::<Option<String>, _>("band"),
                "vbat_mv": r.get::<Option<String>, _>("vbat_mv"),
                "cbc_mv": r.get::<Option<String>, _>("cbc_mv"),
                "fix": r.get::<Option<String>, _>("fix"),
                "sat": r.get::<Option<String>, _>("sat"),
            })
        })
        .collect();
    Ok(Json(json!({ "uid": q.uid, "count": items.len(), "total": total, "offset": offset, "items": items })))
}

pub async fn device_log_page() -> Html<&'static str> {
    Html(include_str!("diag_device_page.html"))
}
