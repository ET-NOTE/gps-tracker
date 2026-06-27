use std::sync::Arc;

use std::time::Duration;

use anyhow::Context;
use axum::extract::DefaultBodyLimit;
use tokio::net::TcpListener;
use tower_http::{
    cors::{Any, CorsLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

mod auth;
mod config;
mod db;
mod error;
mod events;
mod routes;
mod services;
mod state;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── logging ────────────────────────────────────────────
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().with_target(true).compact())
        .init();

    // ── config & db ───────────────────────────────────────
    let cfg = config::Config::from_env().context("failed to load config")?;
    tracing::info!(bind = %cfg.bind_addr, "starting gps-tracker-api");

    let pool = db::make_pool(&cfg.database_url)
        .await
        .context("failed to connect database")?;

    // 마이그레이션 자동 적용 (sqlx::migrate! macro)
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("migration failed")?;
    tracing::info!("migrations up to date");

    // FCM 클라이언트 — events 워커와 채팅 푸시가 공유
    let fcm = services::fcm::make_client(cfg.fcm_service_account_path.as_deref());

    let state = state::AppState {
        db: pool.clone(),
        config: Arc::new(cfg.clone()),
        events: events::channel(256),
        fcm: fcm.clone(),
    };

    services::fcm::spawn(pool.clone(), fcm);
    services::geofence::spawn_offline_worker(pool.clone());
    services::stats::spawn_worker(pool.clone());
    services::housekeeping::spawn_worker(pool.clone());
    services::partition_worker::spawn_worker(pool.clone());
    services::nce::spawn_cache_worker(pool);

    // ── CORS ──────────────────────────────────────────────
    let cors = if cfg.cors_allowed_origins.iter().any(|s| s == "*") {
        CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
    } else {
        let origins = cfg
            .cors_allowed_origins
            .iter()
            .filter_map(|s| s.parse().ok())
            .collect::<Vec<_>>();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    // ── router ────────────────────────────────────────────
    // Body size limit: 1MB — ingest/webhook 페이로드는 수 KB, ai 분석 응답도 작음.
    //   누가 거대 body 보내도 메모리 폭주 방지. 결제 webhook 등 큰 body 가 필요한 핸들러는
    //   별도 `.layer(DefaultBodyLimit::max(N))` 로 라우터별 오버라이드 가능.
    // Timeout: 30초 — 외부 API (1NCE, Kakao, FCM) 호출까지 여유. 그 이상 걸리면 핸들러 hang
    //   가정하고 abort. 클라이언트는 408/503 받음.
    let app = routes::build_router(state)
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(TimeoutLayer::new(Duration::from_secs(30)))
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    // ── serve ─────────────────────────────────────────────
    let listener = TcpListener::bind(&cfg.bind_addr)
        .await
        .with_context(|| format!("bind {} failed", cfg.bind_addr))?;
    tracing::info!("listening on {}", cfg.bind_addr);

    // Graceful shutdown — SIGTERM (systemctl restart / 도커 stop) 받으면 in-flight 요청
    // 끝날 때까지 대기 후 종료. 새 연결은 안 받음. 배포 시 502 발생률 감소.
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;
    Ok(())
}

async fn shutdown_signal() {
    // Unix: SIGTERM (systemctl) + Ctrl-C 둘 다 수신.
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c    => tracing::info!("shutdown: SIGINT received"),
        _ = terminate => tracing::info!("shutdown: SIGTERM received"),
    }
}
