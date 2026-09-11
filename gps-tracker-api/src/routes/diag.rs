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
