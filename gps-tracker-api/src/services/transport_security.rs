//! TLS metadata is trusted only from an explicitly configured terminating proxy.
//! Never treat a client-provided Forwarded/X-Forwarded-Proto as proof of TLS.
use axum::{
    extract::{ConnectInfo, Request},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use ipnet::IpNet;
use std::net::{IpAddr, SocketAddr};

fn required() -> bool {
    std::env::var("GPS_INGEST_TLS_REQUIRED").as_deref() == Ok("on")
}
fn proxies() -> anyhow::Result<Vec<IpNet>> {
    std::env::var("GPS_TLS_TRUSTED_PROXIES")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| Ok(s.trim().parse()?))
        .collect()
}
pub fn validate_config() -> anyhow::Result<()> {
    let mode = std::env::var("GPS_INGEST_TLS_REQUIRED").unwrap_or_else(|_| "off".into());
    anyhow::ensure!(
        matches!(mode.as_str(), "off" | "on"),
        "invalid TLS enforcement mode"
    );
    let peers = proxies()?;
    if required() {
        anyhow::ensure!(
            !peers.is_empty()
                && peers
                    .iter()
                    .all(|p| p.prefix_len() == if p.addr().is_ipv4() { 32 } else { 128 }),
            "TLS requires explicit proxy host addresses"
        );
        anyhow::ensure!(
            !super::device_auth::enabled("GPS_LEGACY_INGEST_ENABLED")
                && !super::device_auth::enabled("GPS_KC_INGEST_ENABLED"),
            "TLS enforcement cannot allow unsigned legacy enrollment"
        );
    }
    Ok(())
}
fn verified(peer: IpAddr, headers: &HeaderMap, trusted: &[IpNet]) -> bool {
    trusted.iter().any(|net| net.contains(&peer))
        && headers.get_all("x-gps-tls-version").iter().count() == 1
        && matches!(
            headers
                .get("x-gps-tls-version")
                .and_then(|v| v.to_str().ok()),
            Some("TLSv1.2" | "TLSv1.3")
        )
}
pub async fn middleware(request: Request, next: Next) -> Response {
    if required() && request.uri().path() == "/gps-tracker/ingest" {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip());
        if !peer.is_some_and(|ip| verified(ip, request.headers(), &proxies().unwrap_or_default())) {
            // Do not redirect a cleartext telemetry POST: the coordinates have already leaked.
            return (
                StatusCode::UPGRADE_REQUIRED,
                axum::Json(serde_json::json!({"error":"TLS 1.2 or later is required"})),
            )
                .into_response();
        }
    }
    next.run(request).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_metadata_is_not_client_proof() {
        let trusted = ["127.0.0.1/32".parse().unwrap()];
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(!verified("127.0.0.1".parse().unwrap(), &h, &trusted));
        for version in ["TLSv1.0", "TLSv1.1", "TLSv1.2,TLSv1.3", ""] {
            h.insert("x-gps-tls-version", version.parse().unwrap());
            assert!(!verified("127.0.0.1".parse().unwrap(), &h, &trusted));
        }
        h.insert("x-gps-tls-version", "TLSv1.2".parse().unwrap());
        assert!(verified("127.0.0.1".parse().unwrap(), &h, &trusted));
        assert!(!verified("192.0.2.1".parse().unwrap(), &h, &trusted));
        h.append("x-gps-tls-version", "TLSv1.3".parse().unwrap());
        assert!(!verified("127.0.0.1".parse().unwrap(), &h, &trusted));
    }
}
