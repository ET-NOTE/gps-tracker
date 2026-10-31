use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

pub async fn make_pool(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Some(Duration::from_secs(60 * 10)))
        // JSON batch/window queries spend seconds compiling hundreds of JIT
        // functions for millisecond-scale scans. Scope this to our API pool;
        // do not change the PostgreSQL defaults used by neighboring services.
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET jit=off").execute(connection).await?;
                Ok(())
            })
        })
        .connect(database_url)
        .await?;
    Ok(pool)
}
