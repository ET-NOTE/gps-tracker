//! Bounded delivery: shared DB pacing/cooldown survives process restarts.
//! Acceptance is not handset delivery. Evidence is never batched away.
use super::fcm::{Delivery, FcmClient};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};

pub const HEALTH_SQL: &str = include_str!("../../sql/subject_queue_health.sql");
const SEND_DEADLINE: Duration = Duration::from_secs(50);

pub(super) enum Tick {
    Worked,
    Throttled,
    Idle,
    Paused,
}
impl Tick {
    pub(super) fn delay_ms(&self) -> u64 {
        match self {
            Self::Worked => 100,
            Self::Throttled => 25,
            Self::Idle => 1000,
            Self::Paused => 5000,
        }
    }
}

fn workers(value: Option<&str>) -> anyhow::Result<usize> {
    let n = value.unwrap_or("4").parse::<usize>()?;
    anyhow::ensure!((1..=4).contains(&n), "notice workers must be 1..4");
    Ok(n)
}
pub fn start(pool: PgPool, client: Option<Arc<FcmClient>>) -> anyhow::Result<()> {
    let n = workers(std::env::var("GPS_NOTICE_WORKERS").ok().as_deref())?;
    for _ in 0..n {
        let (pool, client) = (pool.clone(), client.clone());
        tokio::spawn(async move {
            loop {
                let result = work(&pool, client.as_deref()).await;
                // Errors retain the lease for recovery; diagnostics never print tokens or rows.
                let delay = match result {
                    Ok(state) => state.delay_ms(),
                    Err(_) => 1000,
                };
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
        });
    }
    tokio::spawn(async move {
        let mut alarm = Alarm::default();
        loop {
            let result = maintenance(&pool, client.is_some()).await;
            let health = if result.is_ok() {
                health(&pool, true).await.ok()
            } else {
                None
            };
            let codes = health
                .as_ref()
                .map(|v| v["alerts"].to_string())
                .unwrap_or_else(|| "[\"monitor_failed\"]".into());
            if alarm.emit(&codes, std::time::Instant::now()) {
                if codes == "[]" {
                    tracing::info!(event = "subject_queue_recovered", "notice queue healthy");
                } else {
                    tracing::warn!(event="subject_queue_alert", alerts=%codes, "notice queue requires attention");
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    Ok(())
}
#[derive(Default)]
struct Alarm {
    last: String,
    at: Option<std::time::Instant>,
}
impl Alarm {
    fn emit(&mut self, codes: &str, now: std::time::Instant) -> bool {
        let emit = self.last != codes
            || (codes != "[]"
                && self
                    .at
                    .is_none_or(|at| now.duration_since(at) >= Duration::from_secs(900)));
        if emit {
            self.last = codes.into();
            self.at = Some(now);
        }
        emit
    }
}
pub async fn health(pool: &PgPool, expected_running: bool) -> anyhow::Result<Value> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='2s'")
        .execute(&mut *tx)
        .await?;
    let result = sqlx::query_scalar(HEALTH_SQL)
        .bind(expected_running)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(result)
}
pub(super) async fn maintenance(pool: &PgPool, configured: bool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL lock_timeout='1s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE location_notice_worker SET provider_configured=$1 WHERE singleton")
        .bind(configured)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE location_provision_notices n SET delivery='pending',outcome='delivery_unknown' WHERE delivery='waiting' AND started_at<now()-interval '15 minutes' AND NOT EXISTS(SELECT 1 FROM location_access_events e JOIN location_access_coverage c ON c.id=e.coverage_id WHERE e.id=n.event_id AND c.stopped_at IS NULL AND c.alive_at>now()-interval '15 minutes')").execute(&mut *tx).await?;
    sqlx::query("UPDATE location_provision_notices SET delivery='review',lease_id=NULL,lease_until=NULL,last_error='attempt_limit_delivery_unknown' WHERE delivery='pending' AND attempts>=10 AND (lease_until IS NULL OR lease_until<now())").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
#[cfg(test)]
pub(super) async fn tick(pool: &PgPool, client: Option<&FcmClient>) -> anyhow::Result<bool> {
    Ok(matches!(work(pool, client).await?, Tick::Worked))
}
pub(super) async fn work(pool: &PgPool, client: Option<&FcmClient>) -> anyhow::Result<Tick> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL lock_timeout='1s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE location_notice_worker SET seen_at=clock_timestamp() WHERE singleton AND (seen_at IS NULL OR seen_at<now()-interval '5 seconds')").execute(&mut *tx).await?;
    let push: bool = sqlx::query_scalar(
        "SELECT enabled AND push_enabled FROM location_subject_policy WHERE singleton",
    )
    .fetch_one(&mut *tx)
    .await?;
    let Some(client) = client.filter(|_| push) else {
        tx.commit().await?;
        return Ok(Tick::Paused);
    };
    // One global start per 100 ms, even when multiple API processes run. No bursts after idle.
    let permit = sqlx::query("UPDATE location_notice_worker SET next_dispatch_at=clock_timestamp()+interval '100 milliseconds' WHERE singleton AND next_dispatch_at<=clock_timestamp() AND cooldown_until<=clock_timestamp()").execute(&mut *tx).await?.rows_affected();
    if permit == 0 {
        let cooling: bool = sqlx::query_scalar(
            "SELECT cooldown_until>clock_timestamp() FROM location_notice_worker WHERE singleton",
        )
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(if cooling { Tick::Idle } else { Tick::Throttled });
    }
    let lease = uuid::Uuid::new_v4();
    let row: Option<(i64,i64,i32)> = sqlx::query_as("WITH chosen AS (SELECT id FROM location_provision_notices WHERE delivery='pending' AND attempts<10 AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE location_provision_notices n SET lease_id=$1::text::uuid,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 FROM chosen WHERE n.id=chosen.id RETURNING n.id,n.subject_id,n.attempts")
        .bind(lease.to_string()).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    let Some((id, subject, attempt)) = row else {
        return Ok(Tick::Idle);
    };
    // Deadline includes DB/policy/token locks, OAuth and HTTP. Expired leases cannot
    // overlap an in-flight send: dispatch holds the notice row until network completion.
    let outcome =
        match tokio::time::timeout(SEND_DEADLINE, dispatch(pool, client, id, subject, lease)).await
        {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => Delivery::Retry(60, "dispatch_unavailable".into()),
            Err(_) => Delivery::Retry(60, "dispatch_timeout_unknown".into()),
        };
    settle(pool, id, lease, attempt, outcome).await?;
    Ok(Tick::Worked)
}
async fn dispatch(
    pool: &PgPool,
    client: &FcmClient,
    id: i64,
    subject: i64,
    lease: uuid::Uuid,
) -> anyhow::Result<Delivery> {
    let mut auth = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *auth)
        .await?;
    sqlx::query("SET LOCAL lock_timeout='1s'")
        .execute(&mut *auth)
        .await?;
    let ours:Option<i64>=sqlx::query_scalar("SELECT id FROM location_provision_notices WHERE id=$1 AND lease_id=$2::text::uuid AND delivery='pending' AND lease_until>clock_timestamp() FOR UPDATE")
        .bind(id).bind(lease.to_string()).fetch_optional(&mut *auth).await?;
    anyhow::ensure!(ours.is_some(), "notice lease lost");
    let push: bool = sqlx::query_scalar(
        "SELECT enabled AND push_enabled FROM location_subject_policy WHERE singleton FOR SHARE",
    )
    .fetch_one(&mut *auth)
    .await?;
    let outcome = if !push {
        Delivery::Retry(60, "policy_disabled".into())
    } else {
        let token:Option<String>=sqlx::query_scalar("SELECT t.token FROM fcm_tokens t JOIN privacy_account_controls c ON c.user_id=t.user_id WHERE t.user_id=$1 AND t.active AND NOT c.restricted ORDER BY t.id DESC LIMIT 1 FOR SHARE OF t,c")
            .bind(subject).fetch_optional(&mut *auth).await?;
        match token {
            None=>Delivery::Retry(300,"no_active_recipient".into()),
            Some(token)=>match client.access_token().await {
                Ok(access)=>client.send_to_token(&access,&token,json!({"notification":{"title":"위치정보 제공 내역 안내","body":"내 정보에서 제공 내역과 처리 상태를 확인해 주세요."},"data":{"type":"location_provision_notice","notice_id":id.to_string()},"android":{"priority":"high","ttl":"3600s","notification":{"tag":format!("provision-{id}")}}}),super::access_ledger::Ticket::off()).await,
                Err(_)=>Delivery::Retry(60,"authentication_unavailable".into())
            }
        }
    };
    auth.commit().await?;
    Ok(outcome)
}
pub(super) async fn settle(
    pool: &PgPool,
    id: i64,
    lease: uuid::Uuid,
    attempt: i32,
    outcome: Delivery,
) -> anyhow::Result<()> {
    let cooldown = match &outcome {
        Delivery::Retry(s, e)
            if e.starts_with("http_")
                || matches!(
                    e.as_str(),
                    "transport" | "authentication_unavailable" | "dispatch_timeout_unknown"
                ) =>
        {
            (*s).clamp(60, 86400)
        }
        _ => 0,
    };
    let (state, delay, error) = match outcome {
        Delivery::Sent => ("provider_accepted", 0, "accepted".to_owned()),
        Delivery::Retry(min, err) if attempt < 10 => (
            "pending",
            (60_i64 * 2_i64.pow(attempt.clamp(0, 8) as u32))
                .max(min.min(86400) as i64)
                .min(86400),
            err,
        ),
        Delivery::Unregistered => ("review", 0, "unregistered".to_owned()),
        Delivery::Retry(_, err) | Delivery::Permanent(err) => ("review", 0, err),
    };
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    // Same lock order as claim (worker -> notice), avoiding a rate-slot/settlement deadlock.
    if cooldown > 0 {
        sqlx::query("UPDATE location_notice_worker SET cooldown_until=GREATEST(cooldown_until,clock_timestamp()+$1*interval '1 second') WHERE singleton").bind(cooldown as i64).execute(&mut *tx).await?;
    }
    let n=sqlx::query("UPDATE location_provision_notices SET delivery=$3,available_at=clock_timestamp()+$4*interval '1 second',lease_until=NULL,lease_id=NULL,last_error=$5,provider_accepted_at=CASE WHEN $3='provider_accepted' THEN clock_timestamp() ELSE provider_accepted_at END WHERE id=$1 AND lease_id=$2::text::uuid AND delivery='pending'")
        .bind(id).bind(lease.to_string()).bind(state).bind(delay).bind(&error).execute(&mut *tx).await?.rows_affected();
    if n == 1 {
        sqlx::query("INSERT INTO location_notice_attempts(notice_id,lease_id,attempt,result) VALUES($1,$2::text::uuid,$3,$4)").bind(id).bind(lease.to_string()).bind(attempt).bind(error).execute(&mut *tx).await?;
    }
    // A stale completion must not create attempts OR impose cooldown on another lease.
    if n == 0 {
        tx.rollback().await?;
    } else {
        tx.commit().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_workers_and_alarm_edges() {
        assert_eq!(workers(None).unwrap(), 4);
        for bad in ["0", "5", "100", "abc"] {
            assert!(workers(Some(bad)).is_err());
        }
        let mut a = Alarm::default();
        let now = std::time::Instant::now();
        assert!(a.emit("[]", now));
        assert!(!a.emit("[]", now));
        assert!(a.emit("[\"backlog\"]", now));
        assert!(!a.emit("[\"backlog\"]", now + Duration::from_secs(899)));
        assert!(a.emit("[\"backlog\"]", now + Duration::from_secs(900)));
        assert!(a.emit("[]", now + Duration::from_secs(901)));
    }
}
