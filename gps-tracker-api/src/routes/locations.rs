// /api/v1/devices/:id/locations/* — 위치 시계열 조회.
// 모든 응답은 owner_id 일치 강제 (소유 안 한 디바이스는 404).

use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use std::collections::BTreeMap;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Debug, Serialize, FromRow)]
pub struct LocationView {
    pub recorded_at: DateTime<Utc>,
    pub source: String,
    pub fix: bool,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub sat: Option<i16>,
    pub ttff_s: Option<i32>,
    pub csq: Option<i16>,
    pub reg: Option<i16>,
    pub vbat_mv: Option<i32>,
    pub device_uptime_s: Option<i32>,
    pub heading: Option<f32>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// 최대 반환 개수 (default 100, max 1000)
    pub limit: Option<i64>,
    /// recorded_at >= since (RFC3339)
    pub since: Option<DateTime<Utc>>,
    /// recorded_at <= until (RFC3339)
    pub until: Option<DateTime<Utc>>,
    /// 'l80' 또는 'lte_gnss' 한 가지만 필터
    pub source: Option<String>,
    /// fix=true 만 (오류 좌표 제외)
    pub fix_only: Option<bool>,
    /// Phase 1: POST 단위 grouping 응답 (raw->>'at_ms' + raw->>'ts' 기준).
    /// true = 새 grouped schema (PostGroup[]). false 또는 미지정 = legacy flat (LocationView[]).
    pub grouped: Option<bool>,
}

/// 새 grouped schema 의 row (raw 까지 포함해서 SQL 에서 한 번 fetch).
#[derive(Debug, FromRow)]
struct LocationRowRaw {
    recorded_at: DateTime<Utc>,
    source: String,
    fix: bool,
    lat: Option<f64>,
    lng: Option<f64>,
    sat: Option<i16>,
    ttff_s: Option<i32>,
    csq: Option<i16>,
    reg: Option<i16>,
    vbat_mv: Option<i32>,
    device_uptime_s: Option<i32>,
    heading: Option<f32>,
    raw: Option<Value>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/devices/:id/locations/latest",
            get(latest),
        )
        .route(
            "/devices/:id/locations",
            get(history),
        )
}

async fn ensure_owner(state: &AppState, device_id: i64, user_id: i64) -> AppResult<()> {
    let exists: Option<i64> = sqlx::query_scalar(
        r#"SELECT id FROM devices WHERE id = $1 AND owner_id = $2"#,
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    exists.map(|_| ()).ok_or(AppError::NotFound)
}

async fn latest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Option<LocationView>>> {
    ensure_owner(&state, id, user.user_id).await?;

    // user_id 필터 — 이전 owner 의 위치 이력 노출 차단 (재페어링 시 본인 데이터는
    // user_id 가 일치하므로 자동 복구).
    let row = sqlx::query_as::<_, LocationView>(
        r#"SELECT recorded_at, source, fix, lat, lng, sat, ttff_s,
                  csq, reg, vbat_mv, device_uptime_s, heading
             FROM location_records
            WHERE device_id = $1 AND user_id = $2
            ORDER BY recorded_at DESC
            LIMIT 1"#,
    )
    .bind(id).bind(user.user_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row))
}

async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    ensure_owner(&state, id, user.user_id).await?;

    let limit = q.limit.unwrap_or(100).clamp(1, 10000);
    let grouped = q.grouped.unwrap_or(false);

    // 조건이 NULL이면 무시되도록 COALESCE 패턴 사용. raw 까지 가져옴 (grouped=true 시 사용).
    let rows = sqlx::query_as::<_, LocationRowRaw>(
        r#"SELECT recorded_at, source, fix, lat, lng, sat, ttff_s,
                  csq, reg, vbat_mv, device_uptime_s, heading, raw
             FROM location_records
            WHERE device_id = $1 AND user_id = $7
              AND ($2::timestamptz IS NULL OR recorded_at >= $2)
              AND ($3::timestamptz IS NULL OR recorded_at <= $3)
              AND ($4::text        IS NULL OR source = $4)
              AND ($5::bool        IS NULL OR fix = $5)
            ORDER BY recorded_at DESC
            LIMIT $6"#,
    )
    .bind(id)
    .bind(q.since)
    .bind(q.until)
    .bind(q.source.as_deref())
    .bind(q.fix_only)
    .bind(limit)
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;

    if grouped {
        // Phase 1: POST 단위 grouping. key = (raw.at_ms, raw.ts).
        // 둘 중 하나라도 None 이면 legacy/anonymous row — group key 에 recorded_at 도 포함해서 사실상 row 별 unique group.
        // 결과는 post_at DESC.
        let mut buckets: BTreeMap<(i64, i64, i64), GroupedPost> = BTreeMap::new();
        for row in rows {
            let at_ms = row.raw.as_ref().and_then(|r| r.get("at_ms")).and_then(|v| v.as_i64()).unwrap_or(-1);
            let ts    = row.raw.as_ref().and_then(|r| r.get("ts"   )).and_then(|v| v.as_i64()).unwrap_or(-1);
            // legacy row (at_ms/ts 없음) → recorded_at 자체를 key 에 넣어 row 별 group.
            let row_unique = if at_ms < 0 && ts < 0 { row.recorded_at.timestamp_micros() } else { 0 };
            let key = (at_ms, ts, row_unique);
            let group = buckets.entry(key).or_insert_with(|| GroupedPost {
                post_at:    row.recorded_at,
                uptime_s:   row.raw.as_ref().and_then(|r| r.get("ts")).and_then(|v| v.as_i64()).map(|v| v as i32),
                vbat_mv:    row.vbat_mv,
                csq:        row.csq,
                reg:        row.reg,
                batch_size: 0,
                fixes:      Vec::new(),
            });
            if row.recorded_at > group.post_at { group.post_at = row.recorded_at; }
            group.batch_size += 1;
            group.fixes.push(GroupedFix {
                recorded_at: row.recorded_at,
                source:      row.source,
                fix:         row.fix,
                lat:         row.lat,
                lng:         row.lng,
                sat:         row.sat,
                ttff_s:      row.ttff_s,
                heading:     row.heading,
            });
        }
        // fixes 는 시간순 ASC 가 polyline 그리기 자연.
        let mut groups: Vec<GroupedPost> = buckets.into_values().map(|mut g| {
            g.fixes.sort_by(|a, b| a.recorded_at.cmp(&b.recorded_at));
            g
        }).collect();
        groups.sort_by(|a, b| b.post_at.cmp(&a.post_at));   // 최신 POST 먼저
        Ok(Json(json!(groups)))
    } else {
        // Legacy flat — LocationView 와 schema 동일.
        let legacy: Vec<LocationView> = rows.into_iter().map(|r| LocationView {
            recorded_at: r.recorded_at, source: r.source, fix: r.fix,
            lat: r.lat, lng: r.lng, sat: r.sat, ttff_s: r.ttff_s,
            csq: r.csq, reg: r.reg, vbat_mv: r.vbat_mv,
            device_uptime_s: r.device_uptime_s, heading: r.heading,
        }).collect();
        Ok(Json(json!(legacy)))
    }
}

#[derive(Debug, Serialize)]
struct GroupedFix {
    recorded_at: DateTime<Utc>,
    source:      String,
    fix:         bool,
    lat:         Option<f64>,
    lng:         Option<f64>,
    sat:         Option<i16>,
    ttff_s:      Option<i32>,
    heading:     Option<f32>,
}

#[derive(Debug, Serialize)]
struct GroupedPost {
    post_at:    DateTime<Utc>,
    uptime_s:   Option<i32>,
    vbat_mv:    Option<i32>,
    csq:        Option<i16>,
    reg:        Option<i16>,
    batch_size: i32,
    fixes:      Vec<GroupedFix>,
}
