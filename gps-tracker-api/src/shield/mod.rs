mod admin;
mod auth;
mod content;
mod devices;
mod ingest;
mod nce;
mod usim;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    migrate::{Migration, MigrationType, Migrator},
    postgres::{PgConnectOptions, PgPoolOptions},
    PgPool,
};
use std::{borrow::Cow, env, net::SocketAddr, str::FromStr, sync::Arc, time::Duration};
use tokio::sync::{broadcast, Semaphore};
use tower_http::timeout::TimeoutLayer;
use uuid::Uuid;

#[derive(Clone)]
pub struct App {
    db: PgPool,
    origin: String,
    secure: bool,
    password_slots: Arc<Semaphore>,
    events: broadcast::Sender<(i64, i64)>,
    nce: nce::Provider,
}

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error(StatusCode, String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error=%e,"shield database error");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.".into(),
        )
    }
}
pub fn bad(message: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, message.into())
}
pub fn denied() -> Error {
    Error(StatusCode::UNAUTHORIZED, "다시 로그인해 주세요.".into())
}
pub fn missing() -> Error {
    Error(StatusCode::NOT_FOUND, "장치를 찾을 수 없습니다.".into())
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn check_config(url: &str, origin: &str, bind: SocketAddr, production: bool) -> anyhow::Result<()> {
    let db = PgConnectOptions::from_str(url)?;
    let name = db.get_database().unwrap_or_default();
    anyhow::ensure!(
        if production {
            name == "shield_prod" && db.get_username() == "shield_app"
        } else {
            (name.starts_with("shield_test") || name == "shield_dev")
                && (db.get_username().starts_with("shield_test")
                    || db.get_username() == "shield_dev_app")
        },
        "Shield requires its own database and role"
    );
    anyhow::ensure!(
        !matches!(
            db.get_username(),
            "gps_tracker_app" | "gps_tracker_dev_app" | "mmm"
        ),
        "GPS credentials are forbidden"
    );
    anyhow::ensure!(
        bind.ip().is_loopback(),
        "API must bind loopback behind its proxy"
    );
    if production {
        anyhow::ensure!(
            origin == "https://shield.serial.kr",
            "Unexpected Shield production origin"
        );
    } else {
        let parsed = reqwest::Url::parse(origin)?;
        anyhow::ensure!(
            matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")) && parsed.path() == "/",
            "Preview must use a local origin"
        );
    }
    Ok(())
}

async fn migrate(db: &PgPool) -> anyhow::Result<()> {
    let sources = [
        ("shield schema", include_str!("schema.sql")),
        (
            "shared GPS points",
            include_str!("../../migrations/0062_location_points.sql"),
        ),
        (
            "shared GPS ranges",
            include_str!("../../migrations/0063_location_range_queries.sql"),
        ),
        (
            "shared GPS speed",
            include_str!("../../migrations/0064_server_coordinate_speed.sql"),
        ),
        (
            "Shield administration and dynamic sensors",
            include_str!("operations.sql"),
        ),
        ("Unique provider order link", include_str!("order-link.sql")),
    ];
    let migrations = sources
        .into_iter()
        .enumerate()
        .map(|(i, (name, sql))| {
            Migration::new(
                i as i64 + 1,
                Cow::Borrowed(name),
                MigrationType::Simple,
                Cow::Borrowed(sql),
                false,
            )
        })
        .collect();
    Migrator {
        migrations: Cow::Owned(migrations),
        ..Migrator::DEFAULT
    }
    .run(db)
    .await?;
    Ok(())
}

async fn headers(State(app): State<App>, request: Request, next: Next) -> Response {
    // Browser mutations require the exact origin. Device uploads use a separate
    // per-device credential and cannot authenticate with a browser cookie.
    if request.method() != axum::http::Method::GET
        && request.uri().path() != "/ingest/shield"
        && request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            != Some(&app.origin)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"요청 출처를 확인할 수 없습니다."})),
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}

pub async fn run() -> anyhow::Result<()> {
    // No dotenv fallback: a Shield service cannot accidentally load the GPS .env.
    let url = env::var("SHIELD_DATABASE_URL")?;
    let origin = env::var("SHIELD_ORIGIN")?;
    let bind: SocketAddr = env::var("SHIELD_BIND")
        .unwrap_or("127.0.0.1:3043".into())
        .parse()?;
    let production = match env::var("SHIELD_ENV").as_deref() {
        Ok("production") => true,
        Ok("preview" | "test") => false,
        _ => anyhow::bail!("SHIELD_ENV must be explicit"),
    };
    check_config(&url, &origin, bind, production)?;
    let db = PgPoolOptions::new()
        .max_connections(4)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&url)
        .await?;
    if production {
        let privileged: bool = sqlx::query_scalar("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&db).await?;
        anyhow::ensure!(
            !privileged,
            "Shield production role must not have cluster administration privileges"
        );
    }
    migrate(&db).await?;
    content::seed(&db).await?;
    let args: Vec<_> = env::args().skip(1).collect();
    if let Some(command) = args.first() {
        match command.as_str() {
            "migrate" => {}
            "grant-admin" => {
                let email = args
                    .get(1)
                    .ok_or_else(|| anyhow::anyhow!("Email required"))?;
                let mut tx = db.begin().await?;
                sqlx::query("SELECT pg_advisory_xact_lock(8043001)")
                    .execute(&mut *tx)
                    .await?;
                let id: i64 = sqlx::query_scalar(
                    "UPDATE users SET role='admin',disabled=false WHERE email=$1 RETURNING id",
                )
                .bind(email.trim().to_lowercase())
                .fetch_one(&mut *tx)
                .await?;
                sqlx::query("DELETE FROM sessions WHERE user_id=$1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                admin::audit(
                    &mut tx,
                    None,
                    "admin.bootstrap",
                    "user",
                    &id.to_string(),
                    json!({"method":"operator CLI"}),
                )
                .await
                .map_err(|_| anyhow::anyhow!("Audit failed"))?;
                tx.commit().await?;
                println!("{}", json!({"user_id":id,"role":"admin"}));
            }
            "invite" => {
                let code = secret();
                sqlx::query(
                    "INSERT INTO invites(code_hash,expires_at) VALUES($1,now()+interval '7 days')",
                )
                .bind(hash(&code))
                .execute(&db)
                .await?;
                println!("{}", json!({"invite_code":code,"expires_in_days":7}));
            }
            "provision" => {
                let uid = format!("uno-shield-{}", Uuid::new_v4().simple());
                let key = secret();
                let claim = secret();
                let name = args.get(1).map(String::as_str).unwrap_or("새 쉴드");
                sqlx::query("INSERT INTO devices(device_uid,display_name,key_hash,claim_hash) VALUES($1,$2,$3,$4)")
                    .bind(&uid).bind(name).bind(hash(&key)).bind(hash(&claim)).execute(&db).await?;
                println!(
                    "{}",
                    json!({"device_uid":uid,"device_key":key,"claim_code":claim})
                );
            }
            _ => anyhow::bail!("Unknown Shield command"),
        }
        return Ok(());
    }
    let app = App {
        db,
        origin,
        secure: production,
        password_slots: Arc::new(Semaphore::new(2)),
        events: broadcast::channel(128).0,
        nce: nce::Provider::config(production)?,
    };
    usim::worker(app.clone());
    let maintenance = app.db.clone();
    tokio::spawn(async move {
        let mut hourly = tokio::time::interval(Duration::from_secs(3600));
        loop {
            hourly.tick().await;
            // Only expired authentication metadata. Device and account history is retained.
            for query in [
                "DELETE FROM sessions WHERE expires_at<now()",
                "DELETE FROM auth_attempts WHERE started_at<now()-interval '1 day'",
                "DELETE FROM invites WHERE expires_at<now()-interval '30 days'",
            ] {
                if let Err(error) = sqlx::query(query).execute(&maintenance).await {
                    tracing::warn!(%error,"Shield auth housekeeping failed");
                }
            }
        }
    });
    let router=Router::new()
        .route("/health",get(||async{Json(json!({"ok":true,"service":"shield-api","release":option_env!("GPS_RELEASE").unwrap_or("local")}))}))
        .route("/api/auth/register",post(auth::register))
        .route("/api/auth/login",post(auth::login))
        .route("/api/auth/logout",post(auth::logout))
        .route("/api/auth/session",get(auth::session))
        .route("/api/posts",get(content::list))
        .route("/api/admin/overview",get(admin::overview))
        .route("/api/admin/users",get(admin::users))
        .route("/api/admin/users/:id",post(admin::edit_user))
        .route("/api/admin/users/:id/revoke",post(admin::revoke_sessions))
        .route("/api/admin/users/:id/credits",post(usim::adjust))
        .route("/api/admin/devices",get(admin::devices))
        .route("/api/admin/devices/:id",post(admin::edit_device))
        .route("/api/admin/audit",get(admin::events))
        .route("/api/admin/invites",post(admin::invite))
        .route("/api/admin/posts",get(content::admin_list))
        .route("/api/admin/posts/:slug",post(content::save))
        .route("/api/devices",get(devices::list))
        .route("/api/devices/claim",post(devices::claim))
        .route("/api/devices/:id/summary",get(devices::summary))
        .route("/api/devices/:id/readings",get(devices::readings))
        .route("/api/devices/:id/locations",get(devices::locations))
        .route("/api/devices/:id/usim",get(usim::get))
        .route("/api/devices/:id/usim/refresh",post(usim::refresh))
        .route("/api/sim-requests",get(usim::requests).post(usim::create))
        .route("/api/sim-requests/:id/history",get(usim::history))
        .route("/api/sim-requests/:id/action",post(usim::action))
        .route("/api/credits",get(usim::credits))
        .route("/api/ws",get(devices::ws))
        .route("/ingest/shield",post(ingest::ingest).layer(DefaultBodyLimit::max(8192)))
        .layer(middleware::from_fn_with_state(app.clone(),headers))
        .layer(DefaultBodyLimit::max(131072))
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT,Duration::from_secs(20)))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind,production,"shield ready");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            #[cfg(unix)]
            {
                let mut signal =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .unwrap();
                tokio::select! {_=signal.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_gps_database_or_public_binding() {
        let bind = "127.0.0.1:3043".parse().unwrap();
        assert!(check_config(
            "postgres://shield_app@localhost/shield_prod",
            "https://shield.serial.kr",
            bind,
            true
        )
        .is_ok());
        for db in ["gps_tracker", "gps_tracker_dev", "shield_dev"] {
            assert!(check_config(
                &format!("postgres://shield_app@localhost/{db}"),
                "https://shield.serial.kr",
                bind,
                true
            )
            .is_err());
        }
        for role in ["gps_tracker_app", "gps_tracker_dev_app", "postgres"] {
            assert!(check_config(
                &format!("postgres://{role}@localhost/shield_test"),
                "http://localhost:8043",
                bind,
                false
            )
            .is_err());
        }
        assert!(check_config(
            "postgres://shield_app@localhost/shield_prod",
            "https://shield.serial.kr",
            "0.0.0.0:3043".parse().unwrap(),
            true
        )
        .is_err());
    }
}
