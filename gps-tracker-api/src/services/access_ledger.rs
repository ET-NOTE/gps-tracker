//! The record of who was given a person's location information: who received it, through what,
//! how and when (위치정보 이용·제공사실 확인자료, the handling ledger). Never the location itself:
//! no coordinate, address, response body or link token is kept.
//!
//! Recording is off unless `GPS_LOCATION_ACCESS_LOG=on`. Nothing is made up for the past: the
//! periods in which the recorder ran are in `location_access_coverage`, and a read outside them
//! has no record.
//!
//! A request never waits for the ledger. A fact goes to a bounded queue; a background task gathers
//! equal facts of the same hour into one row (first time, last time, count) and writes every few
//! seconds. A fact that cannot be queued is counted in the coverage row instead of being lost
//! silently. An unclean stop loses at most the facts gathered since the last write.
use crate::{
    auth::{fleet::FleetScope, jwt},
    state::AppState,
};
use axum::{
    extract::{MatchedPath, Request, State},
    middleware::Next,
    response::Response,
};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

/// Raised whenever the set of recorded reads changes, so a period can be read with the list that applied.
pub const SCOPE_VERSION: i32 = 1;
/// The shortest retention that can be configured. The table itself refuses to delete a row
/// younger than six months (위치정보의 관리적·기술적 보호조치 기준 제6조); six calendar months are
/// at most 184 days, so a purge at this setting never meets that refusal.
pub const MIN_KEEP_DAYS: i64 = 185;
const QUEUE: usize = 8192;
const MAX_PENDING: usize = 50_000;
const PREFIX: &str = "/gps-tracker/api/v1";

/// Whose location information it was.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    /// One device; the account is the device's owner when the row is written.
    Device(i64),
    /// Everything of one account.
    Account(i64),
    Vehicle {
        owner: i64,
        vehicle: i64,
    },
    /// A share link by its token. Resolved to the link's id; the token is never stored.
    Share(String),
    /// The account a privacy request is about.
    Request(i64),
    Everyone,
    /// An outside transfer whose call site named no subject. It is recorded so that it is noticed.
    Unattributed,
}

/// Who received it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Recipient {
    Own(i64),
    Company(i64),
    Admin(i64),
    ShareLink,
    Processor(&'static str),
}

#[derive(Clone, Debug)]
pub struct Access {
    pub at: DateTime<Utc>,
    pub target: Target,
    pub recipient: Recipient,
    pub path: &'static str,
    pub method: &'static str,
    pub range: Option<(DateTime<Utc>, DateTime<Utc>)>,
}

enum Message {
    Fact(Access),
    Close(oneshot::Sender<()>),
}
struct Handle {
    queue: mpsc::Sender<Message>,
    dropped: AtomicU64,
}
static HANDLE: OnceLock<Handle> = OnceLock::new();
tokio::task_local! { static ABOUT: Target; }

pub fn enabled() -> bool {
    HANDLE.get().is_some()
}

/// Never blocks and never fails the caller.
pub fn note(access: Access) {
    if let Some(handle) = HANDLE.get() {
        if handle.queue.try_send(Message::Fact(access)).is_err() {
            handle.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Names the subject for whatever `work` sends to an outside service.
pub async fn about<F: Future>(target: Target, work: F) -> F::Output {
    ABOUT.scope(target, work).await
}

/// Called at the point where location-derived data actually leaves for an outside service.
pub fn sent_to(processor: &'static str, method: &'static str) {
    if enabled() {
        note(Access {
            at: Utc::now(),
            target: ABOUT.try_with(Clone::clone).unwrap_or(Target::Unattributed),
            recipient: Recipient::Processor(processor),
            path: "server",
            method,
            range: None,
        });
    }
}

/// Starts recording when it is switched on. A coverage row marks the start of this run.
pub async fn start(pool: PgPool) -> anyhow::Result<bool> {
    if std::env::var("GPS_LOCATION_ACCESS_LOG").as_deref() != Ok("on") {
        return Ok(false);
    }
    let seconds = std::env::var("GPS_LOCATION_ACCESS_FLUSH_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30)
        .clamp(1, 300);
    let coverage: i64 = sqlx::query_scalar(
        "INSERT INTO location_access_coverage(release,scope_version) VALUES($1,$2) RETURNING id",
    )
    .bind(option_env!("GPS_RELEASE").unwrap_or("local"))
    .bind(SCOPE_VERSION)
    .fetch_one(&pool)
    .await?;
    let (queue, facts) = mpsc::channel(QUEUE);
    HANDLE
        .set(Handle {
            queue,
            dropped: AtomicU64::new(0),
        })
        .map_err(|_| anyhow::anyhow!("the location access ledger was started twice"))?;
    tokio::spawn(run(pool, facts, coverage, Duration::from_secs(seconds)));
    tracing::info!(coverage, seconds, "location access ledger: recording");
    Ok(true)
}

/// Writes what is gathered and marks the run as stopped. Called once the server no longer serves.
pub async fn close() {
    if let Some(handle) = HANDLE.get() {
        let (done, finished) = oneshot::channel();
        if handle.queue.send(Message::Close(done)).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(10), finished).await;
        }
    }
}

#[derive(PartialEq, Eq, Hash)]
struct Key {
    bucket: i64,
    target: Target,
    recipient: Recipient,
    path: &'static str,
    method: &'static str,
}
struct Seen {
    first: DateTime<Utc>,
    last: DateTime<Utc>,
    hits: i32,
    range: Option<(DateTime<Utc>, DateTime<Utc>)>,
}

fn hour(at: DateTime<Utc>) -> i64 {
    at.timestamp() - at.timestamp().rem_euclid(3600)
}

fn widen(
    a: Option<(DateTime<Utc>, DateTime<Utc>)>,
    b: Option<(DateTime<Utc>, DateTime<Utc>)>,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    match (a, b) {
        (Some(a), Some(b)) => Some((a.0.min(b.0), a.1.max(b.1))),
        (a, b) => a.or(b),
    }
}

/// Returns false when the fact could not be kept.
fn gather(pending: &mut HashMap<Key, Seen>, access: Access) -> bool {
    let key = Key {
        bucket: hour(access.at),
        target: access.target,
        recipient: access.recipient,
        path: access.path,
        method: access.method,
    };
    if pending.len() >= MAX_PENDING && !pending.contains_key(&key) {
        return false;
    }
    let seen = pending.entry(key).or_insert(Seen {
        first: access.at,
        last: access.at,
        hits: 0,
        range: None,
    });
    seen.hits = seen.hits.saturating_add(1);
    seen.first = seen.first.min(access.at);
    seen.last = seen.last.max(access.at);
    seen.range = widen(seen.range, access.range);
    true
}

async fn run(pool: PgPool, mut facts: mpsc::Receiver<Message>, coverage: i64, every: Duration) {
    let mut pending: HashMap<Key, Seen> = HashMap::new();
    let mut unkept: u64 = 0;
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            message = facts.recv() => match message {
                Some(Message::Fact(access)) => {
                    if !gather(&mut pending, access) {
                        unkept += 1;
                    }
                }
                Some(Message::Close(done)) => {
                    flush(&pool, &mut pending, coverage, &mut unkept, true).await;
                    let _ = done.send(());
                    return;
                }
                None => return,
            },
            _ = tick.tick() => flush(&pool, &mut pending, coverage, &mut unkept, false).await,
        }
    }
}

async fn flush(
    pool: &PgPool,
    pending: &mut HashMap<Key, Seen>,
    coverage: i64,
    unkept: &mut u64,
    stopping: bool,
) {
    let dropped = HANDLE
        .get()
        .map_or(0, |h| h.dropped.swap(0, Ordering::Relaxed))
        + std::mem::take(unkept);
    match write(pool, pending, coverage, dropped, stopping).await {
        Ok(()) => pending.clear(),
        Err(error) => {
            // Kept for the next attempt; the count of what could not be kept is not forgotten either.
            *unkept += dropped;
            tracing::warn!("location access ledger: write failed, will retry: {error:#}");
        }
    }
}

struct Line {
    bucket: DateTime<Utc>,
    first: DateTime<Utc>,
    last: DateTime<Utc>,
    hits: i32,
    subject: Option<i64>,
    everyone: bool,
    device: Option<i64>,
    vehicle: Option<i64>,
    share: Option<i64>,
    kind: &'static str,
    user: Option<i64>,
    name: Option<&'static str>,
    path: &'static str,
    method: &'static str,
    range: Option<(DateTime<Utc>, DateTime<Utc>)>,
}

fn part(value: Option<i64>) -> String {
    value.map(|v| v.to_string()).unwrap_or_default()
}

/// One row per hour for one subject, one recipient, one path and one method.
fn identity(line: &Line) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        line.bucket.timestamp(),
        part(line.subject),
        line.everyone,
        part(line.device),
        part(line.vehicle),
        part(line.share),
        line.kind,
        part(line.user),
        line.name.unwrap_or_default(),
        line.path,
        line.method
    )
}

async fn write(
    pool: &PgPool,
    pending: &HashMap<Key, Seen>,
    coverage: i64,
    dropped: u64,
    stopping: bool,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    if !pending.is_empty() {
        let mut devices = vec![];
        let mut tokens = vec![];
        let mut requests = vec![];
        for key in pending.keys() {
            match &key.target {
                Target::Device(id) => devices.push(*id),
                Target::Share(token) => tokens.push(token.clone()),
                Target::Request(id) => requests.push(*id),
                _ => {}
            }
        }
        let owners: HashMap<i64, Option<i64>> = sqlx::query_as::<_, (i64, Option<i64>)>(
            "SELECT id,owner_id FROM devices WHERE id=ANY($1)",
        )
        .bind(&devices)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
        let links: HashMap<String, (i64, Option<i64>, Option<i64>)> = sqlx::query_as::<
            _,
            (String, i64, Option<i64>, Option<i64>),
        >(
            "SELECT s.token,s.id,s.device_id,s.created_by FROM share_tokens s WHERE s.token=ANY($1)",
        )
        .bind(&tokens)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|(token, id, device, owner)| (token, (id, device, owner)))
        .collect();
        let subjects: HashMap<i64, i64> = sqlx::query_as::<_, (i64, i64)>(
            "SELECT id,user_id FROM privacy_requests WHERE id=ANY($1)",
        )
        .bind(&requests)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();

        // Different facts can come to the same row once they are resolved; they are added up here.
        let mut lines: HashMap<String, Line> = HashMap::new();
        for (key, seen) in pending {
            let (mut subject, mut everyone, mut device, mut vehicle, mut share) =
                (None, false, None, None, None);
            match &key.target {
                Target::Device(id) => {
                    device = Some(*id);
                    subject = owners.get(id).copied().flatten();
                }
                Target::Account(id) => subject = Some(*id),
                Target::Vehicle { owner, vehicle: id } => {
                    subject = Some(*owner);
                    vehicle = Some(*id);
                }
                Target::Share(token) => {
                    if let Some((id, of, owner)) = links.get(token) {
                        share = Some(*id);
                        device = *of;
                        subject = *owner;
                    }
                }
                Target::Request(id) => subject = subjects.get(id).copied(),
                Target::Everyone => everyone = true,
                Target::Unattributed => {}
            }
            let (kind, user, name) = match key.recipient {
                Recipient::Own(id) => ("self", Some(id), None),
                Recipient::Company(id) => ("company", Some(id), None),
                Recipient::Admin(id) => ("admin", Some(id), None),
                Recipient::ShareLink => ("share_link", None, None),
                Recipient::Processor(name) => ("processor", None, Some(name)),
            };
            let line = Line {
                bucket: Utc
                    .timestamp_opt(key.bucket, 0)
                    .single()
                    .unwrap_or(seen.first),
                first: seen.first,
                last: seen.last,
                hits: seen.hits,
                subject,
                everyone,
                device,
                vehicle,
                share,
                kind,
                user,
                name,
                path: key.path,
                method: key.method,
                range: seen.range,
            };
            match lines.entry(identity(&line)) {
                std::collections::hash_map::Entry::Occupied(mut same) => {
                    let same = same.get_mut();
                    same.hits = same.hits.saturating_add(line.hits);
                    same.first = same.first.min(line.first);
                    same.last = same.last.max(line.last);
                    same.range = widen(same.range, line.range);
                }
                std::collections::hash_map::Entry::Vacant(new) => {
                    new.insert(line);
                }
            }
        }
        let keys: Vec<&String> = lines.keys().collect();
        let rows: Vec<&Line> = keys.iter().map(|key| &lines[*key]).collect();
        sqlx::query(
            "INSERT INTO location_access_log(bucket,first_at,last_at,hits,subject_user_id,all_subjects,device_id,vehicle_id,share_id,\
             recipient_kind,recipient_user_id,recipient_name,path,method,range_from,range_until,bucket_key) \
             SELECT * FROM UNNEST($1::timestamptz[],$2::timestamptz[],$3::timestamptz[],$4::int[],$5::bigint[],$6::bool[],$7::bigint[],$8::bigint[],$9::bigint[],\
             $10::text[],$11::bigint[],$12::text[],$13::text[],$14::text[],$15::timestamptz[],$16::timestamptz[],$17::text[]) \
             ON CONFLICT (bucket_key) DO UPDATE SET hits=location_access_log.hits+EXCLUDED.hits,\
             last_at=GREATEST(location_access_log.last_at,EXCLUDED.last_at),\
             range_from=LEAST(location_access_log.range_from,EXCLUDED.range_from),\
             range_until=GREATEST(location_access_log.range_until,EXCLUDED.range_until)",
        )
        .bind(rows.iter().map(|r| r.bucket).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.first).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.last).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.hits).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.subject).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.everyone).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.device).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.vehicle).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.share).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.kind).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.user).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.name).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.path).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.method).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.range.map(|x| x.0)).collect::<Vec<_>>())
        .bind(rows.iter().map(|r| r.range.map(|x| x.1)).collect::<Vec<_>>())
        .bind(keys)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE location_access_coverage SET alive_at=now(),dropped=dropped+$2,stopped_at=CASE WHEN $3 THEN now() END WHERE id=$1",
    )
    .bind(coverage)
    .bind(i64::try_from(dropped).unwrap_or(i64::MAX))
    .bind(stopping)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Removes records older than the stated retention. Runs only when the retention is configured,
/// and never below the legal floor.
pub async fn purge(pool: &PgPool) -> anyhow::Result<u64> {
    let Some(days) = std::env::var("GPS_LOCATION_ACCESS_KEEP_DAYS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
    else {
        return Ok(0);
    };
    anyhow::ensure!(
        days >= MIN_KEEP_DAYS,
        "GPS_LOCATION_ACCESS_KEEP_DAYS={days} is below the minimum of {MIN_KEEP_DAYS} days; nothing was removed"
    );
    let removed = sqlx::query(
        "DELETE FROM location_access_log WHERE bucket < now() - make_interval(days => $1::int)",
    )
    .bind(days)
    .execute(pool)
    .await?
    .rows_affected();
    sqlx::query("DELETE FROM location_access_coverage WHERE COALESCE(stopped_at,alive_at) < now() - make_interval(days => $1::int) AND id<>(SELECT max(id) FROM location_access_coverage)")
        .bind(days)
        .execute(pool)
        .await?;
    Ok(removed)
}

// ── which requests are reads of location information ─────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Of {
    Device,
    Account,
    Vehicle,
    Company,
    Share,
    AdminAccount,
    AdminDevice,
    AdminEveryone,
    AdminRequest,
}
/// (verb, route as registered, method recorded, whose it is)
struct Rule(&'static str, &'static str, &'static str, Of);

/// Every route that hands out stored location or something derived from it. A route that is not
/// here is not recorded: adding a reader means adding its line and raising `SCOPE_VERSION`.
const RULES: &[Rule] = &[
    Rule("GET", "/devices", "position", Of::Account),
    Rule("GET", "/devices/:id", "position", Of::Device),
    Rule("PATCH", "/devices/:id", "position", Of::Device),
    Rule("POST", "/devices/pair", "position", Of::Account),
    Rule("POST", "/devices/pair-phone", "position", Of::Account),
    Rule("PATCH", "/devices/:id/fuel-info", "position", Of::Device),
    Rule("PATCH", "/devices/:id/vehicle-info", "position", Of::Device),
    Rule(
        "POST",
        "/devices/:id/sleep-report-interval",
        "position",
        Of::Device,
    ),
    Rule("GET", "/devices/:id/events", "events", Of::Device),
    Rule("GET", "/devices/:id/batch-stats", "stats", Of::Device),
    Rule(
        "GET",
        "/devices/:id/locations/aggregated",
        "track",
        Of::Device,
    ),
    Rule(
        "GET",
        "/devices/:id/locations/latest",
        "position",
        Of::Device,
    ),
    Rule("GET", "/devices/:id/locations/page", "track", Of::Device),
    Rule("GET", "/devices/:id/locations", "track", Of::Device),
    Rule("GET", "/devices/:id/stats/daily", "stats", Of::Device),
    Rule("GET", "/devices/:id/active-dates", "stats", Of::Device),
    Rule("GET", "/geofences/history", "events", Of::Account),
    Rule("GET", "/geofences/:id/history", "events", Of::Account),
    Rule("POST", "/devices/:id/route/analyze", "analysis", Of::Device),
    Rule("GET", "/devices/:id/ai-analyses", "analysis", Of::Device),
    Rule("GET", "/ai-analyses/:id", "analysis", Of::Account),
    Rule("GET", "/share/:token", "position", Of::Share),
    Rule("GET", "/share/:token/locations", "track", Of::Share),
    Rule("GET", "/share/:token/daily_stats", "stats", Of::Share),
    Rule("GET", "/corporate/terminals", "position", Of::Company),
    Rule("GET", "/corporate/devices/:id/trips", "trips", Of::Device),
    Rule(
        "GET",
        "/corporate/devices/:id/trips.csv",
        "file",
        Of::Device,
    ),
    Rule("GET", "/corporate/fleet/trip-stats", "stats", Of::Company),
    Rule("GET", "/corporate/report.xlsx", "file", Of::Company),
    Rule("GET", "/corporate/vehicles/:id/trips", "trips", Of::Vehicle),
    Rule("GET", "/corporate/vehicle-stats", "stats", Of::Company),
    Rule(
        "POST",
        "/corporate/vehicles/:id/trips/evidence",
        "track",
        Of::Vehicle,
    ),
    Rule(
        "POST",
        "/corporate/vehicles/:id/trips/corrections",
        "trips",
        Of::Vehicle,
    ),
    Rule(
        "GET",
        "/corporate/vehicles/:id/trips/corrections",
        "trips",
        Of::Vehicle,
    ),
    Rule(
        "POST",
        "/corporate/vehicles/:id/trips/assign",
        "trips",
        Of::Vehicle,
    ),
    Rule("GET", "/corporate/sites", "events", Of::Company),
    Rule("GET", "/corporate/site-visits", "events", Of::Company),
    Rule(
        "GET",
        "/admin/users/:id/devices",
        "position",
        Of::AdminAccount,
    ),
    Rule("GET", "/admin/devices", "position", Of::AdminEveryone),
    Rule("GET", "/admin/devices/:id", "position", Of::AdminDevice),
    Rule(
        "POST",
        "/privacy/deliveries/:id/download",
        "file",
        Of::Account,
    ),
    Rule(
        "POST",
        "/admin/privacy/requests/:id/text-sources/:kind/:source",
        "analysis",
        Of::AdminRequest,
    ),
    Rule(
        "POST",
        "/admin/privacy/requests/:id/redacted-preview",
        "analysis",
        Of::AdminRequest,
    ),
    Rule(
        "POST",
        "/privacy/redacted/:id/download",
        "analysis",
        Of::Account,
    ),
];

/// The period a request asks for, when it names one. Dates are days in Korean time.
fn asked(query: Option<&str>) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let url = reqwest::Url::parse(&format!("http://x/?{}", query?)).ok()?;
    let moment = |text: &str, end_of_day: bool| -> Option<DateTime<Utc>> {
        if let Ok(at) = DateTime::parse_from_rfc3339(text) {
            return Some(at.with_timezone(&Utc));
        }
        let day = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
        let day = if end_of_day { day.succ_opt()? } else { day };
        Some(Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0)?) - chrono::Duration::hours(9))
    };
    let (mut from, mut until) = (None, None);
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "since" | "from" | "start" | "start_date" | "date_from" => from = moment(&value, false),
            "until" | "to" | "end" | "end_date" | "date_to" => until = moment(&value, true),
            "date" => {
                from = moment(&value, false);
                until = moment(&value, true);
            }
            _ => {}
        }
    }
    match (from, until) {
        (Some(from), Some(until)) if from < until => Some((from, until)),
        _ => None,
    }
}

/// What a request would be recorded as, were it answered. `caller` and `acting_admin` come from
/// the access token; `scope` is the company scope the request runs in, if any.
fn plan(
    verb: &str,
    route: &str,
    path: &str,
    query: Option<&str>,
    caller: Option<i64>,
    acting_admin: Option<i64>,
    scope: Option<(i64, i64)>,
) -> Option<Access> {
    let route = route.strip_prefix(PREFIX).unwrap_or(route);
    let path = path.strip_prefix(PREFIX).unwrap_or(path);
    let rule = RULES.iter().find(|r| r.0 == verb && r.1 == route)?;
    let value = |name: &str| {
        route
            .split('/')
            .zip(path.split('/'))
            .find(|(part, _)| *part == name)
            .map(|(_, v)| v)
    };
    let id = value(":id").and_then(|v| v.parse::<i64>().ok());
    let owner = scope.map(|s| s.0).or(caller);
    let mut via = "api";
    let (target, recipient) = match rule.3 {
        Of::Share => {
            via = "share_link";
            (
                Target::Share(value(":token")?.to_string()),
                Recipient::ShareLink,
            )
        }
        Of::AdminAccount => (Target::Account(id?), Recipient::Admin(caller?)),
        Of::AdminDevice => (Target::Device(id?), Recipient::Admin(caller?)),
        Of::AdminEveryone => (Target::Everyone, Recipient::Admin(caller?)),
        Of::AdminRequest => (Target::Request(id?), Recipient::Admin(caller?)),
        whose => {
            // An administrator signed in as the account is the recipient, not the account.
            let recipient = match (acting_admin, scope) {
                (Some(admin), _) => {
                    via = "impersonation";
                    Recipient::Admin(admin)
                }
                (None, Some((owner, actor))) if actor != owner => Recipient::Company(actor),
                _ => Recipient::Own(caller?),
            };
            let target = match whose {
                Of::Device => Target::Device(id?),
                Of::Vehicle => Target::Vehicle {
                    owner: owner?,
                    vehicle: id?,
                },
                _ => Target::Account(owner?),
            };
            (target, recipient)
        }
    };
    Some(Access {
        at: Utc::now(),
        target,
        recipient,
        path: via,
        method: rule.2,
        range: asked(query),
    })
}

/// The account of an access token and, when an administrator signed in as that account, the administrator.
pub fn reader(token: &str, secret: &str) -> Option<(i64, Option<i64>)> {
    let claims = jwt::verify(token, secret, "access").ok()?;
    Some((
        claims.sub.parse().ok()?,
        claims.act.as_deref().and_then(|a| a.parse().ok()),
    ))
}

/// Records an answered read. Sits inside the company scope layer, so it sees who really asked.
pub async fn middleware(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !enabled() {
        return next.run(request).await;
    }
    let planned = request
        .extensions()
        .get::<MatchedPath>()
        .and_then(|matched| {
            let who = request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .and_then(|token| reader(token, &state.config.jwt_secret));
            plan(
                request.method().as_str(),
                matched.as_str(),
                request.uri().path(),
                request.uri().query(),
                who.map(|w| w.0),
                who.and_then(|w| w.1),
                request
                    .extensions()
                    .get::<FleetScope>()
                    .map(|s| (s.owner, s.actor)),
            )
        });
    let response = next.run(request).await;
    if let Some(mut access) = planned {
        if response.status().is_success() {
            access.at = Utc::now();
            note(access);
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn every_recorded_route_is_registered_and_uses_a_stored_value() {
        // A renamed or removed route must not silently stop being recorded.
        let routes = [
            include_str!("../routes/devices.rs"),
            include_str!("../routes/locations.rs"),
            include_str!("../routes/stats.rs"),
            include_str!("../routes/geofences.rs"),
            include_str!("../routes/ai.rs"),
            include_str!("../routes/share.rs"),
            include_str!("../routes/corporate.rs"),
            include_str!("../routes/fleet_team.rs"),
            include_str!("../routes/fleet_vehicles.rs"),
            include_str!("../routes/fleet_trip_quality.rs"),
            include_str!("../routes/fleet_trip_assignment.rs"),
            include_str!("../routes/fleet_sites.rs"),
            include_str!("../routes/admin.rs"),
            include_str!("../routes/privacy_delivery.rs"),
            include_str!("../routes/privacy_redacted.rs"),
        ]
        .concat();
        let table = include_str!("../../migrations/0100_location_access_log.sql");
        for (index, rule) in RULES.iter().enumerate() {
            assert!(
                routes.contains(&format!("\"{}\"", rule.1)),
                "{} is not a registered route",
                rule.1
            );
            assert!(
                table.contains(&format!("'{}'", rule.2)),
                "method {} is not accepted by the table",
                rule.2
            );
            assert!(
                !RULES[..index]
                    .iter()
                    .any(|r| r.0 == rule.0 && r.1 == rule.1),
                "{} {} is listed twice",
                rule.0,
                rule.1
            );
        }
        for value in [
            "api",
            "share_link",
            "realtime",
            "impersonation",
            "server",
            "geocode",
            "push",
            "analysis",
        ] {
            assert!(
                table.contains(&format!("'{value}'")),
                "{value} is not accepted by the table"
            );
        }
    }

    #[test]
    fn a_read_is_recorded_for_whoever_really_received_it() {
        let own = plan(
            "GET",
            "/gps-tracker/api/v1/devices/:id/locations",
            "/devices/7/locations",
            Some("since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z"),
            Some(3),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            (own.target, own.recipient, own.path, own.method),
            (Target::Device(7), Recipient::Own(3), "api", "track")
        );
        assert_eq!(
            own.range,
            Some((at("2026-11-01T00:00:00Z"), at("2026-11-02T00:00:00Z")))
        );

        // A company member reads through the owner's scope: the member is the recipient.
        let staff = plan(
            "GET",
            "/corporate/vehicles/:id/trips",
            "/gps-tracker/api/v1/corporate/vehicles/12/trips",
            None,
            Some(40),
            None,
            Some((9, 40)),
        )
        .unwrap();
        assert_eq!(
            (staff.target, staff.recipient),
            (
                Target::Vehicle {
                    owner: 9,
                    vehicle: 12
                },
                Recipient::Company(40)
            )
        );
        let owner = plan(
            "GET",
            "/corporate/vehicle-stats",
            "/corporate/vehicle-stats",
            None,
            Some(9),
            None,
            Some((9, 9)),
        )
        .unwrap();
        assert_eq!(
            (owner.target, owner.recipient),
            (Target::Account(9), Recipient::Own(9))
        );

        // An administrator signed in as the account is not the account.
        let acting = plan("GET", "/devices", "/devices", None, Some(3), Some(1), None).unwrap();
        assert_eq!(
            (acting.target, acting.recipient, acting.path),
            (Target::Account(3), Recipient::Admin(1), "impersonation")
        );

        let admin = plan(
            "GET",
            "/admin/devices",
            "/admin/devices",
            None,
            Some(1),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            (admin.target, admin.recipient),
            (Target::Everyone, Recipient::Admin(1))
        );
        let one = plan(
            "GET",
            "/admin/users/:id/devices",
            "/admin/users/55/devices",
            None,
            Some(1),
            None,
            None,
        )
        .unwrap();
        assert_eq!(one.target, Target::Account(55));

        let link = plan(
            "GET",
            "/share/:token/locations",
            "/share/abcDEF/locations",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            (link.target, link.recipient, link.path),
            (
                Target::Share("abcDEF".into()),
                Recipient::ShareLink,
                "share_link"
            )
        );

        // Not a read of location, a write, or nobody identified: nothing to record.
        assert!(plan(
            "GET",
            "/devices/:id/sim",
            "/devices/7/sim",
            None,
            Some(3),
            None,
            None
        )
        .is_none());
        assert!(plan(
            "DELETE",
            "/devices/:id",
            "/devices/7",
            None,
            Some(3),
            None,
            None
        )
        .is_none());
        assert!(plan("GET", "/devices/:id", "/devices/7", None, None, None, None).is_none());
    }

    #[test]
    fn equal_facts_of_one_hour_become_one_row_and_the_range_only_widens() {
        let mut pending = HashMap::new();
        let fact = |time: &str, range| Access {
            at: at(time),
            target: Target::Device(7),
            recipient: Recipient::Own(3),
            path: "api",
            method: "track",
            range,
        };
        assert!(gather(
            &mut pending,
            fact(
                "2026-11-07T01:10:00Z",
                Some((at("2026-11-01T00:00:00Z"), at("2026-11-02T00:00:00Z")))
            )
        ));
        assert!(gather(
            &mut pending,
            fact(
                "2026-11-07T01:50:00Z",
                Some((at("2026-10-30T00:00:00Z"), at("2026-11-01T12:00:00Z")))
            )
        ));
        assert!(gather(&mut pending, fact("2026-11-07T02:00:00Z", None)));
        assert_eq!(pending.len(), 2);
        let first = pending.values().find(|seen| seen.hits == 2).unwrap();
        assert_eq!(
            (first.first, first.last),
            (at("2026-11-07T01:10:00Z"), at("2026-11-07T01:50:00Z"))
        );
        assert_eq!(
            first.range,
            Some((at("2026-10-30T00:00:00Z"), at("2026-11-02T00:00:00Z")))
        );
        assert_eq!(
            hour(at("2026-11-07T01:59:59Z")),
            at("2026-11-07T01:00:00Z").timestamp()
        );
    }

    #[test]
    fn a_requested_day_is_a_day_in_korean_time() {
        assert_eq!(
            asked(Some("date=2026-11-07")),
            Some((at("2026-11-06T15:00:00Z"), at("2026-11-07T15:00:00Z")))
        );
        assert_eq!(
            asked(Some("from=2026-11-01&to=2026-11-03")),
            Some((at("2026-10-31T15:00:00Z"), at("2026-11-03T15:00:00Z")))
        );
        assert_eq!(asked(Some("limit=10")), None);
        assert_eq!(asked(None), None);
    }

    #[test]
    fn nothing_that_locates_a_person_has_a_place_in_the_table() {
        let table = include_str!("../../migrations/0100_location_access_log.sql");
        let columns: Vec<&str> = table
            .split("CREATE TABLE location_access_log (")
            .nth(1)
            .unwrap()
            .split(");")
            .next()
            .unwrap()
            .lines()
            .filter_map(|line| line.trim().split(' ').next())
            .collect();
        for forbidden in [
            "lat", "lng", "address", "token", "body", "response", "ip", "note",
        ] {
            assert!(!columns.contains(&forbidden), "{forbidden} is a column");
        }
    }

    #[tokio::test]
    async fn what_is_sent_outside_is_recorded_for_the_named_subject() {
        let (queue, mut facts) = mpsc::channel(8);
        assert!(HANDLE
            .set(Handle {
                queue,
                dropped: AtomicU64::new(0),
            })
            .is_ok());
        about(Target::Device(5), async { sent_to("kakao", "geocode") }).await;
        // A call site that names nobody is still recorded, so that it is noticed.
        sent_to("openai", "analysis");
        let mut seen = vec![];
        for _ in 0..2 {
            match facts.recv().await {
                Some(Message::Fact(fact)) => {
                    seen.push((fact.target, fact.recipient, fact.path, fact.method))
                }
                _ => panic!("a fact was expected"),
            }
        }
        assert_eq!(
            seen,
            vec![
                (
                    Target::Device(5),
                    Recipient::Processor("kakao"),
                    "server",
                    "geocode"
                ),
                (
                    Target::Unattributed,
                    Recipient::Processor("openai"),
                    "server",
                    "analysis"
                ),
            ]
        );
    }
}
