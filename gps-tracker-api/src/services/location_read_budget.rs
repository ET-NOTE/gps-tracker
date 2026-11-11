//! Bound expensive location reads before they occupy the shared query pool.
//! A short, bounded wait keeps ingest/health capacity available under overload.
//! This is per API process, not a distributed rate limit or a plaintext cache.
use crate::error::{AppError, AppResult};
use sqlx::{
    pool::PoolConnection, postgres::PgPoolOptions, Connection, PgConnection, PgPool, Postgres,
};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::{Semaphore, SemaphorePermit};

static READS: Semaphore = Semaphore::const_new(2);

async fn acquire_from(reads: &Semaphore) -> AppResult<SemaphorePermit<'_>> {
    tokio::time::timeout(Duration::from_millis(250), reads.acquire())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or(AppError::LocationReadBusy)
}

// A separate, bounded pool can cancel even when every regular connection is busy.
// It uses the same unprivileged DB role, never a superuser or pg_signal_backend.
static CANCEL_POOL: OnceLock<PgPool> = OnceLock::new();

pub struct ReadQuery {
    connection: Option<PoolConnection<Postgres>>,
    permit: Option<SemaphorePermit<'static>>,
    cancel_pool: PgPool,
    backend: Option<i32>,
    marker: String,
}

impl ReadQuery {
    pub async fn start(pool: &PgPool) -> AppResult<Self> {
        let permit = acquire_from(&READS).await?;
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
        let mut read = Self {
            connection: Some(pool.acquire().await?),
            permit: Some(permit),
            cancel_pool,
            backend: None,
            marker: format!("gps-read-{}", uuid::Uuid::new_v4()),
        };
        // Set the independent DB deadline before doing expensive work. Transaction
        // local settings cannot escape into the next request on this connection.
        sqlx::query("BEGIN READ ONLY")
            .execute(read.connection())
            .await?;
        sqlx::query("SET LOCAL statement_timeout = '20s'")
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
        Ok(read)
    }

    pub fn connection(&mut self) -> &mut PgConnection {
        self.connection.as_mut().expect("unfinished read")
    }

    pub async fn finish(mut self) -> AppResult<()> {
        sqlx::query("COMMIT").execute(self.connection()).await?;
        // Completed reads can safely reuse the normal pool connection.
        self.connection.take();
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
    async fn excess_reads_are_rejected_and_release_allows_retry() {
        let budget = Semaphore::new(2);
        let first = acquire_from(&budget).await.unwrap();
        let second = acquire_from(&budget).await.unwrap();
        assert!(matches!(
            acquire_from(&budget).await,
            Err(AppError::LocationReadBusy)
        ));
        drop(first);
        let retry = acquire_from(&budget).await.unwrap();
        assert_eq!(budget.available_permits(), 0);
        drop((second, retry));
        assert_eq!(budget.available_permits(), 2);
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_leak_capacity() {
        let budget = Semaphore::new(1);
        let active = acquire_from(&budget).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(5), acquire_from(&budget))
                .await
                .is_err()
        );
        drop(active);
        assert!(acquire_from(&budget).await.is_ok());
    }
}
