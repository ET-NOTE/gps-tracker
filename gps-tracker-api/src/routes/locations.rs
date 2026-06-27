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
    // Phase 6: anchor row 만 NOT NULL. batch 의 14 sibling row 는 NULL.
    fixes_jsonb: Option<Value>,
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

    // 조건이 NULL이면 무시되도록 COALESCE 패턴 사용. raw + fixes_jsonb 까지 가져옴 (grouped=true 시 사용).
    let rows = sqlx::query_as::<_, LocationRowRaw>(
        r#"SELECT recorded_at, source, fix, lat, lng, sat, ttff_s,
                  csq, reg, vbat_mv, device_uptime_s, heading, raw, fixes_jsonb
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
        //
        // Phase 6C: anchor row (fixes_jsonb NOT NULL) 가 그룹에 있으면 그 jsonb 만 unnest
        // 해서 fixes 채움. 같은 그룹의 14 column-sibling 은 무시 (이미 jsonb 에 포함됨).
        // anchor 없으면 legacy column 경로 그대로 — backward compat 100%.
        //
        // 결과는 post_at DESC.
        let mut buckets: BTreeMap<(i64, i64, i64), GroupedPostBuilder> = BTreeMap::new();
        for row in rows {
            let at_ms = row.raw.as_ref().and_then(|r| r.get("at_ms")).and_then(|v| v.as_i64()).unwrap_or(-1);
            let ts    = row.raw.as_ref().and_then(|r| r.get("ts"   )).and_then(|v| v.as_i64()).unwrap_or(-1);
            // legacy row (at_ms/ts 없음) → recorded_at 자체를 key 에 넣어 row 별 group.
            let row_unique = if at_ms < 0 && ts < 0 { row.recorded_at.timestamp_micros() } else { 0 };
            let key = (at_ms, ts, row_unique);
            let group = buckets.entry(key).or_insert_with(|| GroupedPostBuilder {
                post_at:    row.recorded_at,
                uptime_s:   row.raw.as_ref().and_then(|r| r.get("ts")).and_then(|v| v.as_i64()).map(|v| v as i32),
                vbat_mv:    row.vbat_mv,
                csq:        row.csq,
                reg:        row.reg,
                ttff_s:     row.ttff_s,
                heading:    row.heading,
                column_fixes: Vec::new(),
                anchor_jsonb: None,
                anchor_at:    None,
            });
            if row.recorded_at > group.post_at { group.post_at = row.recorded_at; }
            if let Some(jsonb) = &row.fixes_jsonb {
                // anchor row — jsonb + anchor metadata 보존 (모든 fix 에 공유).
                group.anchor_jsonb = Some(jsonb.clone());
                group.anchor_at    = Some(row.recorded_at);
                group.ttff_s       = row.ttff_s;
                group.heading      = row.heading;
                group.vbat_mv      = row.vbat_mv;
                group.csq          = row.csq;
                group.reg          = row.reg;
            }
            // column_fixes — anchor 없을 때 fallback 으로 사용. anchor 있으면 무시.
            group.column_fixes.push(GroupedFix {
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
        let mut groups: Vec<GroupedPost> = buckets.into_values().map(|b| {
            let fixes = match (b.anchor_jsonb.as_ref(), b.anchor_at) {
                (Some(jsonb), Some(anchor_at)) => unnest_jsonb_fixes(jsonb, anchor_at, b.ttff_s, b.heading),
                _ => b.column_fixes,
            };
            let mut sorted = fixes;
            sorted.sort_by(|a, b| a.recorded_at.cmp(&b.recorded_at));
            GroupedPost {
                post_at:    b.post_at,
                uptime_s:   b.uptime_s,
                vbat_mv:    b.vbat_mv,
                csq:        b.csq,
                reg:        b.reg,
                batch_size: sorted.len() as i32,
                fixes:      sorted,
            }
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

/// Phase 6C: 그룹 빌더. anchor row 의 jsonb 가 있으면 그것을 unnest, 없으면 column_fixes 사용.
struct GroupedPostBuilder {
    post_at:      DateTime<Utc>,
    uptime_s:     Option<i32>,
    vbat_mv:      Option<i32>,
    csq:          Option<i16>,
    reg:          Option<i16>,
    ttff_s:       Option<i32>,
    heading:      Option<f32>,
    column_fixes: Vec<GroupedFix>,
    anchor_jsonb: Option<Value>,
    anchor_at:    Option<DateTime<Utc>>,
}

/// jsonb 포맷 A unnest: anchor_at + at_ms (음 offset) = fix recorded_at.
/// jsonb 에 없는 source/ttff_s/heading 은 anchor row 의 column 값에서 복사.
fn unnest_jsonb_fixes(
    jsonb: &Value,
    anchor_at: DateTime<Utc>,
    ttff_s: Option<i32>,
    heading: Option<f32>,
) -> Vec<GroupedFix> {
    let arr = match jsonb.as_array() { Some(a) => a, None => return Vec::new() };
    arr.iter().filter_map(|item| {
        let at_ms = item.get("at_ms").and_then(|v| v.as_i64()).unwrap_or(0);
        let lat   = item.get("lat").and_then(|v| v.as_f64());
        let lng   = item.get("lng").and_then(|v| v.as_f64());
        let sat   = item.get("sat").and_then(|v| v.as_i64()).map(|v| v as i16);
        if lat.is_none() || lng.is_none() { return None; }
        Some(GroupedFix {
            recorded_at: anchor_at + chrono::Duration::milliseconds(at_ms),
            source:      "l80".to_string(),  // batch fix 는 항상 GNSS (ingest.rs 참고)
            fix:         true,
            lat, lng, sat,
            ttff_s,
            heading,
        })
    }).collect()
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
