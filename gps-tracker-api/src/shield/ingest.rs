use super::*;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use subtle::ConstantTimeEq;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Diag {
    pv_mv: Option<u16>,
    gnss: Option<i16>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sensor {
    at: i64,
    temp_c: Option<f32>,
    hum_pct: Option<f32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    shield_v: u8,
    device_uid: String,
    build_tag: String,
    ts: i32,
    csq: i16,
    reg: i16,
    diag: Diag,
    points: Vec<(i64, i32, i32, u8)>,
    #[serde(default)]
    sensors: Vec<Sensor>,
}
fn validate(p: &Payload, now: i64) -> Result<()> {
    if !matches!(p.shield_v, 1 | 2)
        || p.device_uid.len() > 64
        || p.build_tag.len() > 80
        || p.ts < 0
        || !(-1..=99).contains(&p.csq)
        || !(-1..=10).contains(&p.reg)
        || p.points.len() > 8
        || p.sensors.len() > 32
        || (p.shield_v == 1 && !p.sensors.is_empty())
        || p.diag.pv_mv.is_some_and(|v| v > 20000)
        || p.diag.gnss.is_some_and(|v| !(0..=10).contains(&v))
    {
        return Err(bad("Invalid Shield payload"));
    }
    let valid_time = |at: i64| at >= now - 900 && at <= now + 30;
    let mut previous = 0;
    for (at, lat, lng, sat) in &p.points {
        if !valid_time(*at)
            || *at <= previous
            || !(-90_000_000..=90_000_000).contains(lat)
            || !(-180_000_000..=180_000_000).contains(lng)
            || !(4..=99).contains(sat)
        {
            return Err(bad("Invalid GNSS sample"));
        }
        previous = *at;
    }
    previous = 0;
    for s in &p.sensors {
        if !valid_time(s.at)
            || s.at <= previous
            || (s.temp_c.is_none() && s.hum_pct.is_none())
            || s.temp_c
                .is_some_and(|v| !v.is_finite() || !(-40.0..=85.0).contains(&v))
            || s.hum_pct
                .is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v))
        {
            return Err(bad("Invalid sensor sample"));
        }
        previous = s.at;
    }
    Ok(())
}
pub async fn ingest(
    State(app): State<App>,
    h: HeaderMap,
    Json(raw): Json<Value>,
) -> Result<Json<Value>> {
    let p: Payload =
        serde_json::from_value(raw.clone()).map_err(|_| bad("Invalid Shield payload"))?;
    let now = Utc::now();
    validate(&p, now.timestamp())?;
    let key = h
        .get("x-device-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() == 64)
        .ok_or_else(denied)?;
    let mut tx = app.db.begin().await?;
    let device: Option<(i64, Option<i64>, String)> =
        sqlx::query_as("SELECT id,owner_id,key_hash FROM devices WHERE device_uid=$1 FOR UPDATE")
            .bind(&p.device_uid)
            .fetch_optional(&mut *tx)
            .await?;
    let (id, owner, expected) = device.ok_or_else(denied)?;
    if expected.as_bytes().ct_eq(hash(key).as_bytes()).unwrap_u8() != 1 {
        return Err(denied());
    }
    let user = owner.ok_or_else(|| {
        Error(
            StatusCode::CONFLICT,
            "Register the device before uploading".into(),
        )
    })?;
    sqlx::query("UPDATE devices SET last_seen_at=$1 WHERE id=$2")
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let message:Option<i64>=sqlx::query_scalar("INSERT INTO messages(device_id,user_id,fingerprint,received_at) VALUES($1,$2,$3,$4) ON CONFLICT(device_id,user_id,fingerprint) DO NOTHING RETURNING id")
        .bind(id).bind(user).bind(hash(&raw.to_string())).bind(now).fetch_optional(&mut *tx).await?;
    let Some(message) = message else {
        tx.commit().await?;
        return Ok(Json(json!({"ok":true,"duplicate":true,"accepted":0})));
    };
    let mut accepted = 0;
    for (at, lat, lng, sat) in &p.points {
        let at = DateTime::from_timestamp(*at, 0).unwrap();
        accepted+=sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,csq,reg,device_uptime_s,raw) VALUES($1,$2,$3,'lte_gnss',true,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING")
            .bind(id).bind(user).bind(at).bind(*lat as f64/1e6).bind(*lng as f64/1e6).bind(*sat as i16).bind(p.csq).bind(p.reg).bind(p.ts).bind(json!({"shield_v":p.shield_v,"build_tag":p.build_tag})).execute(&mut *tx).await?.rows_affected();
        sqlx::query("UPDATE devices SET last_fix_at=$1,last_lat=$2,last_lng=$3 WHERE id=$4 AND (last_fix_at IS NULL OR last_fix_at<$1)")
            .bind(at).bind(*lat as f64/1e6).bind(*lng as f64/1e6).bind(id).execute(&mut *tx).await?;
    }
    if p.points.is_empty() {
        sqlx::query("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix) VALUES($1,$2,$3,'lte_gnss',false) ON CONFLICT DO NOTHING").bind(id).bind(user).bind(now).execute(&mut *tx).await?;
    }
    // Without a UTC sensor sample, recorded_at is explicitly receipt time and
    // measured_at stays NULL; a status report never invents a temperature.
    let samples = if p.sensors.is_empty() {
        vec![Sensor {
            at: 0,
            temp_c: None,
            hum_pct: None,
        }]
    } else {
        p.sensors
    };
    for sample in samples {
        let measured = if sample.at == 0 {
            None
        } else {
            DateTime::from_timestamp(sample.at, 0)
        };
        sqlx::query("INSERT INTO readings(message_id,device_id,user_id,recorded_at,received_at,measured_at,temp_c,hum_pct,pv_mv,csq,reg,gnss,build_tag,device_uptime_s) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING")
            .bind(message).bind(id).bind(user).bind(measured.unwrap_or(now)).bind(now).bind(measured).bind(sample.temp_c).bind(sample.hum_pct).bind(p.diag.pv_mv.map(i32::from)).bind(p.csq).bind(p.reg).bind(p.diag.gnss).bind(&p.build_tag).bind(p.ts).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let _ = app.events.send((user, id));
    Ok(Json(
        json!({"ok":true,"accepted":accepted,"duplicate":false}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_ranges_and_order_are_checked_before_write() {
        let now = Utc::now().timestamp();
        let v = json!({"shield_v":2,"device_uid":"uno-shield-test","build_tag":"test","ts":1,"csq":99,"reg":5,"diag":{},"points":[],"sensors":[{"at":now,"temp_c":24.5,"hum_pct":50}]});
        let p: Payload = serde_json::from_value(v.clone()).unwrap();
        assert!(validate(&p, now).is_ok());
        for (key, value) in [
            ("shield_v", json!(1)),
            ("sensors", json!([{"at":now,"hum_pct":101}])),
            ("points", json!([[now, 91000000, 127000000, 8]])),
        ] {
            let mut bad_v = v.clone();
            bad_v[key] = value;
            assert!(validate(&serde_json::from_value(bad_v).unwrap(), now).is_err());
        }
    }
}
