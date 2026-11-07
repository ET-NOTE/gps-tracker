//! Report-only corrections, always tied to the historical SIM and primary binding.
use crate::{
    auth::{
        fleet::{self, FleetScope},
        AuthUser,
    },
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};

type Fix = (DateTime<Utc>, f64, f64);
type Event = (String, DateTime<Utc>, Option<Value>);
pub fn digest(v: &impl Serialize) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).expect("serializable evidence"))
    )
}
pub fn date(v: &Value) -> Option<DateTime<Utc>> {
    v.as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}
fn invalid(s: &str) -> AppError {
    AppError::BadRequest(s.into())
}
fn stale() -> AppError {
    AppError::Conflict("기록이 변경됐습니다. 새로 조회한 뒤 미리보기를 다시 확인해 주세요.".into())
}

pub fn quality(
    start: DateTime<Utc>,
    end: Option<DateTime<Utc>>,
    fixes: &[Fix],
    events: &[Event],
    distance: f64,
    now: DateTime<Utc>,
) -> Value {
    let gaps: Vec<_> = fixes
        .windows(2)
        .filter(|p| (p[1].0 - p[0].0).num_seconds() > 600)
        .collect();
    let jumps = fixes
        .windows(2)
        .filter(|p| {
            let seconds = (p[1].0 - p[0].0).num_milliseconds() as f64 / 1000.;
            seconds > 0.
                && seconds <= 600.
                && crate::services::stats::haversine_m(p[0].1, p[0].2, p[1].1, p[1].2) / seconds
                    * 3.6
                    > 250.
        })
        .count();
    let has_sleep = end.is_some_and(|e| {
        events.iter().any(|(kind, at, data)| {
            kind == "sleep_enter"
                && *at >= start
                && super::corporate::effective_sleep_end(start, *at, data.as_ref()) == e
        })
    });
    let basis = if end.is_none() {
        "missing"
    } else if has_sleep {
        "sleep_signal"
    } else if events
        .iter()
        .any(|(k, t, _)| k == "wake" && Some(*t) == end)
    {
        "next_wake"
    } else {
        "gps_interval"
    };
    let fresh = fixes
        .last()
        .is_some_and(|p| p.0 <= now + Duration::seconds(30) && p.0 >= now - Duration::minutes(10));
    let mut open = false;
    let mut missing_end_count = 0;
    for (kind, at, _) in events
        .iter()
        .filter(|(_, at, _)| *at >= start && end.is_none_or(|e| *at <= e))
    {
        match kind.as_str() {
            "wake" => {
                if open && *at > start {
                    missing_end_count += 1;
                }
                open = true;
            }
            "sleep_enter" => open = false,
            _ => {}
        }
    }
    let status = if end.is_none() {
        if fresh && now - start < Duration::hours(24) {
            "running"
        } else {
            "end_missing"
        }
    } else if !has_sleep
        || missing_end_count > 0
        || fixes.len() < 2
        || !gaps.is_empty()
        || jumps > 0
        || distance < 50.
        || end.is_some_and(|e| e - start > Duration::hours(24))
    {
        "review"
    } else {
        "confirmed"
    };
    let zero_reason = if fixes.len() < 2 {
        "insufficient_fixes"
    } else if !gaps.is_empty() || jumps > 0 {
        "excluded_segments"
    } else if distance > 0. && distance < 50. {
        "rounded_short"
    } else if distance <= 0.01 {
        "stationary_or_short"
    } else {
        ""
    };
    json!({"status":status,"report_included":status=="confirmed","end_basis":basis,"missing_end_count":missing_end_count,"fix_count":fixes.len(),"first_fix_at":fixes.first().map(|p|p.0),"last_fix_at":fixes.last().map(|p|p.0),"gap_count":gaps.len(),"max_gap_seconds":gaps.iter().map(|p|(p[1].0-p[0].0).num_seconds()).max().unwrap_or(0),"rejected_jump_count":jumps,"zero_reason":zero_reason,"evidence_hash":digest(&(start,end,fixes,events))})
}

pub fn status_label(q: &Value) -> &str {
    match q["status"].as_str() {
        Some("running") => "운행 중",
        Some("end_missing") => "종료 미수신",
        Some("review") => "검토 필요 · 합계 제외",
        Some("confirmed") => {
            if q["reviewed"] == true {
                "확정 · 사용자 보정"
            } else {
                "확정"
            }
        }
        _ => "",
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/vehicles/:id/trips/evidence", post(evidence))
        .route(
            "/corporate/vehicles/:id/trips/corrections",
            get(history).post(correct),
        )
        .route(
            "/corporate/vehicles/:id/trips/corrections/:correction/restore",
            post(restore),
        )
}
async fn scope(
    state: &AppState,
    user: AuthUser,
    s: Option<Extension<FleetScope>>,
    vehicle: i64,
) -> AppResult<FleetScope> {
    let s = match s {
        Some(Extension(s)) => s,
        None => fleet::load(state, user.user_id, user.user_id).await?,
    };
    s.vehicle(vehicle)?;
    Ok(s)
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Key {
    source_device_id: i64,
    binding_id: i64,
    trip_started_at: DateTime<Utc>,
}
#[derive(Deserialize, Serialize)]
struct Input {
    from: NaiveDate,
    to: NaiveDate,
    trips: Vec<Key>,
    action: String,
    reason: String,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
    split_at: Option<DateTime<Utc>>,
    distance_m: Option<f64>,
    preview_token: Option<String>,
}
#[derive(Deserialize)]
struct EvidenceInput {
    from: NaiveDate,
    to: NaiveDate,
    key: Key,
}
fn range(from: NaiveDate, to: NaiveDate) -> AppResult<(DateTime<Utc>, DateTime<Utc>)> {
    if to < from || to - from > Duration::days(365) {
        return Err(invalid("조회 기간은 1년 이내로 선택해 주세요."));
    }
    Ok((
        from.and_hms_opt(0, 0, 0).unwrap().and_utc() - Duration::hours(9),
        to.and_hms_opt(23, 59, 59).unwrap().and_utc() - Duration::hours(9),
    ))
}
fn matches(t: &Value, k: &Key) -> bool {
    t["source_device_id"] == k.source_device_id
        && t["binding_id"] == k.binding_id
        && date(&t["source_started_at"]) == Some(k.trip_started_at)
}
async fn fixes(
    state: &AppState,
    owner: i64,
    sim: i64,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> AppResult<Vec<Fix>> {
    let rows=sqlx::query_as("SELECT DISTINCT ON(recorded_at) recorded_at,lat,lng FROM location_points_between($2,$1,$3,$4) WHERE user_id=$1 AND device_id=$2 AND fix AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180 AND recorded_at>=$3 AND recorded_at<=$4 ORDER BY recorded_at,CASE source WHEN 'phone' THEN 0 WHEN 'l80' THEN 1 ELSE 2 END LIMIT 100001").bind(owner).bind(sim).bind(start).bind(end).fetch_all(&state.db).await?;
    if rows.len() > 100000 {
        return Err(invalid("GPS 기록이 많습니다. 조회 기간을 줄여 주세요."));
    }
    Ok(rows)
}
async fn events(
    state: &AppState,
    owner: i64,
    sim: i64,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> AppResult<Vec<Event>> {
    let rows=sqlx::query_as("SELECT kind,occurred_at,data FROM gps_read_events WHERE user_id=$1 AND device_id=$2 AND kind IN ('wake','sleep_enter') AND occurred_at>=$3 AND occurred_at<=$4 ORDER BY occurred_at,kind LIMIT 10001").bind(owner).bind(sim).bind(start).bind(end).fetch_all(&state.db).await?;
    if rows.len() > 10000 {
        return Err(invalid("상태 신호가 많습니다. 조회 기간을 줄여 주세요."));
    }
    Ok(rows)
}
async fn source_hash(
    state: &AppState,
    owner: i64,
    sim: i64,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> AppResult<String> {
    Ok(digest(&(
        fixes(state, owner, sim, start, end).await?,
        events(state, owner, sim, start, end).await?,
    )))
}
async fn evidence(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vehicle): Path<i64>,
    s: Option<Extension<FleetScope>>,
    Json(p): Json<EvidenceInput>,
) -> AppResult<Json<Value>> {
    let s = scope(&state, user, s, vehicle).await?;
    let (from, to) = range(p.from, p.to)?;
    let trips = super::fleet_vehicles::allocated_trips(&state, s.owner, vehicle, from, to).await?;
    let t = trips
        .iter()
        .find(|t| matches(t, &p.key))
        .ok_or(AppError::NotFound)?;
    // Boundary rows expose only the part belonging to this vehicle.
    let start = date(&t["started_at"]).ok_or(AppError::NotFound)?;
    let binding: (DateTime<Utc>,Option<DateTime<Utc>>)=sqlx::query_as("SELECT started_at,ended_at FROM fleet_vehicle_bindings WHERE id=$1 AND owner_id=$2 AND vehicle_id=$3 AND device_id=$4 AND is_primary").bind(p.key.binding_id).bind(s.owner).bind(vehicle).bind(p.key.source_device_id).fetch_one(&state.db).await?;
    let start = start.max(binding.0);
    let end = date(&t["ended_at"])
        .unwrap_or(to.min(Utc::now()))
        .min(binding.1.unwrap_or(to))
        .min(to);
    let points = fixes(&state, s.owner, p.key.source_device_id, start, end).await?;
    let ev = events(&state, s.owner, p.key.source_device_id, start, end).await?;
    let step = points.len().div_ceil(1000).max(1);
    let mut displayed: Vec<_> = points.iter().step_by(step).copied().collect();
    if points.last() != displayed.last() {
        if let Some(last) = points.last() {
            displayed.push(*last);
        }
    }
    let gaps: Vec<_> = points
        .windows(2)
        .filter(|p| (p[1].0 - p[0].0).num_seconds() > 600)
        .take(50)
        .map(|p| json!({"from":p[0].0,"to":p[1].0,"seconds":(p[1].0-p[0].0).num_seconds()}))
        .collect();
    Ok(Json(
        json!({"trip":t,"points":displayed,"point_count":points.len(),"sampled":displayed.len()<points.len(),"events":ev.iter().take(100).collect::<Vec<_>>(),"gaps":gaps,"calculated_distance_m":crate::services::stats::calculate_metrics(&points).distance_m,"method":"GPS 유효 좌표 간 거리. 10분 초과 공백·시속 250km 초과 이동은 제외하며 정지 구간 흔들림을 제거합니다. 공백의 실제 이동거리는 알 수 없습니다."}),
    ))
}

async fn locks(tx: &mut Transaction<'_, Postgres>, owner: i64, vehicle: i64) -> AppResult<()> {
    super::fleet_expenses::lock(tx, owner).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-reservations:{owner}"))
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "SELECT id FROM fleet_vehicle_bindings WHERE owner_id=$1 AND vehicle_id=$2 FOR SHARE",
    )
    .bind(owner)
    .bind(vehicle)
    .fetch_all(&mut **tx)
    .await?;
    Ok(())
}
async fn correct(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vehicle): Path<i64>,
    s: Option<Extension<FleetScope>>,
    Json(mut p): Json<Input>,
) -> AppResult<Json<Value>> {
    let s = scope(&state, user, s, vehicle).await?;
    if !s.manager() {
        return Err(AppError::Forbidden);
    }
    if !(2..=500).contains(&p.reason.trim().chars().count())
        || !matches!(p.action.as_str(), "confirm" | "adjust" | "split" | "merge")
        || p.trips.is_empty()
        || p.trips.len() > 2
        || p.trips.len() != if p.action == "merge" { 2 } else { 1 }
        || p.distance_m
            .is_some_and(|d| !d.is_finite() || !(0.0..=10_000_000.).contains(&d))
    {
        return Err(invalid("작업·사유·선택 운행을 확인해 주세요."));
    }
    let (from, to) = range(p.from, p.to)?;
    let mut tx = state.db.begin().await?;
    locks(&mut tx, s.owner, vehicle).await?;
    let current =
        super::fleet_vehicles::allocated_trips(&state, s.owner, vehicle, from, to).await?;
    let mut sources = Vec::new();
    for k in &p.trips {
        let t = current.iter().find(|t| matches(t, k)).ok_or_else(stale)?;
        if t["allocation_status"] != "assigned" || !t["correction_id"].is_null() {
            return Err(invalid("연결 경계 기록은 보정할 수 없습니다. 이미 보정한 기록은 먼저 원본으로 복원해 주세요."));
        }
        sources.push(t.clone());
    }
    sources.sort_by_key(|t| date(&t["started_at"]));
    if sources.windows(2).any(|p| {
        p[0]["source_device_id"] != p[1]["source_device_id"]
            || p[0]["binding_id"] != p[1]["binding_id"]
            || p[0]["started_at"] == p[1]["started_at"]
    }) {
        return Err(invalid(
            "같은 대표 단말기 연결 구간의 서로 다른 운행만 병합할 수 있습니다.",
        ));
    }
    let first = &sources[0];
    let last = sources.last().unwrap();
    let sim = first["source_device_id"].as_i64().unwrap();
    let binding = first["binding_id"].as_i64().unwrap();
    let source_starts: Vec<DateTime<Utc>> = sources
        .iter()
        .filter_map(|t| date(&t["source_started_at"]))
        .collect();
    let linked_expense: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_expenses WHERE owner_id=$1 AND source_device_id=$2 AND binding_id=$3 AND trip_started_at=ANY($4) AND status<>'cancelled')")
        .bind(s.owner).bind(sim).bind(binding).bind(&source_starts).fetch_one(&mut *tx).await?;
    let original_start = date(&first["started_at"]).unwrap();
    let original_end = date(&last["ended_at"])
        .or_else(|| date(&last["quality"]["last_fix_at"]))
        .ok_or_else(|| invalid("종료 시각을 판단할 GPS 기록이 없습니다."))?;
    if original_end <= original_start
        || original_end > Utc::now()
        || sources.iter().any(|t| t["quality"]["status"] == "running")
    {
        return Err(invalid("진행 중인 운행은 종료 후 보정해 주세요."));
    }
    if date(&last["ended_at"]).is_none() && p.action != "adjust" {
        return Err(invalid(
            "종료 미수신 기록은 종료 시각을 먼저 보정해 주세요.",
        ));
    }
    if p.action == "merge" {
        // Do not silently redistribute a driver, fuel receipt or money between trips.
        if linked_expense || sources.iter().any(|t| !t["annotation"].is_null()) {
            return Err(invalid(
                "용무·운전자·지출이 연결된 운행은 병합할 수 없습니다. 원본을 유지해 주세요.",
            ));
        }
        let previous_end = date(&sources[0]["ended_at"])
            .ok_or_else(|| invalid("종료된 운행만 병합할 수 있습니다."))?;
        let next_start = date(&sources[1]["started_at"]).unwrap();
        if next_start < previous_end
            || next_start - previous_end > Duration::hours(24)
            || current.iter().any(|t| {
                date(&t["started_at"]).is_some_and(|v| v > original_start && v < next_start)
            })
        {
            return Err(invalid(
                "중간 기록이 없는 인접 운행만 병합할 수 있습니다. 간격은 24시간 이내입니다.",
            ));
        }
    }
    let overlap:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_trip_corrections WHERE owner_id=$1 AND source_device_id=$2 AND reverted_at IS NULL AND started_at<$4 AND ended_at>$3)").bind(s.owner).bind(sim).bind(original_start).bind(original_end).fetch_one(&mut *tx).await?;
    if overlap {
        return Err(stale());
    }
    let points = fixes(&state, s.owner, sim, original_start, original_end).await?;
    let evidence_hash = source_hash(&state, s.owner, sim, original_start, original_end).await?;
    let start = if p.action == "adjust" {
        p.started_at.unwrap_or(original_start)
    } else {
        original_start
    };
    let end = if p.action == "adjust" {
        p.ended_at
            .ok_or_else(|| invalid("종료 시각을 입력해 주세요."))?
    } else {
        original_end
    };
    if start != original_start && (linked_expense || !first["annotation"].is_null()) {
        return Err(invalid(
            "용무·지출이 연결된 운행은 시작 시각을 유지해 주세요.",
        ));
    }
    if start < original_start || end > original_end || end <= start {
        return Err(invalid(
            "시각은 원본 기록 범위 안에서 시작보다 종료가 늦도록 입력해 주세요.",
        ));
    }
    let intervals = if p.action == "split" {
        let split = p
            .split_at
            .ok_or_else(|| invalid("나눌 시각을 입력해 주세요."))?;
        if split <= start || split >= end {
            return Err(invalid("나눌 시각은 운행 시작과 종료 사이여야 합니다."));
        }
        vec![(start, split), (split, end)]
    } else {
        vec![(start, end)]
    };
    let mut outputs = Vec::new();
    for (i, (a, b)) in intervals.iter().enumerate() {
        let slice: Vec<_> = points
            .iter()
            .filter(|v| v.0 >= *a && v.0 <= *b)
            .copied()
            .collect();
        let measured = crate::services::stats::calculate_metrics(&slice).distance_m;
        let distance = if p.action == "merge" {
            sources
                .iter()
                .filter_map(|t| t["distance_m"].as_f64())
                .sum()
        } else if p.action == "confirm" {
            first["distance_m"]
                .as_f64()
                .ok_or_else(|| invalid("거리를 확인할 수 없습니다."))?
        } else if p.action == "adjust" {
            p.distance_m.unwrap_or(measured)
        } else {
            measured
        };
        if p.action == "split" && slice.len() < 2 {
            return Err(invalid(
                "나눈 각 구간에 유효한 GPS 좌표가 2개 이상 필요합니다.",
            ));
        }
        let mut row = first.clone();
        for (k, v) in [
            ("started_at", json!(a)),
            ("source_started_at", json!(a)),
            ("ended_at", json!(b)),
            ("duration_min", json!((*b - *a).num_minutes())),
            ("distance_m", json!(distance)),
        ] {
            row[k] = v;
        }
        row["annotation"] = if i == 0 {
            first["annotation"].clone()
        } else {
            Value::Null
        };
        if *a != original_start {
            row["start_address"] = Value::Null;
        }
        if *b != date(&first["ended_at"]).unwrap_or(original_end) {
            row["end_address"] = Value::Null;
        }
        row["start_lat"] = json!(slice.first().map(|v| v.1));
        row["start_lng"] = json!(slice.first().map(|v| v.2));
        row["end_lat"] = json!(slice.last().map(|v| v.1));
        row["end_lng"] = json!(slice.last().map(|v| v.2));
        row["start_sites"] = json!([]);
        row["end_sites"] = json!([]);
        row["quality"] = json!({"status":"confirmed","report_included":true,"end_basis":"reviewed","reviewed":true,"reason":p.reason.trim(),"measured_distance_m":measured,"distance_basis":if p.distance_m.is_some()&&p.action=="adjust"{"manual"}else if p.action=="merge"{"source_sum"}else{"gps"}});
        outputs.push(row);
    }
    let token = p.preview_token.take();
    let fingerprint = digest(
        &json!({"owner":s.owner,"actor":s.actor,"vehicle":vehicle,"request":p,"sources":sources,"outputs":outputs,"evidence":evidence_hash}),
    );
    if let Some(token) = token {
        if token != fingerprint {
            return Err(stale());
        }
        let id:i64=sqlx::query_scalar("INSERT INTO fleet_trip_corrections(owner_id,vehicle_id,source_device_id,binding_id,started_at,ended_at,action,reason,sources,outputs,evidence_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id")
 .bind(s.owner).bind(vehicle).bind(sim).bind(binding).bind(original_start).bind(original_end).bind(&p.action).bind(p.reason.trim()).bind(json!(sources)).bind(json!(outputs)).bind(evidence_hash).bind(s.actor).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(Json(json!({"id":id,"applied":true})))
    } else {
        tx.rollback().await?;
        Ok(Json(
            json!({"preview_token":fingerprint,"before":sources,"after":outputs,"reason":p.reason,"action":p.action,"note":"원본 수신은 유지됩니다. 분할 시 기존 용무·운전자·주유비는 첫 구간에만 남습니다. 병합 거리는 원본 거리 합계이며 공백 거리를 더하지 않습니다."}),
        ))
    }
}

pub(super) async fn overlay(
    state: &AppState,
    owner: i64,
    vehicle: i64,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    rows: &mut Vec<Value>,
) -> AppResult<()> {
    let corrections:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c) FROM fleet_trip_corrections c WHERE owner_id=$1 AND vehicle_id=$2 AND reverted_at IS NULL AND started_at<=$4 AND ended_at>=$3 ORDER BY id").bind(owner).bind(vehicle).bind(from).bind(to).fetch_all(&state.db).await?;
    for c in corrections {
        let sim = c["source_device_id"].as_i64().unwrap();
        let start = date(&c["started_at"]).unwrap();
        let end = date(&c["ended_at"]).unwrap();
        let valid_binding:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_vehicle_bindings WHERE id=$1 AND owner_id=$2 AND vehicle_id=$3 AND device_id=$4 AND is_primary AND started_at<=$5 AND (ended_at IS NULL OR ended_at>=$6))").bind(c["binding_id"].as_i64()).bind(owner).bind(vehicle).bind(sim).bind(start).bind(end).fetch_one(&state.db).await?;
        let extended = rows.iter().any(|r| {
            r["source_device_id"] == sim
                && c["sources"].as_array().unwrap().iter().any(|s| {
                    s["source_started_at"] == r["source_started_at"]
                        && s["ended_at"].is_null()
                        && (date(&r["quality"]["last_fix_at"]).is_some_and(|v| v > end)
                            || r["ended_at"] != s["ended_at"])
                })
        });
        let changed = extended
            || source_hash(state, owner, sim, start, end).await?
                != c["evidence_hash"].as_str().unwrap_or("")
            || !valid_binding;
        rows.retain(|r| {
            !(r["source_device_id"] == sim
                && (c["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["source_started_at"] == r["source_started_at"])
                    || date(&r["started_at"]).is_some_and(|s| s >= start && s < end)))
        });
        let annotations = super::corporate::load_annotations(state, sim, owner, start, end).await?;
        for original in c["outputs"].as_array().unwrap() {
            let mut row = original.clone();
            if date(&row["started_at"]).unwrap() > to || date(&row["ended_at"]).unwrap() < from {
                continue;
            }
            if let Some(a) = annotations.iter().find(|a| {
                serde_json::to_value(a)
                    .ok()
                    .as_ref()
                    .and_then(|a| date(&a["trip_started_at"]))
                    == date(&row["source_started_at"])
            }) {
                row["annotation"] =
                    serde_json::to_value(a).map_err(|e| AppError::Internal(e.into()))?;
            }
            row["correction_id"] = c["id"].clone();
            row["correction_action"] = c["action"].clone();
            if changed {
                row["quality"]["status"] = json!("review");
                row["quality"]["report_included"] = json!(false);
                row["quality"]["source_changed"] = json!(true);
            }
            rows.push(row);
        }
    }
    rows.sort_by_key(|t| date(&t["started_at"]));
    Ok(())
}
async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vehicle): Path<i64>,
    s: Option<Extension<FleetScope>>,
) -> AppResult<Json<Value>> {
    let s = scope(&state, user, s, vehicle).await?;
    if !s.manager() {
        return Err(AppError::Forbidden);
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c)||jsonb_build_object('actor_name',u.display_name,'reverted_by_name',r.display_name) FROM fleet_trip_corrections c LEFT JOIN users u ON u.id=c.actor_id LEFT JOIN users r ON r.id=c.reverted_by WHERE c.owner_id=$1 AND c.vehicle_id=$2 ORDER BY c.id DESC LIMIT 100").bind(s.owner).bind(vehicle).fetch_all(&state.db).await?;
    Ok(Json(json!({"rows":rows,"limit":100})))
}
#[derive(Deserialize)]
struct Restore {
    reason: String,
}
async fn restore(
    State(state): State<AppState>,
    user: AuthUser,
    Path((vehicle, id)): Path<(i64, i64)>,
    s: Option<Extension<FleetScope>>,
    Json(p): Json<Restore>,
) -> AppResult<Json<Value>> {
    let s = scope(&state, user, s, vehicle).await?;
    if !s.manager() {
        return Err(AppError::Forbidden);
    }
    if !(2..=500).contains(&p.reason.trim().chars().count()) {
        return Err(invalid("복원 사유를 2~500자로 입력해 주세요."));
    }
    let mut tx = state.db.begin().await?;
    locks(&mut tx, s.owner, vehicle).await?;
    // Restoring a split/adjustment must not strand an active expense on a
    // report-only trip that will disappear. Original-start links are retained.
    let stranded: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_trip_corrections c JOIN fleet_expenses e ON e.owner_id=c.owner_id AND e.source_device_id=c.source_device_id AND e.binding_id=c.binding_id WHERE c.id=$1 AND c.owner_id=$2 AND c.vehicle_id=$3 AND c.reverted_at IS NULL AND e.status<>'cancelled' AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.outputs) o WHERE (o->>'source_started_at')::timestamptz=e.trip_started_at) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.sources) o WHERE (o->>'source_started_at')::timestamptz=e.trip_started_at))")
        .bind(id).bind(s.owner).bind(vehicle).fetch_one(&mut *tx).await?;
    if stranded {
        return Err(invalid("보정 후 새 구간에 연결한 지출을 먼저 취소해 주세요. 원본 복원 후 다시 연결할 수 있습니다."));
    }
    let n=sqlx::query("UPDATE fleet_trip_corrections SET reverted_at=clock_timestamp(),reverted_by=$4,revert_reason=$5 WHERE id=$1 AND owner_id=$2 AND vehicle_id=$3 AND reverted_at IS NULL").bind(id).bind(s.owner).bind(vehicle).bind(s.actor).bind(p.reason.trim()).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(stale());
    }
    tx.commit().await?;
    Ok(Json(json!({"restored":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_open_trip_is_not_driving() {
        let now = Utc::now();
        let start = now - Duration::days(2);
        assert_eq!(
            quality(start, None, &[(start, 37., 127.)], &[], 0., now)["status"],
            "end_missing"
        );
    }
    #[test]
    fn zero_and_gaps_require_review() {
        let s = Utc::now() - Duration::hours(2);
        let e = s + Duration::minutes(20);
        let events = vec![("sleep_enter".into(), e, None)];
        let points = vec![(s, 37., 127.), (e, 37.1, 127.)];
        let q = quality(s, Some(e), &points, &events, 0., Utc::now());
        assert_eq!(q["status"], "review");
        assert_eq!(q["gap_count"], 1);
    }
    #[test]
    fn complete_movement_is_confirmed() {
        let s = Utc::now() - Duration::hours(1);
        let e = s + Duration::minutes(5);
        let ev = vec![("sleep_enter".into(), e, None)];
        let q = quality(
            s,
            Some(e),
            &[(s, 37., 127.), (e, 37.01, 127.)],
            &ev,
            1110.,
            Utc::now(),
        );
        assert_eq!(q["status"], "confirmed");
        assert_eq!(q["report_included"], true);
    }
}
