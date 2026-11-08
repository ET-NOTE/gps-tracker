//! Subject declarations are not inferred from SIM ownership, reservations or trip rules.
//! Pilot: company provision only. Unbounded/unclassified company reads fail closed.
use super::access_ledger::{Access, Recipient};
use chrono::{DateTime, Utc};
#[cfg(test)]
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::{Arc, OnceLock};

static ENABLED: OnceLock<bool> = OnceLock::new();
pub fn enabled() -> bool {
    ENABLED.get().copied().unwrap_or(false)
}
pub async fn start(pool: PgPool, client: Option<Arc<super::fcm::FcmClient>>) -> anyhow::Result<()> {
    let on = std::env::var("GPS_SUBJECT_PROVISION").as_deref() == Ok("on");
    if on {
        anyhow::ensure!(
            super::access_ledger::enabled(),
            "subject provision requires durable ledger"
        );
        let reviewed: bool =
            sqlx::query_scalar("SELECT enabled FROM location_subject_policy WHERE singleton")
                .fetch_one(&pool)
                .await?;
        anyhow::ensure!(reviewed, "subject provision policy not enabled by owner");
    }
    ENABLED
        .set(on)
        .map_err(|_| anyhow::anyhow!("subject provision already started"))?;
    if on {
        super::subject_queue::start(pool, client)?;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Mapping {
    id: i64,
    subject_id: i64,
    vehicle_id: i64,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    blocked: bool,
}
/// Called in the ledger transaction, before the handler or any outgoing transport.
pub async fn prepare(
    tx: &mut Transaction<'_, Postgres>,
    a: &Access,
    event: i64,
    owner: Option<i64>,
    device: Option<i64>,
    vehicle: Option<i64>,
) -> anyhow::Result<()> {
    if !enabled() || a.route.contains("/privacy/") {
        return Ok(());
    }
    let company =
        a.route.starts_with("/corporate/") || matches!(a.recipient, Recipient::Company(_));
    let known: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM location_subject_mappings WHERE ($1::bigint IS NULL OR owner_id=$1) AND ($2::bigint IS NULL OR device_id=$2) AND ($3::bigint IS NULL OR vehicle_id=$3))")
        .bind(owner).bind(device).bind(vehicle).fetch_one(&mut **tx).await?;
    if matches!(a.recipient, Recipient::ShareLink | Recipient::Processor(_)) {
        // Company consent names the company, not a public-link visitor or processor.
        // Even an unmapped company SIM must not fall back to personal sharing.
        let fleet:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_vehicle_bindings WHERE ($1::bigint IS NULL OR owner_id=$1) AND ($2::bigint IS NULL OR device_id=$2) AND ($3::bigint IS NULL OR vehicle_id=$3))")
            .bind(owner).bind(device).bind(vehicle).fetch_one(&mut **tx).await?;
        let device_known: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM location_subject_mappings WHERE device_id=$1)",
        )
        .bind(device)
        .fetch_one(&mut **tx)
        .await?;
        anyhow::ensure!(
            owner.is_some() && !known && !device_known && !fleet,
            "company subject consent does not authorize external provision"
        );
    }
    if !company && !known {
        return Ok(());
    }
    anyhow::ensure!(
        matches!(
            a.route,
            "/devices/:id/locations/page" | "/corporate/subject-mappings/:id/locations"
        ),
        "route requires bounded subject reader"
    );
    let owner = owner.ok_or_else(|| anyhow::anyhow!("subject scope unresolved"))?;
    let actor = match a.recipient {
        Recipient::Own(id) | Recipient::Company(id) => id,
        _ => anyhow::bail!("recipient classification requires review"),
    };
    let (from, until) = a
        .range
        .ok_or_else(|| anyhow::anyhow!("bounded subject period required"))?;
    anyhow::ensure!(
        from < until && until - from <= chrono::Duration::days(31),
        "subject period too wide"
    );
    let policy: Option<String> = sqlx::query_scalar(
        "SELECT reference FROM location_subject_policy WHERE singleton AND enabled",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let policy = policy.ok_or_else(|| anyhow::anyhow!("subject policy disabled"))?;
    // Do not let owner/delegated identifiers alone grant access before a handler checks them.
    let actor_valid: bool = sqlx::query_scalar("SELECT $1=$2 OR EXISTS(SELECT 1 FROM fleet_staff_accounts a JOIN staff s ON s.id=a.staff_id AND s.user_id=a.owner_id WHERE a.owner_id=$1 AND a.account_id=$2 AND s.active)")
        .bind(owner).bind(actor).fetch_one(&mut **tx).await?;
    anyhow::ensure!(actor_valid, "recipient not in company");
    let devices: Vec<i64> = sqlx::query_scalar("SELECT DISTINCT device_id FROM fleet_vehicle_bindings WHERE owner_id=$1 AND device_id IS NOT NULL AND ($2::bigint IS NULL OR device_id=$2) AND ($3::bigint IS NULL OR vehicle_id=$3) AND started_at<$5 AND (ended_at IS NULL OR ended_at>$4) ORDER BY device_id")
        .bind(owner).bind(device).bind(vehicle).bind(from).bind(until).fetch_all(&mut **tx).await?;
    anyhow::ensure!(!devices.is_empty(), "subject binding unresolved");
    for did in devices {
        let rows: Vec<Mapping> = sqlx::query_as("SELECT m.id,m.subject_id,m.vehicle_id,m.starts_at,m.ends_at,COALESCE(c.use_paused,false) OR (m.subject_id<>$5 AND COALESCE(c.provision_paused,false)) OR COALESCE(p.restricted,true) AS blocked FROM location_subject_effective m LEFT JOIN privacy_processing_controls c ON c.user_id=m.subject_id LEFT JOIN privacy_account_controls p ON p.user_id=m.subject_id WHERE m.owner_id=$1 AND m.device_id=$2 AND m.status='confirmed' AND m.starts_at<$4 AND m.ends_at>$3 AND ($6::bigint IS NULL OR m.vehicle_id=$6) AND EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.id=m.binding_id AND b.owner_id=m.owner_id AND b.vehicle_id=m.vehicle_id AND b.device_id=m.device_id AND b.started_at<=GREATEST(m.starts_at,$3) AND (b.ended_at IS NULL OR b.ended_at>=LEAST(m.ends_at,$4))) ORDER BY m.starts_at")
            .bind(owner).bind(did).bind(from).bind(until).bind(actor).bind(vehicle).fetch_all(&mut **tx).await?;
        let spans: Vec<_> = rows.iter().map(|m| (m.starts_at, m.ends_at)).collect();
        anyhow::ensure!(
            covers(from, until, &spans),
            "subject period contains unconfirmed intervals"
        );
        for m in rows {
            anyhow::ensure!(!m.blocked, "location processing paused");
            if m.subject_id == actor {
                continue;
            }
            sqlx::query("INSERT INTO location_provision_notices(event_id,mapping_id,subject_id,owner_id,actor_id,device_id,vehicle_id,purpose,consent_version,policy_reference,range_from,range_until,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,'fleet_operations','fleet-subject-v1',$8,$9,$10,$11)")
                .bind(event).bind(m.id).bind(m.subject_id).bind(owner).bind(actor).bind(did).bind(m.vehicle_id).bind(&policy)
                .bind(from.max(m.starts_at)).bind(until.min(m.ends_at)).bind(a.at).execute(&mut **tx).await?;
        }
    }
    Ok(())
}
fn covers(
    from: DateTime<Utc>,
    until: DateTime<Utc>,
    spans: &[(DateTime<Utc>, DateTime<Utc>)],
) -> bool {
    let mut cursor = from;
    for (start, end) in spans {
        if *start > cursor {
            return false;
        }
        cursor = cursor.max(*end);
    }
    cursor >= until
}
pub async fn complete(
    tx: &mut Transaction<'_, Postgres>,
    event: i64,
    outcome: &str,
) -> anyhow::Result<()> {
    let provided = matches!(
        outcome,
        "response_ready" | "http_accepted" | "transport_unknown" | "socket_sent"
    );
    sqlx::query("UPDATE location_provision_notices SET outcome=$2,completed_at=clock_timestamp(),delivery=CASE WHEN $3 THEN CASE WHEN delivery='waiting' THEN 'pending' ELSE delivery END ELSE 'not_provided' END WHERE event_id=$1")
        .bind(event).bind(outcome).bind(provided).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
async fn tick(pool: &PgPool, client: Option<&super::fcm::FcmClient>) -> anyhow::Result<()> {
    super::subject_queue::maintenance(pool, client.is_some()).await?;
    super::subject_queue::tick(pool, client).await?;
    Ok(())
}
#[cfg(test)]
use super::subject_queue::settle;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn intervals_require_full_half_open_coverage() {
        let t = DateTime::from_timestamp(1000, 0).unwrap();
        let at = |s| t + chrono::Duration::seconds(s);
        assert!(covers(t, at(20), &[(t, at(10)), (at(10), at(20))]));
        assert!(!covers(t, at(20), &[(t, at(9)), (at(10), at(20))]));
        assert!(!covers(t, at(20), &[]));
        assert!(!covers(t, at(20), &[(at(1), at(20))]));
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    #[ignore = "requires disposable internal Docker DB and loopback mock"]
    async fn subject_notice_retry_identity_and_lease_fences() {
        let url = std::env::var("LEDGER_TEST_DATABASE_URL").unwrap();
        assert!(url.contains("closure-test-only@") && url.ends_with("/gps_closure_test"));
        let pool = PgPool::connect(&url).await.unwrap();
        let uid:i64=sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES($1,'test',gen_random_uuid()::text) RETURNING id").bind(format!("{}@example.invalid",uuid::Uuid::new_v4())).fetch_one(&pool).await.unwrap();
        sqlx::query("UPDATE location_subject_policy SET enabled=true,reference='synthetic-policy',push_enabled=true").execute(&pool).await.unwrap();
        let notice:i64=sqlx::query_scalar("INSERT INTO location_provision_notices(event_id,mapping_id,subject_id,owner_id,actor_id,device_id,vehicle_id,purpose,consent_version,policy_reference,range_from,range_until,started_at,outcome,delivery) VALUES(-1,-1,$1,$1,$1,-1,-1,'fleet_operations','fleet-subject-v1','synthetic-policy',now()-interval '1 day',now(),now(),'response_ready','pending') RETURNING id").bind(uid).fetch_one(&pool).await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let app = axum::Router::new().route(
            "/send",
            axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
                let c = c.clone();
                async move {
                    assert_eq!(body["message"]["token"], "subject-test-token");
                    assert!(body["message"]["notification"]["body"]
                        .as_str()
                        .unwrap()
                        .contains("내 정보"));
                    assert!(body["message"]["data"].get("lat").is_none());
                    if c.fetch_add(1, Ordering::SeqCst) == 0 {
                        (
                            axum::http::StatusCode::TOO_MANY_REQUESTS,
                            axum::Json(json!({"error":{}})),
                        )
                    } else {
                        (
                            axum::http::StatusCode::OK,
                            axum::Json(json!({"name":"mock"})),
                        )
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            super::super::fcm::FcmClient::subject_test_client(format!("http://{addr}/send"));
        tick(&pool, None).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        sqlx::query(
            "UPDATE location_notice_worker SET next_dispatch_at=now(),cooldown_until=now()",
        )
        .execute(&pool)
        .await
        .unwrap();
        tick(&pool, Some(&client)).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT last_error FROM location_provision_notices WHERE id=$1"
            )
            .bind(notice)
            .fetch_one(&pool)
            .await
            .unwrap(),
            "no_active_recipient"
        );
        sqlx::query("INSERT INTO fcm_tokens(user_id,token,platform,active) VALUES($1,'subject-test-token','android',true)").bind(uid).execute(&pool).await.unwrap();
        sqlx::query("UPDATE location_provision_notices SET available_at=now() WHERE id=$1")
            .bind(notice)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE location_notice_worker SET next_dispatch_at=now(),cooldown_until=now()",
        )
        .execute(&pool)
        .await
        .unwrap();
        tick(&pool, Some(&client)).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let current: uuid::Uuid = uuid::Uuid::new_v4();
        sqlx::query("UPDATE location_provision_notices SET lease_id=$2::text::uuid,lease_until=now()+interval '1 minute' WHERE id=$1").bind(notice).bind(current.to_string()).execute(&pool).await.unwrap();
        settle(
            &pool,
            notice,
            uuid::Uuid::new_v4(),
            3,
            super::super::fcm::Delivery::Sent,
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT delivery FROM location_provision_notices WHERE id=$1"
            )
            .bind(notice)
            .fetch_one(&pool)
            .await
            .unwrap(),
            "pending"
        );
        sqlx::query("UPDATE location_provision_notices SET lease_until=now()-interval '1 second',available_at=now() WHERE id=$1").bind(notice).execute(&pool).await.unwrap();
        sqlx::query(
            "UPDATE location_notice_worker SET next_dispatch_at=now(),cooldown_until=now()",
        )
        .execute(&pool)
        .await
        .unwrap();
        tick(&pool, Some(&client)).await.unwrap();
        sqlx::query(
            "UPDATE location_notice_worker SET next_dispatch_at=now(),cooldown_until=now()",
        )
        .execute(&pool)
        .await
        .unwrap();
        tick(&pool, Some(&client)).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(sqlx::query_scalar::<_,bool>("SELECT delivery='provider_accepted' AND read_at IS NULL FROM location_provision_notices WHERE id=$1").bind(notice).fetch_one(&pool).await.unwrap());
        // Retry after a permanent error is surfaced for operator/subject attention, not dropped.
        sqlx::query("UPDATE location_provision_notices SET delivery='pending',lease_id=$2::text::uuid WHERE id=$1").bind(notice).bind(current.to_string()).execute(&pool).await.unwrap();
        settle(
            &pool,
            notice,
            current,
            10,
            super::super::fcm::Delivery::Retry(60, "transport_unknown".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT delivery FROM location_provision_notices WHERE id=$1"
            )
            .bind(notice)
            .fetch_one(&pool)
            .await
            .unwrap(),
            "review"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM location_notice_attempts WHERE notice_id=$1"
            )
            .bind(notice)
            .fetch_one(&pool)
            .await
            .unwrap(),
            4
        );
        sqlx::query("UPDATE location_provision_notices SET delivery='pending',attempts=10,lease_until=now()-interval '1 second' WHERE id=$1").bind(notice).execute(&pool).await.unwrap();
        sqlx::query(
            "UPDATE location_notice_worker SET next_dispatch_at=now(),cooldown_until=now()",
        )
        .execute(&pool)
        .await
        .unwrap();
        tick(&pool, Some(&client)).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT delivery FROM location_provision_notices WHERE id=$1"
            )
            .bind(notice)
            .fetch_one(&pool)
            .await
            .unwrap(),
            "review"
        );
        sqlx::query("DELETE FROM location_notice_attempts WHERE notice_id=$1")
            .bind(notice)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM location_provision_notices WHERE id=$1")
            .bind(notice)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM fcm_tokens WHERE user_id=$1")
            .bind(uid)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE location_subject_policy SET enabled=false,push_enabled=false")
            .execute(&pool)
            .await
            .unwrap();
        server.abort();
    }
}

#[cfg(test)]
mod boundary22d {
    use super::*;
    #[tokio::test]
    #[ignore = "requires disposable internal Docker DB; run in its own process"]
    async fn external_company_boundary22d() {
        let url = std::env::var("LEDGER_TEST_DATABASE_URL").unwrap();
        assert!(url.contains("closure-test-only@") && url.ends_with("/gps_closure_test"));
        let pool = PgPool::connect(&url).await.unwrap();
        ENABLED.set(true).unwrap();
        let mut tx = pool.begin().await.unwrap();
        let owner:i64=sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES(gen_random_uuid()::text||'@example.invalid','test',gen_random_uuid()::text) RETURNING id").fetch_one(&mut *tx).await.unwrap();
        let did:i64=sqlx::query_scalar("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES($1,gen_random_uuid()::text,'') RETURNING id").bind(owner).fetch_one(&mut *tx).await.unwrap();
        let vehicle: i64 = sqlx::query_scalar(
            "INSERT INTO fleet_vehicles(owner_id,name) VALUES($1,'isolated boundary') RETURNING id",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,is_primary) VALUES($1,$2,$3,'synthetic',now()-interval '1 day',true)").bind(owner).bind(vehicle).bind(did).execute(&mut *tx).await.unwrap();
        let mut outgoing = 0;
        for recipient in [
            Recipient::Processor("openai"),
            Recipient::Processor("geocode"),
            Recipient::ShareLink,
        ] {
            let a = Access {
                at: Utc::now(),
                target: super::super::access_ledger::Target::Account(owner),
                recipient,
                path: "server",
                method: "send",
                route: "external",
                range: None,
            };
            for (o, d, v) in [
                (Some(owner), Some(did), None),
                (Some(owner), None, None),
                (None, None, None),
            ] {
                if prepare(&mut tx, &a, -1, o, d, v).await.is_ok() {
                    outgoing += 1;
                }
            }
        }
        assert_eq!(
            outgoing, 0,
            "no outgoing transport without subject authorization"
        );
        // A separate personal account still uses the existing external policy.
        let other:i64=sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES(gen_random_uuid()::text||'@example.invalid','test',gen_random_uuid()::text) RETURNING id").fetch_one(&mut *tx).await.unwrap();
        let a = Access {
            at: Utc::now(),
            target: super::super::access_ledger::Target::Account(other),
            recipient: Recipient::Processor("geocode"),
            path: "server",
            method: "send",
            route: "external",
            range: None,
        };
        assert!(prepare(&mut tx, &a, -1, Some(other), None, None)
            .await
            .is_ok());
        tx.rollback().await.unwrap();
    }
}
