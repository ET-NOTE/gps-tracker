//! Derived visits from the SIM point ledger and primary vehicle assignment.
//! Monotone checkpoints reject late/replayed points; raw telemetry is untouched.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Geometry {
    Circle { lat: f64, lng: f64, radius_m: f64 },
    Polygon { points: Vec<[f64; 2]> }, // [latitude, longitude]
}
fn coord(p: [f64; 2]) -> bool {
    p[0].is_finite()
        && p[1].is_finite()
        && (-85.0..=85.0).contains(&p[0])
        && (-180.0..=180.0).contains(&p[1])
}
fn cross(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}
impl Geometry {
    pub fn valid(&self) -> bool {
        match self {
            Self::Circle { lat, lng, radius_m } => {
                coord([*lat, *lng]) && radius_m.is_finite() && (20.0..=50000.0).contains(radius_m)
            }
            Self::Polygon { points: p } => {
                if !(3..=32).contains(&p.len()) || p.iter().any(|p| !coord(*p)) {
                    return false;
                }
                let n = p.len();
                let area: f64 = (0..n)
                    .map(|i| p[i][0] * p[(i + 1) % n][1] - p[(i + 1) % n][0] * p[i][1])
                    .sum();
                if area.abs() < 1e-10 {
                    return false;
                }
                for i in 0..n {
                    if super::geofence::haversine_m(
                        p[i][0],
                        p[i][1],
                        p[(i + 1) % n][0],
                        p[(i + 1) % n][1],
                    ) < 1.0
                    {
                        return false;
                    }
                    if super::geofence::haversine_m(p[0][0], p[0][1], p[i][0], p[i][1]) > 100000.0 {
                        return false;
                    }
                    for j in i + 1..n {
                        if j == i + 1 || (i == 0 && j == n - 1) {
                            continue;
                        }
                        let (a, b, c, d) = (p[i], p[(i + 1) % n], p[j], p[(j + 1) % n]);
                        let overlaps = (0..2).all(|k| {
                            a[k].min(b[k]) <= c[k].max(d[k]) && c[k].min(d[k]) <= a[k].max(b[k])
                        });
                        if overlaps
                            && cross(a, b, c) * cross(a, b, d) <= 0.0
                            && cross(c, d, a) * cross(c, d, b) <= 0.0
                        {
                            return false;
                        }
                    }
                }
                true
            }
        }
    }
    pub fn contains(&self, lat: f64, lng: f64, previous: Option<bool>) -> bool {
        if !coord([lat, lng]) {
            return false;
        }
        match self {
            Self::Circle {
                lat: a,
                lng: b,
                radius_m: r,
            } => {
                let h = (r * 0.3).min(10.0);
                let threshold = r + match previous {
                    Some(true) => h,
                    Some(false) => -h,
                    None => 0.0,
                };
                super::geofence::haversine_m(*a, *b, lat, lng) <= threshold
            }
            Self::Polygon { points: p } => {
                let scale = lat.to_radians().cos() * 111195.0;
                let mut inside = false;
                let mut distance = f64::INFINITY;
                for i in 0..p.len() {
                    let a = p[i];
                    let b = p[(i + 1) % p.len()];
                    if (a[0] > lat) != (b[0] > lat)
                        && lng < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0]) + a[1]
                    {
                        inside = !inside;
                    }
                    let (ax, ay, bx, by) = (
                        (a[1] - lng) * scale,
                        (a[0] - lat) * 111195.0,
                        (b[1] - lng) * scale,
                        (b[0] - lat) * 111195.0,
                    );
                    let t = (-(ax * (bx - ax) + ay * (by - ay))
                        / ((bx - ax).powi(2) + (by - ay).powi(2)))
                    .clamp(0.0, 1.0);
                    distance = distance.min((ax + t * (bx - ax)).hypot(ay + t * (by - ay)));
                }
                if distance <= 5.0 {
                    previous.unwrap_or(inside)
                } else {
                    inside
                }
            }
        }
    }
}
#[derive(FromRow)]
struct Site {
    id: i64,
    name: String,
    group_name: Option<String>,
    geometry: Value,
    detection_from: DateTime<Utc>,
}
#[derive(FromRow)]
struct Binding {
    id: i64,
    owner_id: i64,
    vehicle_id: i64,
    device_id: i64,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    name: String,
}
#[derive(FromRow)]
struct Previous {
    last_at: DateTime<Utc>,
    inside: bool,
    visit_id: Option<i64>,
}

pub async fn scan(pool: &PgPool) -> anyhow::Result<()> {
    let mut guard = pool.begin().await?;
    // A transaction lock is also released if the task is cancelled.
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(7541,1)")
        .fetch_one(&mut *guard)
        .await?;
    if !locked {
        return Ok(());
    }
    let result = scan_inner(pool).await;
    guard.rollback().await?;
    result
}
async fn scan_inner(pool: &PgPool) -> anyhow::Result<()> {
    let ids:Vec<i64>=sqlx::query_scalar("SELECT b.id FROM fleet_vehicle_bindings b WHERE b.is_primary AND b.device_id IS NOT NULL AND EXISTS(SELECT 1 FROM fleet_sites s WHERE s.owner_id=b.owner_id AND s.active AND (b.ended_at IS NULL OR b.ended_at>s.detection_from)) ORDER BY b.id").fetch_all(pool).await?;
    for id in ids {
        let mut tx = pool.begin().await?;
        let Some(b)=sqlx::query_as::<_,Binding>("SELECT b.id,b.owner_id,b.vehicle_id,b.device_id,b.started_at,b.ended_at,COALESCE(NULLIF(v.name,''),NULLIF(v.license_plate,''),'차량 정보 미등록') AS name FROM fleet_vehicle_bindings b JOIN fleet_vehicles v ON v.id=b.vehicle_id WHERE b.id=$1 AND b.device_id IS NOT NULL FOR SHARE OF b").bind(id).fetch_optional(&mut *tx).await? else {continue};
        let sites=sqlx::query_as::<_,Site>("SELECT s.id,s.name,g.name AS group_name,s.geometry,s.detection_from FROM fleet_sites s LEFT JOIN fleet_site_groups g ON g.id=s.group_id WHERE s.owner_id=$1 AND s.active ORDER BY s.id FOR SHARE OF s").bind(b.owner_id).fetch_all(&mut *tx).await?;
        let Some(first) = sites.iter().map(|s| s.detection_from).min() else {
            continue;
        };
        let cursor: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT last_at FROM fleet_site_cursors WHERE binding_id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        let from = b.started_at.max(first).max(cursor.unwrap_or(first));
        let to = b.ended_at.unwrap_or_else(Utc::now).min(Utc::now());
        let points:Vec<(DateTime<Utc>,f64,f64)>=sqlx::query_as("SELECT DISTINCT ON(recorded_at) recorded_at,lat,lng FROM location_points_between($1,$2,$3,$4) WHERE fix AND lat BETWEEN -85 AND 85 AND lng BETWEEN -180 AND 180 AND ($5::timestamptz IS NULL OR recorded_at>$5) AND ($6::timestamptz IS NULL OR recorded_at<$6) ORDER BY recorded_at,CASE source WHEN 'l80' THEN 0 WHEN 'phone' THEN 1 ELSE 2 END LIMIT 500").bind(b.device_id).bind(b.owner_id).bind(from).bind(to).bind(cursor).bind(b.ended_at).fetch_all(&mut *tx).await?;
        for s in sites {
            let geom: Geometry = serde_json::from_value(s.geometry)?;
            let mut prev = sqlx::query_as::<_, Previous>(
                "SELECT * FROM fleet_site_states WHERE site_id=$1 AND binding_id=$2",
            )
            .bind(s.id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            for &(at, lat, lng) in &points {
                if at < s.detection_from || prev.as_ref().is_some_and(|p| at <= p.last_at) {
                    continue;
                }
                if prev
                    .as_ref()
                    .is_some_and(|p| at - p.last_at > chrono::Duration::minutes(30))
                {
                    if let Some(visit) = prev.as_ref().and_then(|p| p.visit_id) {
                        sqlx::query("UPDATE fleet_site_visits SET closed_at=now(),end_reason='gap' WHERE id=$1 AND closed_at IS NULL").bind(visit).execute(&mut *tx).await?;
                    }
                    prev = None;
                }
                let inside = geom.contains(lat, lng, prev.as_ref().map(|p| p.inside));
                let mut visit = prev.as_ref().and_then(|p| p.visit_id);
                if inside && prev.as_ref().is_none_or(|p| !p.inside) {
                    visit=Some(sqlx::query_scalar("INSERT INTO fleet_site_visits(owner_id,site_id,vehicle_id,binding_id,site_name,group_name,vehicle_name,first_inside_at,last_inside_at,previous_outside_at,start_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING id")
      .bind(b.owner_id).bind(s.id).bind(b.vehicle_id).bind(b.id).bind(&s.name).bind(&s.group_name).bind(&b.name).bind(at).bind(prev.as_ref().map(|p|p.last_at)).bind(if prev.is_some(){"transition"}else{"observed"}).fetch_one(&mut *tx).await?);
                } else if inside {
                    sqlx::query("UPDATE fleet_site_visits SET last_inside_at=$2 WHERE id=$1 AND closed_at IS NULL").bind(visit).bind(at).execute(&mut *tx).await?;
                } else if prev.as_ref().is_some_and(|p| p.inside) {
                    sqlx::query("UPDATE fleet_site_visits SET outside_at=$2,closed_at=now(),end_reason='exit' WHERE id=$1 AND closed_at IS NULL").bind(visit).bind(at).execute(&mut *tx).await?;
                    visit = None;
                }
                prev = Some(Previous {
                    last_at: at,
                    inside,
                    visit_id: visit,
                });
            }
            if let Some(p) = prev {
                sqlx::query("INSERT INTO fleet_site_states(site_id,binding_id,last_at,inside,visit_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(site_id,binding_id) DO UPDATE SET last_at=excluded.last_at,inside=excluded.inside,visit_id=excluded.visit_id").bind(s.id).bind(id).bind(p.last_at).bind(p.inside).bind(p.visit_id).execute(&mut *tx).await?;
            }
        }
        if let Some((at, _, _)) = points.last() {
            sqlx::query("INSERT INTO fleet_site_cursors(binding_id,last_at) VALUES($1,$2) ON CONFLICT(binding_id) DO UPDATE SET last_at=excluded.last_at,checked_at=now()").bind(id).bind(at).execute(&mut *tx).await?;
        }
        if b.ended_at.is_some() && points.len() < 500 {
            sqlx::query("UPDATE fleet_site_visits SET closed_at=now(),end_reason='binding_end' WHERE binding_id=$1 AND closed_at IS NULL").bind(id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
pub fn spawn(pool: PgPool) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = scan(&pool).await {
                tracing::error!("fleet visits: {e:#}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}

/// Match endpoint coordinates against the site definition effective at that
/// time. Renaming/moving a site cannot rewrite previously recorded trip labels.
#[derive(FromRow)]
struct SiteVersion {
    site_id: i64,
    valid_from: DateTime<Utc>,
    valid_to: Option<DateTime<Utc>>,
    snapshot: Value,
}
pub async fn attach_trip_sites(
    pool: &PgPool,
    owner: i64,
    rows: &mut [Value],
) -> anyhow::Result<()> {
    let definitions: Vec<SiteVersion> = sqlx::query_as(
        "SELECT site_id,valid_from,valid_to,snapshot FROM fleet_site_versions WHERE owner_id=$1 ORDER BY site_id,valid_from"
    ).bind(owner).fetch_all(pool).await?;
    for row in rows {
        for (prefix, time_key) in [("start", "started_at"), ("end", "ended_at")] {
            let mut labels = Vec::new();
            if let (Some(at), Some(lat), Some(lng)) = (
                row[time_key]
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok()),
                row[format!("{prefix}_lat")].as_f64(),
                row[format!("{prefix}_lng")].as_f64(),
            ) {
                for SiteVersion {
                    site_id: id,
                    valid_from: from,
                    valid_to: to,
                    snapshot,
                } in &definitions
                {
                    if at < *from || to.is_some_and(|to| at >= to) || snapshot["active"] != true {
                        continue;
                    }
                    if let Ok(g) = serde_json::from_value::<Geometry>(snapshot["geometry"].clone())
                    {
                        if g.contains(lat, lng, None) {
                            labels.push(serde_json::json!({"id":id,"name":snapshot["name"]}));
                        }
                    }
                }
            }
            row[format!("{prefix}_sites")] = Value::Array(labels);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn circle_hysteresis() {
        let g = Geometry::Circle {
            lat: 37.0,
            lng: 127.0,
            radius_m: 100.0,
        };
        assert!(g.valid());
        assert!(g.contains(37.0, 127.0, None));
        assert!(!g.contains(37.1, 127.0, None));
        assert!(g.contains(37.00094, 127.0, Some(true)));
        assert!(!g.contains(37.00086, 127.0, Some(false)));
    }
    #[test]
    fn polygon_validation_and_boundary() {
        let g = Geometry::Polygon {
            points: vec![
                [37.0, 127.0],
                [37.01, 127.0],
                [37.01, 127.01],
                [37.0, 127.01],
            ],
        };
        assert!(g.valid());
        assert!(g.contains(37.005, 127.005, None));
        assert!(!g.contains(37.02, 127.02, None));
        assert!(g.contains(37.0, 127.005, Some(true)));
        assert!(!g.contains(37.0, 127.005, Some(false)));
        assert!(!Geometry::Polygon {
            points: vec![[37., 127.], [37.01, 127.01], [37., 127.01], [37.01, 127.]]
        }
        .valid());
        assert!(!Geometry::Circle {
            lat: f64::NAN,
            lng: 127.,
            radius_m: 200.
        }
        .valid());
    }
}
