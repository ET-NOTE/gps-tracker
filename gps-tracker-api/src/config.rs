use anyhow::Context;
use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub jwt_secret: String,
    pub jwt_access_ttl_min: i64,
    pub jwt_refresh_ttl_days: i64,
    pub fcm_server_key: Option<String>,        // legacy server-key path (unused, kept for env compat)
    pub fcm_service_account_path: Option<String>,  // FCM v1: path to service-account JSON
    pub cors_allowed_origins: Vec<String>,
    /// (2026-07-29) 스마트폰을 tracker device 로 페어링 허용 여부.
    /// false 시: pair endpoint 가 kind='phone' 거부. 이미 등록된 phone device 는 계속 동작.
    /// env PHONE_TRACKER_ENABLED=true|false (기본 true).
    pub phone_tracker_enabled: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();

        let cors_raw = env::var("CORS_ALLOWED_ORIGINS").unwrap_or_else(|_| "*".into());
        let cors_allowed_origins = cors_raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        Ok(Self {
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3040".into()),
            database_url: env::var("DATABASE_URL").context("DATABASE_URL not set")?,
            jwt_secret: env::var("JWT_SECRET").context("JWT_SECRET not set")?,
            jwt_access_ttl_min: env::var("JWT_ACCESS_TTL_MIN")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(15),
            jwt_refresh_ttl_days: env::var("JWT_REFRESH_TTL_DAYS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30),
            fcm_server_key: env::var("FCM_SERVER_KEY").ok().filter(|s| !s.is_empty()),
            fcm_service_account_path: env::var("FCM_SERVICE_ACCOUNT_PATH").ok().filter(|s| !s.is_empty()),
            cors_allowed_origins,
            phone_tracker_enabled: env::var("PHONE_TRACKER_ENABLED")
                .ok()
                .map(|s| !matches!(s.to_lowercase().as_str(), "false" | "0" | "no" | "off"))
                .unwrap_or(true),
        })
    }
}
