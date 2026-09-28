//! Independent Shield entry point. The GPS binary never loads this service.
#[path = "../auth/password.rs"]
mod password;
#[path = "../shield/mod.rs"]
mod shield;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    shield::run().await
}
