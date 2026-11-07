//! Durable, per-operation access intents. Account scope is NOT the actual driver.
//! OFF by default. When ON, an intent commits before data can leave; recording failure
//! blocks that operation. A prepared intent after a crash has an UNKNOWN outcome.
use crate::{
    auth::{fleet::FleetScope, jwt},
    state::AppState,
};
use axum::{
    extract::{MatchedPath, Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use sqlx::PgPool;
use std::{future::Future, sync::OnceLock};

pub const SCOPE_VERSION: i32 = 3;
pub const MIN_KEEP_DAYS: i64 = 185;
const PREFIX: &str = "/gps-tracker/api/v1";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    /// Owner snapshot is context, never proof of historical subject identity.
    Device(i64),
    ScopedDevice {
        account: i64,
        device: i64,
    },
    Account(i64),
    Vehicle {
        owner: i64,
        vehicle: i64,
    },
    Share(String),
    Request(i64),
    Everyone,
    Unattributed,
}
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
    pub route: &'static str,
    pub range: Option<(DateTime<Utc>, DateTime<Utc>)>,
}
struct Handle {
    pool: PgPool,
    coverage: i64,
}
static HANDLE: OnceLock<Handle> = OnceLock::new();
tokio::task_local! { static ABOUT: Target; }
pub fn enabled() -> bool {
    HANDLE.get().is_some()
}
pub async fn about<F: Future>(target: Target, work: F) -> F::Output {
    ABOUT.scope(target, work).await
}

/// Non-cloneable capability to complete exactly one committed intent.
#[derive(Debug)]
pub struct Ticket(Option<i64>, Option<super::privacy_lifecycle::Lease>);
impl Ticket {
    pub fn off() -> Self {
        Self(None, None)
    }
    pub async fn finish(self, outcome: &'static str) -> anyhow::Result<()> {
        if let (Some(id), Some(h)) = (self.0, HANDLE.get()) {
            let mut tx = h.pool.begin().await?;
            let changed = sqlx::query("UPDATE location_access_events SET outcome=$2,completed_at=clock_timestamp() WHERE id=$1 AND outcome='prepared'")
                .bind(id).bind(outcome).execute(&mut *tx).await?.rows_affected();
            anyhow::ensure!(changed == 1, "access intent unavailable; response blocked");
            super::subject_provision::complete(&mut tx, id, outcome).await?;
            tx.commit().await?;
        }
        drop(self.1);
        Ok(())
    }
}

pub async fn begin(access: Access) -> anyhow::Result<Ticket> {
    let lease = super::privacy_lifecycle::guard(&access).await?;
    let Some(h) = HANDLE.get() else {
        return Ok(Ticket(None, Some(lease)));
    };
    let mut tx = h.pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let (mut account, mut device, mut vehicle, mut share) = (None, None, None, None);
    let attribution = match &access.target {
        Target::ScopedDevice {
            account: owner,
            device: id,
        } => {
            account = Some(*owner);
            device = Some(*id);
            "request_account"
        }
        Target::Device(id) => {
            device = Some(*id);
            account = sqlx::query_scalar::<_, Option<i64>>(
                "SELECT owner_id FROM gps_read_devices WHERE id=$1",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
            "owner_snapshot"
        }
        Target::Account(id) => {
            account = Some(*id);
            "request_account"
        }
        Target::Vehicle { owner, vehicle: id } => {
            account = Some(*owner);
            vehicle = Some(*id);
            "company_scope"
        }
        Target::Share(token) => {
            let row: Option<(i64, Option<i64>, Option<i64>)> =
                sqlx::query_as("SELECT id,device_id,created_by FROM share_tokens WHERE token=$1")
                    .bind(token)
                    .fetch_optional(&mut *tx)
                    .await?;
            if let Some((id, d, u)) = row {
                share = Some(id);
                device = d;
                account = u;
            }
            "share_creator"
        }
        Target::Request(id) => {
            account = sqlx::query_scalar("SELECT user_id FROM privacy_requests WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
            "privacy_request"
        }
        Target::Everyone => "all_accounts",
        Target::Unattributed => "unresolved",
    };
    // Corporate routes, even when called by the owner, do not establish a personal subject.
    let attribution = if access.route.starts_with("/corporate/")
        || matches!(access.recipient, Recipient::Company(_))
    {
        "company_scope"
    } else {
        attribution
    };
    if let Some(account) = account {
        sqlx::query("SELECT pg_advisory_xact_lock(1830,$1::int)")
            .bind(account as i32)
            .execute(&mut *tx)
            .await?;
        if matches!(attribution, "request_account" | "privacy_request") {
            let erased:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM location_access_erasure_runs WHERE account_scope_id=$1 AND period_from<=$2 AND period_until>$2)")
                .bind(account).bind(access.at).fetch_one(&mut *tx).await?;
            anyhow::ensure!(!erased, "access intent precedes reviewed erasure boundary");
        }
    }
    let (kind, user, name) = match access.recipient.clone() {
        Recipient::Own(id) => ("self", Some(id), None),
        Recipient::Company(id) => ("company", Some(id), None),
        Recipient::Admin(id) => ("admin", Some(id), None),
        Recipient::ShareLink => ("share_link", None, None),
        Recipient::Processor(name) => ("processor", None, Some(name)),
    };
    let bindings: serde_json::Value = if let Some(vehicle) = vehicle {
        sqlx::query_scalar("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'device_id',device_id,'started_at',started_at,'ended_at',ended_at,'is_primary',is_primary) ORDER BY id),'[]'::jsonb) FROM fleet_vehicle_bindings WHERE vehicle_id=$1 AND owner_id=$2")
            .bind(vehicle).bind(account).fetch_one(&mut *tx).await?
    } else {
        serde_json::json!([])
    };
    let id:i64=sqlx::query_scalar("INSERT INTO location_access_events(started_at,coverage_id,account_scope_id,attribution,all_subjects,device_id,vehicle_id,share_id,recipient_kind,recipient_user_id,recipient_name,path,method,route,range_from,range_until,binding_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id")
        .bind(access.at).bind(h.coverage).bind(account).bind(attribution).bind(matches!(access.target,Target::Everyone))
        .bind(device).bind(vehicle).bind(share).bind(kind).bind(user).bind(name).bind(access.path).bind(access.method).bind(access.route)
        .bind(access.range.map(|r|r.0)).bind(access.range.map(|r|r.1)).bind(bindings).fetch_one(&mut *tx).await?;
    super::subject_provision::prepare(&mut tx, &access, id, account, device, vehicle).await?;
    sqlx::query("UPDATE location_access_coverage SET alive_at=GREATEST(alive_at,clock_timestamp()) WHERE id=$1")
        .bind(h.coverage).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Ticket(Some(id), Some(lease)))
}

pub async fn sent_to(processor: &'static str, method: &'static str) -> anyhow::Result<Ticket> {
    begin(Access {
        at: Utc::now(),
        target: ABOUT.try_with(Clone::clone).unwrap_or(Target::Unattributed),
        recipient: Recipient::Processor(processor),
        path: "server",
        method,
        route: processor,
        range: None,
    })
    .await
}

/// Wrap the actual network operation, not cache hits or queue insertion.
pub async fn external_response(
    ticket: Ticket,
    result: Result<reqwest::Response, reqwest::Error>,
) -> anyhow::Result<reqwest::Response> {
    let outcome = match &result {
        Ok(r) if r.status().is_success() => "http_accepted",
        Ok(_) => "http_rejected",
        Err(_) => "transport_unknown",
    };
    ticket.finish(outcome).await?;
    // Do not propagate reqwest's URL (which can contain coordinates) to logs.
    result.map_err(|_| anyhow::anyhow!("external transport failed; delivery unknown"))
}

pub async fn start(pool: PgPool) -> anyhow::Result<bool> {
    if std::env::var("GPS_LOCATION_ACCESS_LOG").as_deref() != Ok("on") {
        return Ok(false);
    }
    let coverage: i64 = sqlx::query_scalar(
        "INSERT INTO location_access_coverage(release,scope_version) VALUES($1,$2) RETURNING id",
    )
    .bind(option_env!("GPS_RELEASE").unwrap_or("local"))
    .bind(SCOPE_VERSION)
    .fetch_one(&pool)
    .await?;
    HANDLE
        .set(Handle { pool, coverage })
        .map_err(|_| anyhow::anyhow!("ledger already started"))?;
    Ok(true)
}
pub async fn close() {
    if let Some(h) = HANDLE.get() {
        if sqlx::query(
            "UPDATE location_access_coverage SET stopped_at=clock_timestamp() WHERE id=$1",
        )
        .bind(h.coverage)
        .execute(&h.pool)
        .await
        .is_err()
        {
            tracing::error!("ledger shutdown marker unavailable; intents remain durable");
        }
    }
}
pub async fn purge(pool: &PgPool) -> anyhow::Result<u64> {
    let Some(days) = std::env::var("GPS_LOCATION_ACCESS_KEEP_DAYS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
    else {
        return Ok(0);
    };
    anyhow::ensure!(
        (MIN_KEEP_DAYS..=36500).contains(&days),
        "invalid ledger retention; nothing removed"
    );
    let mut tx = pool.begin().await?;
    let n = sqlx::query(
        "DELETE FROM location_access_events WHERE started_at<now()-make_interval(days=>$1::int)",
    )
    .bind(days as i32)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let old = sqlx::query(
        "DELETE FROM location_access_log WHERE bucket<now()-make_interval(days=>$1::int)",
    )
    .bind(days as i32)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    // Coverage is non-subject metadata and referenced by events; keep it until its policy is settled.
    tx.commit().await?;
    Ok(n + old)
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
    Public,
    AdminUnattributed,
}
/// (verb, route as registered, method recorded, whose it is)
struct Rule(&'static str, &'static str, &'static str, Of);

/// Every route that hands out stored location or something derived from it. A route that is not
/// here is not recorded: adding a reader means adding its line and raising `SCOPE_VERSION`.
const RULES: &[Rule] = &[
    Rule(
        "PATCH",
        "/corporate/devices/:id/trips/annotation",
        "trips",
        Of::Device,
    ),
    Rule("GET", "/devices/:id/audit", "file", Of::Device),
    Rule("GET", "/devices/:id/car-image", "file", Of::Device),
    Rule("GET", "/devices/pairing-options", "position", Of::Account),
    Rule("GET", "/devices/scan", "position", Of::Account),
    Rule(
        "GET",
        "/corporate/vehicles/:id/documents",
        "file",
        Of::Company,
    ),
    Rule("GET", "/devices/:id/documents", "file", Of::Account),
    Rule("GET", "/documents/:id/download", "file", Of::Account),
    Rule("GET", "/documents/:id/preview", "file", Of::Account),
    Rule(
        "GET",
        "/corporate/expenses/:id/receipts/:receipt",
        "file",
        Of::Company,
    ),
    Rule("GET", "/corporate/vehicles/:id/photo", "file", Of::Company),
    Rule("POST", "/corporate/sites", "events", Of::Company),
    Rule("PUT", "/corporate/sites/:id", "events", Of::Company),
    Rule(
        "GET",
        "/corporate/vehicles/:id/trip-rules",
        "trips",
        Of::Vehicle,
    ),
    Rule(
        "GET",
        "/corporate/vehicles/:id/trips/assignment-history",
        "trips",
        Of::Vehicle,
    ),
    Rule(
        "POST",
        "/corporate/vehicles/:id/trip-rules",
        "trips",
        Of::Vehicle,
    ),
    Rule(
        "PUT",
        "/corporate/vehicles/:id/trip-rules/:rule",
        "trips",
        Of::Vehicle,
    ),
    Rule(
        "POST",
        "/corporate/vehicles/:id/trips/corrections/:correction/restore",
        "trips",
        Of::Vehicle,
    ),
    Rule(
        "PATCH",
        "/corporate/vehicles/:id/trips/annotation",
        "trips",
        Of::Vehicle,
    ),
    Rule("GET", "/geofences", "events", Of::Account),
    Rule("GET", "/geofences/:id", "events", Of::Account),
    Rule("PATCH", "/geofences/:id", "events", Of::Account),
    Rule("POST", "/geofences", "events", Of::Account),
    Rule(
        "GET",
        "/gps-tracker/diagnostic/device/data",
        "track",
        Of::Public,
    ),
    Rule(
        "POST",
        "/admin/privacy/company-tasks/:id/proof/:sid",
        "file",
        Of::AdminUnattributed,
    ),
    Rule(
        "POST",
        "/privacy/company-tasks/:id/proof/:sid",
        "file",
        Of::Account,
    ),
    Rule("POST", "/privacy/result", "file", Of::Account),
    Rule(
        "POST",
        "/admin/privacy/requests/:id/image-preview",
        "file",
        Of::AdminRequest,
    ),
    Rule(
        "POST",
        "/admin/privacy/requests/:id/receipt-sources/:review/:receipt",
        "file",
        Of::AdminRequest,
    ),
    Rule("POST", "/privacy/images/:id/download", "file", Of::Account),
    Rule(
        "POST",
        "/admin/privacy/requests/:id/documents/:document/review",
        "file",
        Of::AdminRequest,
    ),
    Rule(
        "POST",
        "/privacy/account-packages/:id/account",
        "file",
        Of::Account,
    ),
    Rule(
        "POST",
        "/privacy/account-packages/:id/documents/:document",
        "file",
        Of::Account,
    ),
    Rule("GET", "/rentcar/contracts/:id/photos", "file", Of::Account),
    Rule("GET", "/rentcar/handoff/:token", "file", Of::Public),
    Rule("GET", "/rentcar/photos/:id", "file", Of::Account),
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
        Of::Public => (Target::Unattributed, Recipient::ShareLink),
        Of::AdminUnattributed => (Target::Unattributed, Recipient::Admin(caller?)),
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
                Of::Device => Target::ScopedDevice {
                    account: owner?,
                    device: id?,
                },
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
        route: rule.1,
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
    if !enabled() && !super::privacy_lifecycle::active() {
        return next.run(request).await;
    }
    // Fail closed for a newly registered but unclassified route, even before release CI runs.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str())
        .unwrap_or("");
    let route = route.strip_prefix(PREFIX).unwrap_or(route);
    let verb = if request.method() == axum::http::Method::HEAD {
        "GET"
    } else {
        request.method().as_str()
    };
    if !classified(verb, route) {
        return unavailable();
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
                verb,
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
    let ticket = match planned {
        Some(access) => match begin(access).await {
            Ok(ticket) => Some(ticket),
            Err(e) if e.to_string() == "location processing paused" => return (axum::http::StatusCode::LOCKED, axum::Json(serde_json::json!({"error":"위치정보 이용 또는 제공이 중지되어 있습니다. 내 정보에서 설정을 확인하세요."}))).into_response(),
            Err(_) => return unavailable(),
        },
        None => None,
    };
    let response = if ticket.is_some() {
        super::privacy_lifecycle::inside(next.run(request)).await
    } else {
        next.run(request).await
    };
    if let Some(ticket) = ticket {
        let outcome = if response.status().is_success() {
            "response_ready"
        } else {
            "denied"
        };
        if ticket.finish(outcome).await.is_err() {
            return unavailable();
        }
    }
    response
}

fn classified(verb: &str, route: &str) -> bool {
    static MANIFEST: OnceLock<serde_json::Value> = OnceLock::new();
    let manifest = MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../location-access-routes.json"))
            .expect("reviewed route manifest")
    });
    let suffix = format!(" {verb} {route}");
    manifest
        .as_object()
        .is_some_and(|m| m.keys().any(|k| k.ends_with(&suffix)))
}

pub async fn outer_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if request.uri().path().starts_with(PREFIX)
        || request.uri().path().starts_with("/gps-tracker/ws/")
    {
        next.run(request).await
    } else {
        middleware(State(state), request, next).await
    }
}

fn unavailable() -> Response {
    (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(serde_json::json!({"error":"기록 저장을 확인할 수 없어 요청을 중단했습니다. 잠시 후 다시 시도해 주세요."}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreviewed_route_is_denied() {
        assert!(classified("GET", "/devices/:id/locations"));
        assert!(!classified("GET", "/devices/:id/new-location-export"));
        assert!(!classified("POST", "/devices/:id/locations"));
    }

    #[tokio::test]
    #[ignore = "requires disposable internal Docker DB; run via ops/18B verification"]
    async fn external_intents_commit_before_mock_network_and_distinguish_outcomes() {
        let url = std::env::var("LEDGER_TEST_DATABASE_URL").expect("isolated DB required");
        assert!(url.contains("closure-test-only@") && url.ends_with("/gps_closure_test"));
        let pool = PgPool::connect(&url).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT current_database()")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "gps_closure_test"
        );
        std::env::set_var("GPS_LOCATION_ACCESS_LOG", "on");
        start(pool.clone()).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let seen = observed.clone();
        let db = pool.clone();
        let app=axum::Router::new().route("/",axum::routing::post(move || {
            let db=db.clone();let seen=seen.clone();
            async move {
                let count:i64=sqlx::query_scalar("SELECT count(*) FROM location_access_events WHERE recipient_name='mock18b' AND coverage_id=$1 AND outcome='prepared'")
                    .bind(HANDLE.get().unwrap().coverage).fetch_one(&db).await.unwrap();
                assert!(count>0,"network reached without committed intent");
                seen.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
                axum::http::StatusCode::NO_CONTENT
            }
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        let ticket = about(Target::Account(-1801), sent_to("mock18b", "geocode"))
            .await
            .unwrap();
        external_response(
            ticket,
            client.post(format!("http://{address}/")).send().await,
        )
        .await
        .unwrap();
        let ticket = sent_to("mock18b", "geocode").await.unwrap();
        external_response(
            ticket,
            client
                .post(format!("http://{address}/missing"))
                .send()
                .await,
        )
        .await
        .unwrap();
        server.abort();
        let _ = server.await;
        let ticket = sent_to("mock18b", "geocode").await.unwrap();
        assert!(external_response(
            ticket,
            client.post(format!("http://{address}/")).send().await
        )
        .await
        .is_err());
        let states: Vec<String> = sqlx::query_scalar(
            "SELECT outcome FROM location_access_events WHERE recipient_name='mock18b' AND coverage_id=$1 ORDER BY id",
        )
        .bind(HANDLE.get().unwrap().coverage)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            states,
            vec!["http_accepted", "http_rejected", "transport_unknown"]
        );
        assert_eq!(observed.load(std::sync::atomic::Ordering::SeqCst), 1);
        close().await;
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn every_recorded_route_is_registered_and_uses_a_stored_value() {
        // A renamed or removed route must not silently stop being recorded.
        let routes = include_str!("../../location-access-routes.json");
        let table = include_str!("../../migrations/0100_location_access_log.sql");
        for (index, rule) in RULES.iter().enumerate() {
            assert!(
                routes.contains(&format!(" {}\"", rule.1)),
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
            (
                Target::ScopedDevice {
                    account: 3,
                    device: 7
                },
                Recipient::Own(3),
                "api",
                "track"
            )
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
}
