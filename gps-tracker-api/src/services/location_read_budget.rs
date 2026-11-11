//! Bound expensive location reads before they occupy the shared query pool.
//! A short, bounded wait keeps ingest/health capacity available under overload.
//! This is per API process, not a distributed rate limit or a plaintext cache.
use crate::error::{AppError, AppResult};
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};

static READS: Semaphore = Semaphore::const_new(2);

async fn acquire_from(reads: &Semaphore) -> AppResult<SemaphorePermit<'_>> {
    tokio::time::timeout(Duration::from_millis(250), reads.acquire())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| {
            AppError::TooManyRequests(
                "이동 기록 조회가 많습니다. 잠시 후 다시 시도해 주세요.".into(),
            )
        })
}

pub async fn acquire() -> AppResult<SemaphorePermit<'static>> {
    acquire_from(&READS).await
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
            Err(AppError::TooManyRequests(_))
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
