// All public and private readers use the same batch-expanded stream.
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use std::collections::BTreeMap;

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
    pub cbc_mv: Option<i32>,
    pub device_uptime_s: Option<i32>,
    pub heading: Option<f32>,
    pub speed_kmh: Option<f32>,
    pub reported_speed_kmh: Option<f32>,
    pub speed_interval_s: Option<f32>,
    pub speed_reason: String,
    pub speed_source: String,
    #[serde(skip)]
    pub anchor_at: DateTime<Utc>,
}
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub source: Option<String>,
    pub fix_only: Option<bool>,
    pub grouped: Option<bool>,
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices/:id/locations/latest", get(latest))
        .route("/devices/:id/locations/page", get(page))
        .route("/devices/:id/locations", get(history))
}
async fn ensure_owner(state: &AppState, device_id: i64, user_id: i64) -> AppResult<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM gps_read_devices WHERE id=$1 AND owner_id=$2)",
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}
async fn latest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Option<LocationView>>> {
    ensure_owner(&state, id, user.user_id).await?;
    let row = sqlx::query_as::<_, LocationView>(
        "WITH newest AS MATERIALIZED (
          SELECT location_latest_sample_at($1,$2) AS at
        ) SELECT p.recorded_at,p.source,p.fix,p.lat,p.lng,p.sat,p.ttff_s,p.csq,p.reg,p.vbat_mv,
          p.cbc_mv,p.device_uptime_s,p.heading,p.speed_kmh,
          p.reported_speed_kmh,p.speed_interval_s,p.speed_reason,p.speed_source,p.anchor_at
          FROM newest n CROSS JOIN LATERAL location_history_points_between($1,$2,n.at,n.at) p
          WHERE n.at IS NOT NULL AND EXISTS(SELECT 1 FROM gps_read_devices WHERE id=$1 AND owner_id=$2)
          ORDER BY p.source LIMIT 1",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct PageQuery {
    pub since: DateTime<Utc>,
    pub until: DateTime<Utc>, // Exclusive, so adjacent day/page windows never overlap.
    pub limit: Option<i64>,
    pub source: Option<String>,
    pub fix_only: Option<bool>,
    pub cursor: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
struct Cursor {
    device: i64,
    user: i64,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
    source: Option<String>,
    fix_only: Option<bool>,
    before: DateTime<Utc>,
    before_source: String,
}
async fn page(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_owner(&state, id, user.user_id).await?;
    if q.until <= q.since || q.until - q.since > chrono::Duration::days(31) {
        return Err(AppError::BadRequest(
            "query range must be positive and at most 31 days".into(),
        ));
    }
    let cursor = q
        .cursor
        .as_ref()
        .map(|s| {
            if s.len() > 2048 {
                return Err(AppError::BadRequest("invalid cursor".into()));
            }
            URL_SAFE_NO_PAD
                .decode(s)
                .ok()
                .and_then(|b| serde_json::from_slice::<Cursor>(&b).ok())
                .ok_or_else(|| AppError::BadRequest("invalid cursor".into()))
        })
        .transpose()?;
    if cursor.as_ref().is_some_and(|c| {
        c.device != id
            || c.user != user.user_id
            || c.since != q.since
            || c.until != q.until
            || c.source != q.source
            || c.fix_only != q.fix_only
    }) {
        return Err(AppError::BadRequest(
            "cursor does not match this query".into(),
        ));
    }
    let limit = q.limit.unwrap_or(2000).clamp(1, 5000);
    let _read_budget = crate::services::location_read_budget::acquire().await?;
    let mut rows = sqlx::query_as::<_, LocationView>(
        "WITH selected AS MATERIALIZED (
         SELECT recorded_at,source FROM location_page_sample_keys($1,$2,$3,$4,$5,$6,$7,$8,$9)
         WHERE EXISTS(SELECT 1 FROM gps_read_devices WHERE id=$1 AND owner_id=$2)
        ), bounds AS (SELECT min(recorded_at) AS first,max(recorded_at) AS last FROM selected)
        SELECT p.recorded_at,p.source,p.fix,p.lat,p.lng,p.sat,p.ttff_s,p.csq,p.reg,p.vbat_mv,
          p.cbc_mv,p.device_uptime_s,p.heading,p.speed_kmh,
          p.reported_speed_kmh,p.speed_interval_s,p.speed_reason,p.speed_source,p.anchor_at
        FROM bounds b CROSS JOIN LATERAL location_history_points_between($1,$2,b.first,b.last) p
        JOIN selected s USING(recorded_at,source)
        WHERE b.first IS NOT NULL
        ORDER BY p.recorded_at DESC,p.source DESC",
    )
    .bind(id)
    .bind(user.user_id)
    .bind(q.since)
    .bind(q.until)
    .bind(&q.source)
    .bind(q.fix_only)
    .bind(cursor.as_ref().map(|c| c.before))
    .bind(cursor.as_ref().map(|c| c.before_source.as_str()))
    .bind((limit + 1) as i32)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        let last = rows.last().expect("positive page size");
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    device: id,
                    user: user.user_id,
                    since: q.since,
                    until: q.until,
                    source: q.source,
                    fix_only: q.fix_only,
                    before: last.recorded_at,
                    before_source: last.source.clone(),
                })
                .map_err(|e| AppError::Internal(e.into()))?,
            ),
        )
    } else {
        None
    };
    Ok(Json(
        json!({"items":rows,"next_cursor":next_cursor,"has_more":has_more}),
    ))
}
async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    ensure_owner(&state, id, user.user_id).await?;
    if matches!((q.since,q.until),(Some(a),Some(b)) if a>b) {
        return Err(AppError::BadRequest("until < since".into()));
    }
    let _read_budget = crate::services::location_read_budget::acquire().await?;
    let rows = sqlx::query_as::<_, LocationView>(
        "WITH scoped AS MATERIALIZED (
          SELECT recorded_at,anchor_at,source FROM location_sample_keys_between($1,$2,$3,$4)
          WHERE ($5::text IS NULL OR source=$5) AND ($6::bool IS NULL OR fix=$6)
            AND EXISTS(SELECT 1 FROM gps_read_devices WHERE id=$1 AND owner_id=$2)
        ), anchors AS MATERIALIZED (
          SELECT DISTINCT anchor_at,source FROM scoped ORDER BY anchor_at DESC,source LIMIT $7
        ), bounds AS (
          SELECT min(recorded_at) AS first,max(recorded_at) AS last FROM scoped JOIN anchors USING(anchor_at,source)
        ) SELECT p.recorded_at,p.source,p.fix,p.lat,p.lng,p.sat,p.ttff_s,p.csq,p.reg,p.vbat_mv,
          p.cbc_mv,p.device_uptime_s,p.heading,p.speed_kmh,
          p.reported_speed_kmh,p.speed_interval_s,p.speed_reason,p.speed_source,p.anchor_at
        FROM bounds b CROSS JOIN LATERAL location_history_points_between($1,$2,b.first,b.last) p
        JOIN anchors a USING(anchor_at,source)
        WHERE b.first IS NOT NULL AND ($3::timestamptz IS NULL OR p.recorded_at >= $3)
          AND ($4::timestamptz IS NULL OR p.recorded_at <= $4)
          AND ($6::bool IS NULL OR p.fix=$6)
        ORDER BY p.recorded_at DESC,p.source"
    )
    .bind(id)
    .bind(user.user_id)
    .bind(q.since)
    .bind(q.until)
    .bind(q.source)
    .bind(q.fix_only)
    .bind(q.limit.unwrap_or(100).clamp(1, 10000))
    .fetch_all(&state.db)
    .await?;
    if !q.grouped.unwrap_or(false) {
        return Ok(Json(json!(rows)));
    }
    let mut groups: BTreeMap<(DateTime<Utc>, Option<i32>), Vec<LocationView>> = BTreeMap::new();
    for row in rows {
        groups
            .entry((row.anchor_at, row.device_uptime_s))
            .or_default()
            .push(row);
    }
    let posts: Vec<Value> = groups
        .into_iter()
        .rev()
        .map(|((at, uptime), mut fixes)| {
            fixes.sort_by_key(|f| f.recorded_at);
            let r = &fixes[0];
            json!({"post_at":at,"uptime_s":uptime,"vbat_mv":r.vbat_mv,"cbc_mv":r.cbc_mv,
            "csq":r.csq,"reg":r.reg,"batch_size":fixes.len(),"fixes":fixes})
        })
        .collect();
    Ok(Json(json!(posts)))
}
