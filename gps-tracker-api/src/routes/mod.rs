pub mod admin;
pub mod ai;
pub mod auth;
pub mod chat;
pub mod corporate;
pub mod credits;
pub mod devices;
pub mod geofences;
pub mod health;
pub mod ingest;
pub mod locations;
pub mod notifications;
pub mod payments;
pub mod phones;
pub mod profile_type;
pub mod share;
pub mod sim_requests;
pub mod stats;
pub mod ws;

use axum::{routing::{get, post}, Router};
use tower_http::services::ServeDir;

use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    // /gps-tracker prefix는 nginx가 stripping하지 않고 그대로 proxy_pass하므로
    // 여기서도 동일 prefix로 라우트.
    let api_v1 = Router::new()
        .merge(auth::router())
        .merge(devices::router())
        .merge(locations::router())
        .merge(notifications::router())
        .merge(geofences::router())
        .merge(stats::router())
        .merge(share::router_authed())
        .merge(share::router_public())   // 인증 없이 호출 (/share/:token 등)
        .merge(ai::router())
        .merge(credits::router())
        .merge(credits::router_admin())
        .merge(profile_type::router())
        .merge(corporate::router())
        .merge(payments::router())
        .merge(phones::router())
        .merge(sim_requests::router_user())
        .merge(sim_requests::router_admin())
        .merge(chat::router_user())
        .merge(chat::router_admin())
        .merge(admin::router())
        ;

    Router::new()
        .route("/health", get(health::health))
        .route("/gps-tracker/health", get(health::health))
        .route("/gps-tracker/ingest", post(ingest::ingest))
        .nest("/gps-tracker/api/v1", api_v1)
        .nest("/gps-tracker/ws", ws::router())
        .nest_service("/uploads", ServeDir::new("/home/gps-dev/uploads"))
        .with_state(state)
}
