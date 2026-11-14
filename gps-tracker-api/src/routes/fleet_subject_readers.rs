//! Projected readers for existing company endpoints. No daily/global location fallback.
use crate::services::location_read_budget::{query_error, ReadQuery};
use crate::{
    auth::AuthUser, error::AppResult, services::subject_projection as sp, state::AppState,
};
use axum::{extract::State, Json};
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) async fn terminals(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Value>> {
    let Some(p) = sp::current() else {
        return Ok(Json(
            serde_json::to_value(super::devices::list(State(state), user).await?.0)
                .map_err(|e| crate::error::AppError::Internal(e.into()))?,
        ));
    };
    let mut read = ReadQuery::start(&state.db).await?;
    // Only non-location columns: cached stationary/event payloads must not escape.
    let mut rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'device_uid',device_uid,'display_name',display_name,'color',color,'icon',icon,'last_seen_at',last_seen_at,'paired_at',paired_at,'created_at',created_at,'last_lat',NULL,'last_lng',NULL,'last_fix_at',NULL,'subject_scope','confirmed-subject-intervals') FROM devices WHERE owner_id=$1 ORDER BY id")
        .bind(user.user_id).fetch_all(&state.db).await?;
    for row in &mut rows {
        let did = row["id"].as_i64().unwrap();
        let mut latest: Option<(DateTime<Utc>, f64, f64, i64)> = None;
        for s in p.for_device(did) {
            let current: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_vehicle_bindings WHERE id=$1 AND ended_at IS NULL AND is_primary)").bind(s.binding).fetch_one(&state.db).await?;
            if !current {
                continue;
            }
            let point: Option<(DateTime<Utc>,f64,f64)> = sqlx::query_as("WITH points AS MATERIALIZED (SELECT recorded_at,lat,lng,fix,source FROM location_points_between($1,$2,$3,$4)) SELECT recorded_at,lat,lng FROM points WHERE fix AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180 AND recorded_at>=$3 AND recorded_at<$4 ORDER BY recorded_at DESC,CASE source WHEN 'phone' THEN 0 WHEN 'l80' THEN 1 ELSE 2 END LIMIT 1")
                .bind(did).bind(user.user_id).bind(s.start).bind(s.end).fetch_optional(read.connection()).await.map_err(query_error)?;
            if let Some((at, lat, lng)) = point {
                if latest.is_none_or(|v| v.0 < at) {
                    latest = Some((at, lat, lng, s.id));
                }
            }
        }
        if let Some((at, lat, lng, id)) = latest {
            row["last_fix_at"] = json!(at);
            row["last_lat"] = json!(lat);
            row["last_lng"] = json!(lng);
            sp::mark(id);
        }
    }
    read.finish().await?;
    Ok(Json(json!(rows)))
}

pub(super) async fn stats(state: &AppState, owner: i64, vehicles: bool) -> AppResult<Value> {
    let p = sp::current().expect("projected reader");
    let today = (Utc::now() + Duration::hours(9)).date_naive();
    type Aggregate = (f64, usize, f64, usize, Option<DateTime<Utc>>);
    let mut aggregates: BTreeMap<i64, Aggregate> = BTreeMap::new();
    let mut read = ReadQuery::start(&state.db).await?;
    for s in &p.spans {
        let points: Vec<(DateTime<Utc>,f64,f64)> = sqlx::query_as("WITH points AS MATERIALIZED (SELECT recorded_at,lat,lng,fix,source FROM location_points_between($1,$2,$3,$4)) SELECT DISTINCT ON(recorded_at) recorded_at,lat,lng FROM points WHERE fix AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180 AND recorded_at>=$3 AND recorded_at<$4 ORDER BY recorded_at,CASE source WHEN 'phone' THEN 0 WHEN 'l80' THEN 1 ELSE 2 END LIMIT 100001")
            .bind(s.device).bind(owner).bind(s.start).bind(s.end).fetch_all(read.connection()).await.map_err(query_error)?;
        if points.len() > 100000 {
            return Err(crate::error::AppError::BadRequest(
                "집계 범위를 줄여 주세요.".into(),
            ));
        }
        if points.is_empty() {
            continue;
        }
        let day: Vec<_> = points
            .iter()
            .filter(|(at, _, _)| (*at + Duration::hours(9)).date_naive() == today)
            .copied()
            .collect();
        let a = aggregates
            .entry(if vehicles { s.vehicle } else { s.device })
            .or_default();
        a.0 += crate::services::stats::calculate_metrics(&points).distance_m;
        a.1 += points.len();
        a.2 += crate::services::stats::calculate_metrics(&day).distance_m;
        a.3 += day.len();
        a.4 = a.4.max(day.last().map(|v| v.0));
        sp::mark(s.id);
    }
    read.finish().await?;
    let mut rows = Vec::new();
    for (id, (total, count, today, count_today, last)) in aggregates {
        rows.push(json!({"device_id":id,"vehicle_id":if vehicles{Some(id)}else{None},"total_distance_m":total,
            "fix_count":count,"today_distance_m":if count_today>0{Some(today)}else{None},"today_fix_count":count_today,
            "today_last_fix_at":last,"today_updated_at":last}));
    }
    Ok(
        json!({"from":p.from,"to":p.until,"per_device":rows,"basis":"confirmed_subject_intervals","scope_note":sp::NOTE}),
    )
}
