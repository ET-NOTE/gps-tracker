//! Processing controls remain enforced when access recording is OFF.
//! Shared DB fence covers response preparation / external send. Changes use a
//! non-waiting exclusive fence: outstanding operations must drain before success.
use super::access_ledger::{Access, Recipient, Target};
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::OnceLock;
struct Pools {
    leases: PgPool,
    queries: PgPool,
}
static POOL: OnceLock<Pools> = OnceLock::new();
tokio::task_local! { static PARENT_LEASE: bool; }
pub async fn inside<F: std::future::Future>(work: F) -> F::Output {
    PARENT_LEASE.scope(true, work).await
}
pub const LOCK: i64 = 210571031;
pub async fn start(url: &str, queries: PgPool) -> anyhow::Result<()> {
    let leases = sqlx::postgres::PgPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await?;
    POOL.set(Pools { leases, queries })
        .map_err(|_| anyhow::anyhow!("lifecycle already started"))?;
    Ok(())
}
pub fn active() -> bool {
    POOL.get().is_some()
}
#[derive(Debug)]
pub struct Lease(#[allow(dead_code)] Option<Transaction<'static, Postgres>>);
pub async fn guard(a: &Access) -> anyhow::Result<Lease> {
    let Some(pools) = POOL.get() else {
        return Ok(Lease(None));
    };
    let inherited = PARENT_LEASE.try_with(|v| *v).unwrap_or(false);
    let mut tx = if inherited {
        pools.queries.begin().await?
    } else {
        pools.leases.begin().await?
    };
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock_shared($1)")
        .bind(LOCK)
        .fetch_one(&mut *tx)
        .await?;
    anyhow::ensure!(locked, "privacy change in progress");
    // A verified rights request is still available to the subject and reviewer.
    if a.route.contains("/privacy/")
        && matches!(a.recipient, Recipient::Own(_) | Recipient::Admin(_))
    {
        return Ok(Lease(Some(tx)));
    }
    let uid: Option<i64> = match &a.target {
        Target::Account(id) | Target::ScopedDevice { account: id, .. } => Some(*id),
        Target::Vehicle { owner, .. } => Some(*owner),
        Target::Device(id) => sqlx::query_scalar("SELECT owner_id FROM devices WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten(),
        Target::Share(token) => {
            sqlx::query_scalar("SELECT created_by FROM share_tokens WHERE token=$1")
                .bind(token)
                .fetch_optional(&mut *tx)
                .await?
                .flatten()
        }
        Target::Request(id) => {
            sqlx::query_scalar("SELECT user_id FROM privacy_requests WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
        }
        _ => None,
    };
    let providing = !matches!(a.recipient, Recipient::Own(_));
    // Company responses cannot establish a driver for every point. Hold the
    // company's response if its owner or a linked member restricted processing;
    // an unrelated company's users must not disable this company.
    let mixed = a.route.starts_with("/corporate/")
        || matches!(a.recipient, Recipient::Company(_))
        || sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE owner_id=$1)",
        )
        .bind(uid)
        .fetch_one(&mut *tx)
        .await?;
    let denied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_processing_controls WHERE (user_id=$1 OR $1::bigint IS NULL OR ($3 AND user_id IN (SELECT account_id FROM fleet_staff_accounts WHERE owner_id=$1))) AND (use_paused OR ($2 AND provision_paused)))")
        .bind(uid).bind(providing || mixed).bind(mixed).fetch_one(&mut *tx).await?;
    anyhow::ensure!(!denied, "location processing paused");
    let device = match a.target {
        Target::Device(d) | Target::ScopedDevice { device: d, .. } => Some(d),
        _ => None,
    };
    let vehicle = match a.target {
        Target::Vehicle { vehicle: v, .. } => Some(v),
        _ => None,
    };
    let historical:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM location_subject_mappings m LEFT JOIN privacy_processing_controls c ON c.user_id=m.subject_id LEFT JOIN privacy_account_controls p ON p.user_id=m.subject_id WHERE ($1::bigint IS NULL OR m.owner_id=$1) AND ($2::bigint IS NULL OR m.device_id=$2) AND ($3::bigint IS NULL OR m.vehicle_id=$3) AND ($4::timestamptz IS NULL OR m.ends_at>$4) AND ($5::timestamptz IS NULL OR m.starts_at<$5) AND m.status IN ('confirmed','revoked') AND (m.status='revoked' OR COALESCE(c.use_paused,false) OR COALESCE(c.provision_paused,false) OR COALESCE(p.restricted,true)))")
        .bind(uid).bind(device).bind(vehicle).bind(a.range.map(|r|r.0)).bind(a.range.map(|r|r.1)).fetch_one(&mut *tx).await?;
    anyhow::ensure!(!historical, "location processing paused");
    if inherited {
        tx.rollback().await?;
        Ok(Lease(None))
    } else {
        Ok(Lease(Some(tx)))
    }
}

/// Gate automatic use before reading coordinates or calculating derived results.
pub async fn background(target: Target, company: bool) -> anyhow::Result<Lease> {
    let recipient = match target {
        Target::Account(id) => Recipient::Own(id),
        _ => Recipient::Own(0),
    };
    guard(&Access {
        at: chrono::Utc::now(),
        target,
        recipient,
        path: "background",
        method: "derive",
        route: if company {
            "/corporate/background"
        } else {
            "/background"
        },
        range: None,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires disposable internal Docker DB"]
    async fn lifecycle_external_and_realtime_fences_without_ledger() {
        let url = std::env::var("LEDGER_TEST_DATABASE_URL").unwrap();
        assert!(url.contains("closure-test-only@") && url.ends_with("/gps_closure_test"));
        let pool = PgPool::connect(&url).await.unwrap();
        let uid:i64=sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES($1,'synthetic-no-login',gen_random_uuid()::text) RETURNING id")
            .bind(format!("{}@example.invalid",uuid::Uuid::new_v4())).fetch_one(&pool).await.unwrap();
        start(&url, pool.clone()).await.unwrap();
        sqlx::query(
            "INSERT INTO privacy_processing_controls(user_id,provision_paused) VALUES($1,true)",
        )
        .bind(uid)
        .execute(&pool)
        .await
        .unwrap();
        let sent = super::super::access_ledger::about(
            Target::Account(uid),
            super::super::access_ledger::sent_to("mock21", "geocode"),
        )
        .await;
        assert!(sent.is_err()); // No outbound request can be made without a ticket.
        let a = Access {
            at: chrono::Utc::now(),
            target: Target::Account(uid),
            recipient: Recipient::Own(uid),
            path: "realtime",
            method: "position",
            route: "/realtime",
            range: None,
        };
        let lease = guard(&a).await.unwrap();
        let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
            .bind(LOCK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!locked);
        // Reentrant processors cannot bypass provision pause within a self read.
        assert!(inside(super::super::access_ledger::about(
            Target::Account(uid),
            super::super::access_ledger::sent_to("mock21", "geocode")
        ))
        .await
        .is_err());
        drop(lease);
        sqlx::query("UPDATE privacy_processing_controls SET use_paused=true WHERE user_id=$1")
            .bind(uid)
            .execute(&pool)
            .await
            .unwrap();
        assert!(guard(&a).await.is_err());
        let company:i64=sqlx::query_scalar("INSERT INTO users(email,password_hash,phone) VALUES($1,'synthetic-no-login',gen_random_uuid()::text) RETURNING id")
            .bind(format!("{}@example.invalid",uuid::Uuid::new_v4())).fetch_one(&pool).await.unwrap();
        let company_access = Access {
            at: chrono::Utc::now(),
            target: Target::Account(company),
            recipient: Recipient::Own(company),
            path: "api",
            method: "positions",
            route: "/corporate/vehicles",
            range: None,
        };
        assert!(guard(&company_access).await.is_ok()); // unrelated paused account cannot deny another company
        let staff: i64 = sqlx::query_scalar(
            "INSERT INTO staff(user_id,name) VALUES($1,'Synthetic member') RETURNING id",
        )
        .bind(company)
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES($1,$2,$3)",
        )
        .bind(company)
        .bind(staff)
        .bind(uid)
        .execute(&pool)
        .await
        .unwrap();
        assert!(guard(&company_access).await.is_err()); // mixed response of this member's company is held

        sqlx::query("UPDATE privacy_processing_controls SET use_paused=false,provision_paused=false WHERE user_id=$1").bind(uid).execute(&pool).await.unwrap();
        let ticket = super::super::access_ledger::about(
            Target::Account(uid),
            super::super::access_ledger::sent_to("mock21", "geocode"),
        )
        .await
        .unwrap();
        ticket.finish("http_accepted").await.unwrap();
    }
}
