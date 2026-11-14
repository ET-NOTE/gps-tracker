//! Bound expensive location reads before they occupy the shared query pool.
//! A short, bounded wait keeps ingest/health capacity available under overload.
//! This is per API process, not a distributed rate limit or a plaintext cache.
use crate::error::{AppError, AppResult};
use sqlx::{
    pool::PoolConnection, postgres::PgPoolOptions, Connection, PgConnection, PgPool, Postgres,
};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::{Semaphore, SemaphorePermit};

struct ReadBudget {
    total: Semaphore,
    history: Semaphore,
    regular_waiters: Semaphore,
    history_waiters: Semaphore,
    wait: Duration,
}

struct ReadPermits<'a> {
    _total: SemaphorePermit<'a>,
    _history: Option<SemaphorePermit<'a>>,
}

async fn wait_for(
    semaphore: &Semaphore,
    deadline: tokio::time::Instant,
) -> AppResult<SemaphorePermit<'_>> {
    tokio::time::timeout_at(deadline, semaphore.acquire())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or(AppError::LocationReadBusy)
}

impl ReadBudget {
    const fn new(wait: Duration) -> Self {
        Self {
            total: Semaphore::const_new(2),
            history: Semaphore::const_new(1),
            regular_waiters: Semaphore::const_new(8),
            history_waiters: Semaphore::const_new(4),
            wait,
        }
    }

    async fn acquire(&self, history: bool) -> AppResult<ReadPermits<'_>> {
        // Separate bounded queues: a flood of full-history requests cannot use
        // every waiting position for interactive reads. No DB connection yet.
        let queue = if history {
            &self.history_waiters
        } else {
            &self.regular_waiters
        };
        let _waiting = queue
            .try_acquire()
            .map_err(|_| AppError::LocationReadBusy)?;
        let deadline = tokio::time::Instant::now() + self.wait;
        // Never hold a global slot while waiting for another long history.
        let history_permit = if history {
            Some(wait_for(&self.history, deadline).await?)
        } else {
            None
        };
        let total = wait_for(&self.total, deadline).await?;
        Ok(ReadPermits {
            _total: total,
            _history: history_permit,
        })
    }
}

// Longer queues reduce 429 counts by hiding overload as latency. Preserve the
// short retry contract while isolating history from the other execution slot.
static READS: ReadBudget = ReadBudget::new(Duration::from_millis(250));

// A separate, bounded pool can cancel even when every regular connection is busy.
// It uses the same unprivileged DB role, never a superuser or pg_signal_backend.
static CANCEL_POOL: OnceLock<PgPool> = OnceLock::new();

// Opt-in numeric diagnostics (RUST_LOG=gps_read_timing=debug). Never record
// identities, SQL, parameters, coordinates, connection strings or URLs.
struct ReadTiming {
    class: &'static str,
    phase: &'static str,
    since: tokio::time::Instant,
    admission_ms: f64,
    pool_ms: f64,
    setup_ms: f64,
    scope_ms: f64,
    outcome: &'static str,
}

impl ReadTiming {
    fn new(history: bool) -> Self {
        Self {
            class: if history { "history" } else { "regular" },
            phase: "admission",
            since: tokio::time::Instant::now(),
            admission_ms: 0.0,
            pool_ms: 0.0,
            setup_ms: 0.0,
            scope_ms: 0.0,
            outcome: "unfinished",
        }
    }

    fn advance(&mut self, phase: &'static str) {
        let elapsed = self.since.elapsed().as_secs_f64() * 1000.0;
        match self.phase {
            "admission" => self.admission_ms += elapsed,
            "pool" => self.pool_ms += elapsed,
            "setup" => self.setup_ms += elapsed,
            "scope" => self.scope_ms += elapsed,
            _ => {}
        }
        self.phase = phase;
        self.since = tokio::time::Instant::now();
    }
}

impl Drop for ReadTiming {
    fn drop(&mut self) {
        let last_phase = self.phase;
        self.advance("done");
        // Scope includes SQL/decryption, result transfer and work while the
        // connection is held. It is NOT a pure database execution timer.
        tracing::debug!(target: "gps_read_timing", class=self.class, outcome=self.outcome,
            last_phase, admission_ms=self.admission_ms, pool_ms=self.pool_ms,
            setup_ms=self.setup_ms, scope_ms=self.scope_ms, "location read phases");
    }
}

pub struct ReadQuery {
    connection: Option<PoolConnection<Postgres>>,
    permit: Option<ReadPermits<'static>>,
    cancel_pool: PgPool,
    backend: Option<i32>,
    marker: String,
    timing: ReadTiming,
}

impl ReadQuery {
    pub async fn start(pool: &PgPool) -> AppResult<Self> {
        Self::start_class(pool, false).await
    }

    pub async fn start_history(pool: &PgPool) -> AppResult<Self> {
        Self::start_class(pool, true).await
    }

    async fn start_class(pool: &PgPool, history: bool) -> AppResult<Self> {
        let mut timing = ReadTiming::new(history);
        let permit = READS.acquire(history).await.inspect_err(|_| {
            timing.outcome = "busy";
        })?;
        timing.advance("pool");
        let cancel_pool = CANCEL_POOL
            .get_or_init(|| {
                PgPoolOptions::new()
                    .max_connections(2)
                    .min_connections(0)
                    .acquire_timeout(Duration::from_secs(1))
                    .connect_lazy_with(
                        (*pool.connect_options())
                            .clone()
                            .application_name("gps-location-cancel")
                            .options([("statement_timeout", "2000")]),
                    )
            })
            .clone();
        let connection = pool.acquire().await?;
        timing.advance("setup");
        let mut read = Self {
            connection: Some(connection),
            permit: Some(permit),
            cancel_pool,
            backend: None,
            marker: format!("gps-read-{}", uuid::Uuid::new_v4()),
            timing,
        };
        // Set the independent DB deadline before doing expensive work. Transaction
        // local settings cannot escape into the next request on this connection.
        sqlx::query("BEGIN READ ONLY")
            .execute(read.connection())
            .await?;
        sqlx::query("SET LOCAL statement_timeout = '20s'")
            .execute(read.connection())
            .await?;
        // Parameter-sensitive encrypted range queries can get an expensive
        // generic plan. Replan only these reads with their actual SIM/range;
        // do not change the pool default or other services on the shared DB.
        sqlx::query("SET LOCAL plan_cache_mode = 'force_custom_plan'")
            .execute(read.connection())
            .await?;
        let marker = read.marker.clone();
        let pid: i32 = sqlx::query_scalar(
            "SELECT pg_backend_pid() FROM set_config('application_name',$1,true)",
        )
        .bind(marker)
        .fetch_one(read.connection())
        .await?;
        read.backend = Some(pid);
        read.timing.advance("scope");
        Ok(read)
    }

    pub fn connection(&mut self) -> &mut PgConnection {
        self.connection.as_mut().expect("unfinished read")
    }

    pub async fn finish(mut self) -> AppResult<()> {
        sqlx::query("COMMIT").execute(self.connection()).await?;
        // Completed reads can safely reuse the normal pool connection.
        self.connection.take();
        self.timing.outcome = "completed";
        Ok(())
    }
}

impl Drop for ReadQuery {
    fn drop(&mut self) {
        let Some(mut connection) = self.connection.take() else {
            return;
        };
        // Never return an interrupted protocol/transaction to the pool. Keep the
        // pool connection AND admission slot until cancellation/close completes.
        connection.close_on_drop();
        let permit = self.permit.take();
        let pool = self.cancel_pool.clone();
        let pid = self.backend;
        let marker = self.marker.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let fallback_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
                let mut cancel_unavailable = false;
                if let Some(pid) = pid {
                    // Unique marker plus the retained connection prevent PID reuse
                    // or a late cancellation hitting a subsequent query.
                    let result = tokio::time::timeout(
                        Duration::from_secs(3),
                        sqlx::query_scalar::<_, bool>(
                            "SELECT pg_cancel_backend(pid) FROM pg_stat_activity \
                             WHERE pid=$1 AND application_name=$2 AND usename=current_user",
                        )
                        .bind(pid)
                        .bind(marker)
                        .fetch_optional(&pool),
                    )
                    .await;
                    if !matches!(result, Ok(Ok(Some(true) | None))) {
                        cancel_unavailable = true;
                        tracing::warn!(
                            "location read cancellation unavailable; DB deadline remains active"
                        );
                    }
                }
                let _ = connection.detach().close_hard().await;
                // Socket closure alone need not stop PostgreSQL immediately.
                // If cancellation failed, retain admission until its independent
                // SQL deadline; repeated aborts cannot bypass the two-read cap.
                if cancel_unavailable {
                    tokio::time::sleep_until(fallback_deadline).await;
                }
                drop(permit);
            });
        }
        // Runtime shutdown falls back to connection close and the 20 s DB limit.
    }
}

pub fn query_error(error: sqlx::Error) -> AppError {
    if error.as_database_error().and_then(|e| e.code()).as_deref() == Some("57014") {
        AppError::LocationReadTimeout
    } else {
        error.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires disposable runtime124 DB and unprivileged runtime role"]
    async fn read_settings_are_transaction_local_and_do_not_escape_pool() {
        let url = std::env::var("GPS_READ_TEST_DATABASE_URL").expect("isolated DB required");
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let defaults: (String, String) = sqlx::query_as(
            "SELECT current_setting('plan_cache_mode'), current_setting('statement_timeout')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut read = ReadQuery::start_history(&pool).await.unwrap();
        let active: (String, String, bool) = sqlx::query_as(
            "SELECT current_setting('plan_cache_mode'), current_setting('statement_timeout'), \
             current_setting('transaction_read_only')::bool",
        )
        .fetch_one(read.connection())
        .await
        .unwrap();
        assert_eq!(active, ("force_custom_plan".into(), "20s".into(), true));
        read.finish().await.unwrap();
        let restored: (String, String) = sqlx::query_as(
            "SELECT current_setting('plan_cache_mode'), current_setting('statement_timeout')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(restored, defaults);
        pool.close().await;
    }

    #[tokio::test(start_paused = true)]
    async fn timing_stages_do_not_double_count_wait_or_query_scope() {
        let mut timing = ReadTiming::new(true);
        for (delay, next) in [(10, "pool"), (20, "setup"), (30, "scope"), (40, "done")] {
            tokio::time::advance(Duration::from_millis(delay)).await;
            timing.advance(next);
        }
        assert_eq!(timing.admission_ms, 10.0);
        assert_eq!(timing.pool_ms, 20.0);
        assert_eq!(timing.setup_ms, 30.0);
        assert_eq!(timing.scope_ms, 40.0);
        assert_eq!(timing.class, "history");
    }

    #[tokio::test(start_paused = true)]
    async fn excess_reads_are_rejected_and_release_allows_retry() {
        let budget = ReadBudget::new(Duration::from_millis(30));
        let first = budget.acquire(false).await.unwrap();
        let second = budget.acquire(false).await.unwrap();
        assert!(matches!(
            budget.acquire(false).await,
            Err(AppError::LocationReadBusy)
        ));
        drop(first);
        let retry = budget.acquire(false).await.unwrap();
        assert_eq!(budget.total.available_permits(), 0);
        drop((second, retry));
        assert_eq!(budget.total.available_permits(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_waiter_does_not_leak_capacity() {
        let budget = ReadBudget::new(Duration::from_secs(1));
        let active = budget.acquire(true).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(5), budget.acquire(true))
                .await
                .is_err()
        );
        drop(active);
        assert!(budget.acquire(true).await.is_ok());
        assert_eq!(budget.history_waiters.available_permits(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn history_waiter_does_not_block_the_other_global_slot() {
        let budget = ReadBudget::new(Duration::from_secs(1));
        let first = budget.acquire(true).await.unwrap();
        let pending = budget.acquire(true);
        tokio::pin!(pending);
        tokio::select! {
            _ = &mut pending => panic!("second history cannot run"),
            _ = tokio::time::sleep(Duration::from_millis(5)) => {}
        }
        let regular = budget.acquire(false).await.unwrap();
        assert_eq!(budget.total.available_permits(), 0);
        drop(first);
        let next = pending.await.unwrap();
        assert_eq!(budget.history.available_permits(), 0);
        drop((regular, next));
        assert_eq!(budget.total.available_permits(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn queue_overload_is_bounded_and_classes_are_independent() {
        let budget = ReadBudget::new(Duration::from_secs(1));
        let waiting = budget.history_waiters.acquire_many(4).await.unwrap();
        assert!(matches!(
            budget.acquire(true).await,
            Err(AppError::LocationReadBusy)
        ));
        assert!(budget.acquire(false).await.is_ok());
        drop(waiting);
        assert!(budget.acquire(true).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_after_history_gate_releases_both_gates() {
        let budget = ReadBudget::new(Duration::from_secs(1));
        let first = budget.acquire(false).await.unwrap();
        let second = budget.acquire(false).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(5), budget.acquire(true))
                .await
                .is_err()
        );
        assert_eq!(budget.history.available_permits(), 1);
        assert_eq!(budget.history_waiters.available_permits(), 4);
        drop((first, second));
        assert!(budget.acquire(true).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn waits_share_one_deadline_and_release_on_expiry() {
        let budget = ReadBudget::new(Duration::from_millis(60));
        let first = budget.acquire(false).await.unwrap();
        let second = budget.acquire(false).await.unwrap();
        let history = budget.history.acquire().await.unwrap();
        let begin = tokio::time::Instant::now();
        let release = async {
            tokio::time::sleep(Duration::from_millis(40)).await;
            drop(history);
        };
        let (result, ()) = tokio::join!(budget.acquire(true), release);
        assert!(matches!(result, Err(AppError::LocationReadBusy)));
        assert!(begin.elapsed() < Duration::from_millis(90));
        assert_eq!(budget.history.available_permits(), 1);
        drop((first, second));
    }
}
