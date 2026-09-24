// All public and private readers use the same batch-expanded stream.
use axum::{extract::{Path, Query, State}, routing::get, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use std::collections::BTreeMap;
use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

#[derive(Debug, Serialize, FromRow)]
pub struct LocationView {
    pub recorded_at: DateTime<Utc>,
    pub source: String,
    pub fix: bool,
    pub lat: Option<f64>, pub lng: Option<f64>, pub sat: Option<i16>,
    pub ttff_s: Option<i32>, pub csq: Option<i16>, pub reg: Option<i16>,
    pub vbat_mv: Option<i32>, pub cbc_mv: Option<i32>,
    pub device_uptime_s: Option<i32>, pub heading: Option<f32>, pub speed_kmh: Option<f32>,
    #[serde(skip)]
    pub anchor_at: DateTime<Utc>,
}
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>, pub since: Option<DateTime<Utc>>, pub until: Option<DateTime<Utc>>,
    pub source: Option<String>, pub fix_only: Option<bool>, pub grouped: Option<bool>,
}
pub fn router() -> Router<AppState> {
    Router::new().route("/devices/:id/locations/latest", get(latest))
        .route("/devices/:id/locations", get(history))
}
async fn ensure_owner(state: &AppState, device_id: i64, user_id: i64) -> AppResult<()> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2)")
        .bind(device_id).bind(user_id).fetch_one(&state.db).await?;
    if exists { Ok(()) } else { Err(AppError::NotFound) }
}
const POINTS: &str = "SELECT recorded_at,source,fix,lat,lng,sat,ttff_s,csq,reg,vbat_mv,
    (raw->>'cbc_mv')::int AS cbc_mv,device_uptime_s,heading,speed_kmh,anchor_at
    FROM location_points WHERE device_id=$1 AND user_id=$2
    AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2)";
async fn latest(State(state): State<AppState>, user: AuthUser, Path(id): Path<i64>)
    -> AppResult<Json<Option<LocationView>>> {
    ensure_owner(&state,id,user.user_id).await?;
    let row = sqlx::query_as::<_,LocationView>(&format!("{POINTS} ORDER BY recorded_at DESC LIMIT 1"))
        .bind(id).bind(user.user_id).fetch_optional(&state.db).await?;
    Ok(Json(row))
}
async fn history(State(state): State<AppState>, user: AuthUser, Path(id): Path<i64>, Query(q): Query<ListQuery>)
    -> AppResult<Json<Value>> {
    ensure_owner(&state,id,user.user_id).await?;
    if matches!((q.since,q.until),(Some(a),Some(b)) if a>b) {
        return Err(AppError::BadRequest("until < since".into()));
    }
    let rows = sqlx::query_as::<_,LocationView>(&format!("WITH scoped AS MATERIALIZED ({POINTS}
        AND ($3::timestamptz IS NULL OR recorded_at >= $3)
        AND ($4::timestamptz IS NULL OR recorded_at <= $4)
        AND ($5::text IS NULL OR source=$5) AND ($6::bool IS NULL OR fix=$6)
        ), anchors AS (
          SELECT DISTINCT anchor_at,source FROM scoped ORDER BY anchor_at DESC,source LIMIT $7
        ) SELECT scoped.* FROM scoped JOIN anchors USING(anchor_at,source)
          ORDER BY recorded_at DESC,source"))
        .bind(id).bind(user.user_id).bind(q.since).bind(q.until).bind(q.source).bind(q.fix_only)
        .bind(q.limit.unwrap_or(100).clamp(1,10000)).fetch_all(&state.db).await?;
    if !q.grouped.unwrap_or(false) { return Ok(Json(json!(rows))); }
    let mut groups: BTreeMap<(DateTime<Utc>,Option<i32>),Vec<LocationView>> = BTreeMap::new();
    for row in rows { groups.entry((row.anchor_at,row.device_uptime_s)).or_default().push(row); }
    let posts: Vec<Value> = groups.into_iter().rev().map(|((at,uptime),mut fixes)| {
        fixes.sort_by_key(|f| f.recorded_at);
        let r=&fixes[0];
        json!({"post_at":at,"uptime_s":uptime,"vbat_mv":r.vbat_mv,"cbc_mv":r.cbc_mv,
            "csq":r.csq,"reg":r.reg,"batch_size":fixes.len(),"fixes":fixes})
    }).collect();
    Ok(Json(json!(posts)))
}
