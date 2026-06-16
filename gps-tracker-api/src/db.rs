use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

pub async fn make_pool(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Some(Duration::from_secs(60 * 10)))
        .connect(database_url)
        .await?;
    Ok(pool)
}
