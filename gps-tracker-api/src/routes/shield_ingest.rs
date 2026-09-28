//! Versioned SIM7080G/UNO transport. Deliberately independent of legacy/KC ingest.
use axum::{extract::State, Json};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

use crate::{
    error::{AppError, AppResult},
    events::{Event, LocationFix, SpeedDetails},
    state::AppState,
};

// [GNSS UTC seconds, latitude microdegrees, longitude microdegrees, satellites in view]
#[derive(Debug, Deserialize)]
struct Point(i64, i32, i32, u8);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    shield_v: u8,
    device_uid: String,
    build_tag: String,
    ts: i32,
    csq: i16,
    reg: i16,
    diag: Diagnostics,
    points: Vec<Point>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Diagnostics {
    pv_mv: u16,
    gnss: u8,
}

fn validate(p: &Payload, now: DateTime<Utc>) -> AppResult<()> {
    let uid = p.device_uid.strip_prefix("uno-shield-").unwrap_or("");
    if p.shield_v != 1
        || uid.is_empty()
        || p.device_uid.len() > 64
        || !uid.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || p.build_tag.len() > 80
        || p.ts < 0
        || !(-1..=99).contains(&p.csq)
        || !(-1..=10).contains(&p.reg)
        || p.diag.gnss > 10
        || p.diag.pv_mv > 20000
        || p.points.len() > 8
    {
        return Err(AppError::BadRequest("invalid shield v1 metadata".into()));
    }
    let mut previous = 0;
    for Point(at, lat, lng, sat) in &p.points {
        if *at <= previous
            || *at < (now - Duration::minutes(15)).timestamp()
            || *at > (now + Duration::seconds(30)).timestamp()
            || !(-90_000_000..=90_000_000).contains(lat)
            || !(-180_000_000..=180_000_000).contains(lng)
            || !(4..=99).contains(sat)
        {
            return Err(AppError::BadRequest(
                "invalid shield GPS point or UTC order".into(),
            ));
        }
        previous = *at;
    }
    Ok(())
}

fn unknown_speed() -> SpeedDetails {
    SpeedDetails {
        speed_source: "server_coordinate_v1".into(),
        speed_reason: "insufficient_history".into(),
        ..Default::default()
    }
}

pub async fn ingest(
    State(state): State<AppState>,
    Json(raw): Json<Value>,
) -> AppResult<Json<Value>> {
    let p: Payload = serde_json::from_value(raw.clone())
        .map_err(|e| AppError::BadRequest(format!("invalid shield v1 payload: {e}")))?;
    let now = Utc::now();
    validate(&p, now)?;
    let mut tx = state.db.begin().await?;
    // Row lock serializes retries and account pairing. Never replace owner_id.
    let (id, owner, previous_fix): (i64, Option<i64>, Option<DateTime<Utc>>) = sqlx::query_as(
        "INSERT INTO devices(device_uid,api_key_hash,last_seen_at) VALUES($1,'',$2)
         ON CONFLICT(device_uid) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at
         RETURNING id,owner_id,last_fix_at",
    )
    .bind(&p.device_uid)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    let mut accepted = Vec::new();
    if let Some(first) = p.points.first() {
        let existing: Vec<i64> = sqlx::query_scalar(
            "SELECT extract(epoch FROM r.recorded_at + (f.item->>'at_ms')::bigint * interval '1 millisecond')::bigint
             FROM location_records r CROSS JOIN LATERAL jsonb_array_elements(r.fixes_jsonb) f(item)
             WHERE r.device_id=$1 AND r.source='lte_gnss' AND r.raw->>'shield_v'='1'
               AND r.user_id IS NOT DISTINCT FROM $2
               AND r.recorded_at BETWEEN $3 AND $4")
            .bind(id).bind(owner)
            .bind(DateTime::from_timestamp(first.0,0).unwrap())
            .bind(now + Duration::seconds(30)).fetch_all(&mut *tx).await?;
        let existing: HashSet<_> = existing.into_iter().collect();
        // Dedup by absolute measurement UTC, including delayed retries and overlapping batches.
        for f in &p.points {
            if !existing.contains(&f.0) {
                accepted.push(f);
            }
        }
    }
    let points: Vec<LocationFix> = accepted
        .iter()
        .map(|f| LocationFix {
            recorded_at: DateTime::from_timestamp(f.0, 0).unwrap(),
            lat: Some(f.1 as f64 / 1e6),
            lng: Some(f.2 as f64 / 1e6),
            sat: Some(f.3 as i16),
            speed_kmh: None,
            speed_details: unknown_speed(),
        })
        .collect();
    let mut broadcast = points.clone();
    if let Some(last) = points.last() {
        let fixes: Vec<_> = points
            .iter()
            .map(|f| {
                json!({"at_ms":(f.recorded_at-last.recorded_at).num_milliseconds(),
            "lat":f.lat,"lng":f.lng,"sat":f.sat})
            })
            .collect();
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,device_uptime_s,source,fix,lat,lng,sat,csq,reg,raw,fixes_jsonb)
             VALUES($1,$2,$3,$4,'lte_gnss',true,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT(device_id,recorded_at,source) DO NOTHING")
            .bind(id).bind(owner).bind(last.recorded_at).bind(p.ts).bind(last.lat).bind(last.lng)
            .bind(last.sat).bind(p.csq).bind(p.reg).bind(&raw).bind(json!(fixes)).execute(&mut *tx).await?;
        sqlx::query("UPDATE devices SET last_lat=$1,last_lng=$2,last_fix_at=$3 WHERE id=$4 AND (last_fix_at IS NULL OR last_fix_at<=$3)")
            .bind(last.lat).bind(last.lng).bind(last.recorded_at).bind(id).execute(&mut *tx).await?;
        let dates: Vec<_> = points
            .iter()
            .flat_map(|f| {
                [
                    (f.recorded_at + Duration::hours(9)).date_naive(),
                    (f.recorded_at + Duration::hours(9) + Duration::seconds(65)).date_naive(),
                ]
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        sqlx::query(
            "INSERT INTO stats_rebuild_queue(device_id,date) SELECT $1,unnest($2::date[])
            ON CONFLICT(device_id,date) DO UPDATE SET generation=stats_rebuild_queue.generation+1",
        )
        .bind(id)
        .bind(dates)
        .execute(&mut *tx)
        .await?;
        if let Some(user) = owner {
            let wanted: HashSet<_> = points.iter().map(|f| f.recorded_at).collect();
            broadcast = sqlx::query_as::<_, LocationFix>(
                "SELECT recorded_at,lat,lng,sat,speed_kmh,reported_speed_kmh,speed_interval_s,speed_reason,speed_source
                 FROM location_speed_points_between($1,$2,$3,$4) WHERE source='lte_gnss' ORDER BY recorded_at")
                .bind(id).bind(user).bind(points[0].recorded_at).bind(last.recorded_at)
                .fetch_all(&mut *tx).await?.into_iter().filter(|f| wanted.contains(&f.recorded_at)).collect();
        }
    } else if p.points.is_empty() {
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,device_uptime_s,source,fix,csq,reg,raw)
            VALUES($1,$2,$3,$4,'lte_gnss',false,$5,$6,$7)")
            .bind(id).bind(owner).bind(now).bind(p.ts).bind(p.csq).bind(p.reg).bind(&raw).execute(&mut *tx).await?;
    }
    // Keep communication recovery notifications working on this independent path.
    // Serialize with the device lock so a retry cannot emit a second recovery.
    sqlx::query("INSERT INTO events(device_id,kind,occurred_at,data,user_id)
        SELECT $1,'online',$3,jsonb_build_object('recovered_from',previous.kind),$2
        FROM (SELECT kind FROM events WHERE device_id=$1 AND user_id=$2
              AND kind IN ('online','signal_loss','offline') ORDER BY occurred_at DESC LIMIT 1) previous
        WHERE previous.kind IN ('signal_loss','offline')")
        .bind(id).bind(owner).bind(now).execute(&mut *tx).await?;
    tx.commit().await?;
    if let Some(last) = broadcast.last() {
        let _ = state.events.send(Event::Location {
            device_id: id,
            recorded_at: last.recorded_at,
            source: "lte_gnss".into(),
            fix: true,
            lat: last.lat,
            lng: last.lng,
            sat: last.sat,
            ttff_s: None,
            vbat_mv: None,
            cbc_mv: None,
            heading: None,
            speed_kmh: last.speed_kmh,
            speed_details: last.speed_details.clone(),
            fixes: Some(broadcast.clone()),
        });
        // Late retransmissions cannot replay old crossings as a current location.
        if previous_fix.is_none_or(|at| last.recorded_at > at)
            && now - last.recorded_at <= Duration::seconds(60)
        {
            if let (Some(lat), Some(lng)) = (last.lat, last.lng) {
                let _ =
                    crate::services::geofence::check_after_ingest(&state.db, id, lat, lng).await;
            }
        }
    } else if p.points.is_empty() {
        let _ = state.events.send(Event::Location {
            device_id: id,
            recorded_at: now,
            source: "lte_gnss".into(),
            fix: false,
            lat: None,
            lng: None,
            sat: None,
            ttff_s: None,
            vbat_mv: None,
            cbc_mv: None,
            heading: None,
            speed_kmh: None,
            speed_details: unknown_speed(),
            fixes: None,
        });
    }
    Ok(Json(
        json!({"ok":true,"device_id":id,"accepted":points.len(),"duplicate":p.points.len()-points.len()}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Value {
        json!({"shield_v":1,"device_uid":"uno-shield-test","build_tag":"test",
        "ts":1,"csq":20,"reg":5,"diag":{"pv_mv":4100,"gnss":10},"points":[]})
    }
    #[test]
    fn shield_contract_is_separate_from_legacy() {
        let mut v = payload();
        v["lte"] = json!({"fix":false});
        assert!(serde_json::from_value::<Payload>(v).is_err());
        let mut v = payload();
        v["device_uid"] = json!("esp-kc-test");
        assert!(validate(&serde_json::from_value(v).unwrap(), Utc::now()).is_err());
    }
    #[test]
    fn rejects_bad_batch_time_coordinates_and_size() {
        let now = Utc::now();
        for pts in [
            json!([[now.timestamp() + 31, 0, 0, 8]]),
            json!([[now.timestamp() - 901, 0, 0, 8]]),
            json!([[now.timestamp(), 90000001, 0, 8]]),
            json!([[now.timestamp(), 0, 0, 3]]),
            json!([[now.timestamp(), 0, 0, 8], [now.timestamp(), 0, 0, 8]]),
            json!(vec![[now.timestamp(), 0, 0, 8]; 9]),
        ] {
            let mut v = payload();
            v["points"] = pts;
            assert!(validate(&serde_json::from_value(v).unwrap(), now).is_err());
        }
    }
    #[test]
    fn accepts_empty_and_ordered_fixed_point_batch() {
        let now = Utc::now();
        let mut v = payload();
        assert!(validate(&serde_json::from_value(v.clone()).unwrap(), now).is_ok());
        v["points"] = json!([
            [now.timestamp() - 10, -90000000, -180000000, 4],
            [now.timestamp(), 0, 180000000, 99]
        ]);
        assert!(validate(&serde_json::from_value(v).unwrap(), now).is_ok());
    }
}
