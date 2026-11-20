//! Company readers use confirmed subject intervals, never ownership as consent.
//! The ledger intent precedes reads; notices commit before a response is released.
use super::access_ledger::{Access, Recipient};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use sqlx::{Postgres, Transaction};
use std::sync::{Arc, Mutex};

pub const NOTE: &str = "정보주체가 확인한 구간만 표시합니다. 미확인·철회·중지 구간은 제외되며 전체 운행 합계와 다를 수 있습니다.";
pub fn supported(route: &str) -> bool {
    super::subject_provision::enabled()
        && matches!(
            route,
            "/corporate/terminals"
                | "/corporate/devices/:id/trips"
                | "/corporate/devices/:id/trips.csv"
                | "/corporate/vehicles/:id/trips"
                | "/corporate/fleet/trip-stats"
                | "/corporate/vehicle-stats"
                | "/corporate/report.xlsx"
        )
}

pub fn period(
    route: &str,
    query: Option<&str>,
    at: DateTime<Utc>,
    asked: Option<(DateTime<Utc>, DateTime<Utc>)>,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    if route.ends_with("-stats") && asked.is_some() {
        return asked;
    }
    if route.ends_with("report.xlsx") || route.ends_with("-stats") {
        let url = reqwest::Url::parse(&format!("http://x/?{}", query.unwrap_or(""))).ok()?;
        let month = url
            .query_pairs()
            .find(|(k, _)| k == "month")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_else(|| (at + Duration::hours(9)).format("%Y-%m").to_string());
        let first = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").ok()?;
        let next = if first.month() == 12 {
            NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)?
        } else {
            NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)?
        };
        return Some((
            Utc.from_utc_datetime(&first.and_hms_opt(0, 0, 0)?) - Duration::hours(9),
            Utc.from_utc_datetime(&next.and_hms_opt(0, 0, 0)?) - Duration::hours(9),
        ));
    }
    asked.or(Some((
        at - Duration::days(31),
        at + Duration::microseconds(1),
    )))
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Span {
    pub id: i64,
    pub subject: i64,
    pub device: i64,
    pub vehicle: i64,
    pub binding: i64,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}
#[derive(Debug)]
pub struct Projection {
    owner: i64,
    actor: i64,
    device: Option<i64>,
    vehicle: Option<i64>,
    pub from: DateTime<Utc>,
    pub until: DateTime<Utc>,
    policy: String,
    pub spans: Vec<Span>,
    used: Mutex<Vec<i64>>,
}
tokio::task_local! { static CURRENT: Option<Arc<Projection>>; }
pub async fn inside<F: std::future::Future>(p: Option<Arc<Projection>>, work: F) -> F::Output {
    CURRENT.scope(p, work).await
}
pub fn current() -> Option<Arc<Projection>> {
    CURRENT.try_with(Clone::clone).ok().flatten()
}
pub fn mark(id: i64) {
    if let Some(p) = current() {
        p.used.lock().expect("projection usage").push(id);
    }
}
pub fn mark_values(rows: &[serde_json::Value]) {
    for row in rows {
        if let Some(id) = row["quality"]["subject_mapping_id"].as_i64() {
            mark(id);
        }
    }
}
impl Projection {
    pub fn for_device(&self, device: i64) -> Vec<Span> {
        self.spans
            .iter()
            .filter(|s| s.device == device)
            .cloned()
            .collect()
    }
    pub fn vehicle_allowed(&self, vehicle: i64) -> bool {
        self.spans.iter().any(|s| s.vehicle == vehicle)
    }
    pub fn contains(
        &self,
        device: i64,
        vehicle: i64,
        from: DateTime<Utc>,
        until: DateTime<Utc>,
    ) -> bool {
        self.spans
            .iter()
            .any(|s| s.device == device && s.vehicle == vehicle && s.start <= from && until < s.end)
    }
}

async fn spans(tx: &mut Transaction<'_, Postgres>, p: &Projection) -> anyhow::Result<Vec<Span>> {
    // Current account, member role, per-vehicle permission and binding all participate.
    // A revoked overlap is not silently replaced by a later declaration.
    let rows = sqlx::query_as::<_, Span>(r#"
      SELECT m.id,m.subject_id AS subject,m.device_id AS device,m.vehicle_id AS vehicle,m.binding_id AS binding,
        GREATEST(m.starts_at,b.started_at,$3) AS start, LEAST(m.ends_at,COALESCE(b.ended_at,m.ends_at),$4) AS "end"
      FROM location_subject_effective m
      JOIN fleet_vehicle_bindings b ON b.id=m.binding_id AND b.owner_id=m.owner_id AND b.vehicle_id=m.vehicle_id AND b.device_id=m.device_id AND b.is_primary
      JOIN fleet_vehicles v ON v.id=m.vehicle_id AND v.owner_id=m.owner_id
      JOIN privacy_account_controls subject ON subject.user_id=m.subject_id AND NOT subject.restricted
      JOIN privacy_account_controls recipient ON recipient.user_id=$2 AND NOT recipient.restricted
      LEFT JOIN privacy_processing_controls c ON c.user_id=m.subject_id
      WHERE m.owner_id=$1 AND m.status='confirmed' AND ($5::bigint IS NULL OR m.device_id=$5) AND ($6::bigint IS NULL OR m.vehicle_id=$6)
        AND GREATEST(m.starts_at,b.started_at,$3)<LEAST(m.ends_at,COALESCE(b.ended_at,m.ends_at),$4)
        AND NOT COALESCE(c.use_paused,false) AND (m.subject_id=$2 OR NOT COALESCE(c.provision_paused,false))
        AND ($1=$2 OR EXISTS(SELECT 1 FROM fleet_staff_accounts a JOIN staff s ON s.id=a.staff_id AND s.user_id=a.owner_id
          WHERE a.owner_id=$1 AND a.account_id=$2 AND s.active AND (s.access_role='admin'
           OR (s.access_role='department_manager' AND s.department_id=v.department_id)
           OR (s.access_role='member' AND (s.all_vehicles OR v.manager_staff_id=s.id OR EXISTS(SELECT 1 FROM fleet_staff_vehicles x WHERE x.owner_id=$1 AND x.staff_id=s.id AND x.vehicle_id=v.id))))))
      ORDER BY m.starts_at,m.id
    "#).bind(p.owner).bind(p.actor).bind(p.from).bind(p.until).bind(p.device).bind(p.vehicle)
        .fetch_all(&mut **tx).await?;
    Ok(rows)
}
pub async fn prepare(
    tx: &mut Transaction<'_, Postgres>,
    a: &Access,
    owner: Option<i64>,
    device: Option<i64>,
    vehicle: Option<i64>,
) -> anyhow::Result<Option<Arc<Projection>>> {
    if !supported(a.route) {
        return Ok(None);
    }
    let owner = owner.ok_or_else(|| anyhow::anyhow!("company scope missing"))?;
    let actor = match a.recipient {
        Recipient::Own(id) | Recipient::Company(id) => id,
        _ => anyhow::bail!("unsupported company recipient"),
    };
    let (from, until) = a
        .range
        .ok_or_else(|| anyhow::anyhow!("bounded range required"))?;
    anyhow::ensure!(
        from < until && until - from <= Duration::days(367),
        "invalid company range"
    );
    let policy: String = sqlx::query_scalar(
        "SELECT reference FROM location_subject_policy WHERE singleton AND enabled",
    )
    .fetch_one(&mut **tx)
    .await?;
    let mut p = Projection {
        owner,
        actor,
        device,
        vehicle,
        from,
        until,
        policy,
        spans: vec![],
        used: Mutex::new(vec![]),
    };
    p.spans = spans(tx, &p).await?;
    Ok(Some(Arc::new(p)))
}
pub async fn complete(
    tx: &mut Transaction<'_, Postgres>,
    p: &Projection,
    event: i64,
) -> anyhow::Result<()> {
    // Recheck changes not governed by the privacy fence (vehicle/department assignments).
    anyhow::ensure!(
        spans(tx, p).await? == p.spans,
        "company scope changed during read"
    );
    let policy: Option<String> = sqlx::query_scalar(
        "SELECT reference FROM location_subject_policy WHERE singleton AND enabled",
    )
    .fetch_optional(&mut **tx)
    .await?;
    anyhow::ensure!(policy.as_ref() == Some(&p.policy), "subject policy changed");
    let used = p.used.lock().expect("projection usage").clone();
    for s in &p.spans {
        if s.subject == p.actor || !used.contains(&s.id) {
            continue;
        }
        sqlx::query("INSERT INTO location_provision_notices(event_id,mapping_id,subject_id,owner_id,actor_id,device_id,vehicle_id,purpose,consent_version,policy_reference,range_from,range_until,started_at) SELECT $1,$2,$3,$4,$5,$6,$7,'fleet_operations','fleet-subject-v1',$8,$9,$10,started_at FROM location_access_events WHERE id=$1")
            .bind(event).bind(s.id).bind(s.subject).bind(p.owner).bind(p.actor).bind(s.device).bind(s.vehicle).bind(&p.policy).bind(s.start).bind(s.end).execute(&mut **tx).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn month_is_half_open_kst_and_invalid_month_is_not_defaulted() {
        let at = DateTime::parse_from_rfc3339("2026-11-08T01:00:00+09:00")
            .unwrap()
            .with_timezone(&Utc);
        let (from, end) =
            period("/corporate/report.xlsx", Some("month=2026-02"), at, None).unwrap();
        assert_eq!(from.to_rfc3339(), "2026-01-31T15:00:00+00:00");
        assert_eq!(end - from, Duration::days(28));
        assert!(period("/corporate/report.xlsx", Some("month=bad"), at, None).is_none());
    }
}
