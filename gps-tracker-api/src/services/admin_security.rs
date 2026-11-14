//! Administrative step-up is independent of ordinary account/company membership.
use crate::{
    auth::jwt,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, MatchedPath, Request, State},
    http::{request::Parts, HeaderMap},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use hmac::{Hmac, Mac};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use subtle::ConstantTimeEq;

pub fn enabled() -> bool {
    std::env::var("GPS_ADMIN_SECURITY").as_deref() == Ok("on")
}
pub fn validate_config() -> anyhow::Result<()> {
    if enabled() {
        key()?;
        proxies()?;
        anyhow::ensure!(
            std::env::var("APP_ENV").as_deref() == Ok("test")
                || std::env::var("GPS_DATABASE_MODE").as_deref() == Ok("runtime")
                || std::env::var("GPS_MIGRATE_ONLY").as_deref() == Ok("1"),
            "enforced admin security requires separated runtime DB mode"
        );
    }
    Ok(())
}
fn key() -> AppResult<Vec<u8>> {
    let key = STANDARD
        .decode(std::env::var("GPS_ADMIN_MFA_KEY").unwrap_or_default())
        .unwrap_or_default();
    if key.len() != 32 {
        return Err(AppError::Internal(anyhow::anyhow!(
            "GPS_ADMIN_MFA_KEY must be a separate 32-byte base64 secret"
        )));
    }
    Ok(key)
}
fn proxies() -> AppResult<Vec<IpNet>> {
    std::env::var("GPS_ADMIN_TRUSTED_PROXIES")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            s.trim()
                .parse()
                .map_err(|_| AppError::Internal(anyhow::anyhow!("invalid trusted proxy CIDR")))
        })
        .collect()
}
pub fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> AppResult<IpAddr> {
    resolved_ip(peer, headers, &proxies()?)
}
fn resolved_ip(peer: SocketAddr, headers: &HeaderMap, networks: &[IpNet]) -> AppResult<IpAddr> {
    let ip = peer.ip().to_canonical();
    if networks.iter().any(|net| net.contains(&ip)) {
        // Nginx must overwrite this header with $remote_addr, never append a client value.
        let value = headers
            .get("x-real-ip")
            .and_then(|s| s.to_str().ok())
            .ok_or(AppError::Forbidden)?;
        value
            .parse::<IpAddr>()
            .map(|p| p.to_canonical())
            .map_err(|_| AppError::Forbidden)
    } else {
        Ok(ip)
    }
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn base32(bytes: &[u8]) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let mut bits = 0;
    let mut value = 0u32;
    for &b in bytes {
        value = (value << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(alphabet[((value >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(alphabet[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}
pub fn seed(uid: i64, nonce: &str) -> AppResult<Vec<u8>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(&key()?).map_err(|_| AppError::Forbidden)?;
    mac.update(format!("gps-admin-totp-v1:{uid}:{nonce}").as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}
pub fn secret(uid: i64, nonce: &str) -> AppResult<String> {
    Ok(base32(&seed(uid, nonce)?))
}
fn otp(seed: &[u8], counter: i64, digits: u32) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(seed).expect("HMAC accepts any key length");
    mac.update(&(counter as u64).to_be_bytes());
    let bytes = mac.finalize().into_bytes();
    let o = (bytes[31] & 15) as usize;
    let n = u32::from_be_bytes(bytes[o..o + 4].try_into().expect("four bytes")) & 0x7fffffff;
    format!("{:0width$}", n % 10u32.pow(digits), width = digits as usize)
}
pub fn verify_code(uid: i64, nonce: &str, code: &str, last: i64) -> AppResult<Option<i64>> {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(None);
    }
    let seed = seed(uid, nonce)?;
    let counter = Utc::now().timestamp() / 30;
    Ok((counter - 1..=counter + 1)
        .filter(|n| *n > last)
        .find(|n| bool::from(otp(&seed, *n, 6).as_bytes().ct_eq(code.as_bytes()))))
}
pub fn password_valid(p: &str) -> bool {
    p.len() >= 9
        && p.len() <= 256
        && p.bytes().any(|b| b.is_ascii_alphabetic())
        && p.bytes().any(|b| b.is_ascii_digit())
        && p.bytes().any(|b| b.is_ascii_punctuation())
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Principal {
    pub user_id: i64,
    pub role: String,
    pub enabled: bool,
    pub allowed_cidrs: Vec<String>,
    pub subject_ids: Vec<i64>,
    pub revision: i64,
}
#[derive(Clone)]
pub struct Verified {
    pub principal: Principal,
    pub ip: String,
}
pub async fn principal(state: &AppState, uid: i64, ip: &str) -> AppResult<Principal> {
    let row:Option<Principal>=sqlx::query_as("SELECT p.* FROM admin_principals p JOIN users u ON u.id=p.user_id JOIN privacy_account_controls c ON c.user_id=u.id WHERE p.user_id=$1 AND u.role='admin' AND NOT c.restricted")
 .bind(uid).fetch_optional(&state.db).await?;
    let p = row.ok_or(AppError::Forbidden)?;
    let addr: IpAddr = ip.parse().map_err(|_| AppError::Forbidden)?;
    if !p.enabled
        || !p
            .allowed_cidrs
            .iter()
            .filter_map(|s| s.parse::<IpNet>().ok())
            .any(|net| net.contains(&addr))
    {
        return Err(AppError::Forbidden);
    }
    Ok(p)
}
pub async fn event(
    state: &AppState,
    actor: Option<i64>,
    ip: &str,
    action: &str,
    route: &str,
    outcome: &str,
    approval: Option<i64>,
) -> AppResult<()> {
    sqlx::query("INSERT INTO admin_security_events(actor_id,ip,action,route,outcome,approval_id) VALUES($1,$2,$3,$4,$5,$6)")
 .bind(actor).bind(ip).bind(action).bind(route).bind(outcome).bind(approval).execute(&state.db).await?;
    Ok(())
}
pub fn identity(headers: &HeaderMap, state: &AppState) -> AppResult<i64> {
    let t = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let c =
        jwt::verify(t, &state.config.jwt_secret, "access").map_err(|_| AppError::Unauthorized)?;
    if c.act.is_some() {
        return Err(AppError::Forbidden);
    }
    c.sub.parse().map_err(|_| AppError::Unauthorized)
}
pub async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    peer: SocketAddr,
) -> AppResult<Verified> {
    let uid = identity(headers, state)?;
    let ip = client_ip(peer, headers)?.to_string();
    let p = principal(state, uid, &ip).await?;
    let token = headers
        .get("x-admin-session")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_sessions s JOIN users u ON u.id=s.user_id JOIN admin_mfa m ON m.user_id=u.id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.ip=$3 AND s.principal_revision=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.password_hash=u.password_hash AND m.password_hash=u.password_hash AND m.password_set_at>now()-interval '90 days' AND m.nonce IS NOT NULL AND (m.locked_until IS NULL OR m.locked_until<=now()))")
 .bind(hash(token.as_bytes())).bind(uid).bind(&ip).bind(p.revision).fetch_one(&state.db).await?;
    if !ok {
        return Err(AppError::Forbidden);
    }
    Ok(Verified { principal: p, ip })
}
pub async fn require(parts: &mut Parts, _state: &AppState) -> AppResult<()> {
    if !enabled() {
        return Ok(());
    }
    if parts.extensions.get::<Verified>().is_none() {
        return Err(AppError::Forbidden);
    }
    Ok(())
}
fn relative(path: &str) -> &str {
    path.strip_prefix("/gps-tracker/api/v1").unwrap_or(path)
}
fn bootstrap(path: &str) -> bool {
    matches!(
        path,
        "/admin/security/status" | "/admin/security/enroll" | "/admin/security/verify"
    )
}
fn workflow(path: &str) -> bool {
    path == "/admin/security/approvals"
        || path.starts_with("/admin/security/approvals/")
        || path == "/admin/security/logout"
}
pub fn needs_approval(method: &str, path: &str) -> bool {
    !read_action(method, path)
        && (path.starts_with("/admin/privacy/") || path.starts_with("/admin/security/principals/"))
}
pub fn read_action(method: &str, path: &str) -> bool {
    if matches!(method, "GET" | "HEAD") {
        return true;
    }
    if method != "POST" {
        return false;
    }
    // Explicit reviewed read-only POSTs. A future endpoint cannot inherit access by suffix.
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        [
            "admin",
            "privacy",
            "requests",
            _,
            "image-preview" | "redacted-preview"
        ] | ["admin", "privacy", "requests", _, "text-sources", _, _]
            | ["admin", "privacy", "requests", _, "documents", _, "review"]
            | ["admin", "privacy", "requests", _, "receipt-sources", _, _]
            | ["admin", "privacy", "company-tasks", _, "proof", _]
    )
}
pub async fn permission(
    state: &AppState,
    p: &Principal,
    method: &str,
    path: &str,
) -> AppResult<()> {
    if path.ends_with("/impersonate") {
        return Err(AppError::Forbidden);
    }
    if p.role == "handler" {
        if !matches!(method, "GET" | "HEAD") {
            return Err(AppError::Forbidden);
        }
        let v: Vec<_> = path.trim_matches('/').split('/').collect();
        let owner = match v.as_slice() {
            ["admin", "users", id] | ["admin", "users", id, "devices"] => id.parse::<i64>().ok(),
            ["admin", "devices", id] => {
                let id = id.parse::<i64>().map_err(|_| AppError::Forbidden)?;
                sqlx::query_scalar("SELECT owner_id FROM gps_read_devices WHERE id=$1")
                    .bind(id)
                    .fetch_optional(&state.db)
                    .await?
                    .flatten()
            }
            _ => None,
        };
        if !owner.is_some_and(|uid| p.subject_ids.contains(&uid)) {
            return Err(AppError::Forbidden);
        }
    } else if !read_action(method, path) && !workflow(path) && p.role != "operator" {
        return Err(AppError::Forbidden);
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
pub struct Proposal {
    pub method: String,
    pub path: String,
    pub payload: Value,
    pub reason: String,
}
pub fn digest(method: &str, path: &str, payload: &Value) -> String {
    hash(format!("{method}\n{path}\n{payload}").as_bytes())
}
// Only reviewed existing endpoints enter two-person execution. Unknown mutations fail closed.
pub async fn fingerprint(state: &AppState, method: &str, path: &str) -> AppResult<String> {
    if !matches!(method, "POST" | "PATCH" | "PUT" | "DELETE")
        || !path.starts_with("/admin/")
        || path.contains(['?', '%', '#'])
        || path.ends_with("/impersonate")
        || read_action(method, path)
    {
        return Err(AppError::BadRequest(
            "승인 가능한 작업 경로가 아닙니다.".into(),
        ));
    }
    let v: Vec<_> = path.trim_matches('/').split('/').collect();
    let (table, id) = match v.as_slice() {
        ["admin", "security", "principals", id] => ("admin_principals", *id),
        ["admin", "privacy", "requests", id, ..] => ("privacy_requests", *id),
        ["admin", "privacy", "company-reviews", id, ..] => ("privacy_company_reviews", *id),
        ["admin", "privacy", "company-tasks", id, ..] => ("privacy_company_tasks", *id),
        ["admin", "privacy", "deliveries", id, ..] => ("privacy_deliveries", *id),
        ["admin", "privacy", "account-packages", id, ..] => ("privacy_account_packages", *id),
        ["admin", "privacy", "redacted", id, ..] => ("privacy_redacted_deliveries", *id),
        ["admin", "privacy", "images", id, ..] => ("privacy_image_deliveries", *id),
        ["admin", "devices", id, "recompute-stats"] => ("devices", *id),
        _ => {
            return Err(AppError::BadRequest(
                "이 작업은 승인 실행 범위에 아직 포함되지 않았습니다.".into(),
            ))
        }
    };
    let id = id
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("대상 번호가 필요합니다.".into()))?;
    let col = if table == "admin_principals" {
        "user_id"
    } else {
        "id"
    };
    let q = format!("SELECT to_jsonb(t) FROM {table} t WHERE {col}=$1");
    let row: Option<Value> = sqlx::query_scalar(&q)
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    if row.is_none() && table != "admin_principals" {
        return Err(AppError::NotFound);
    }
    Ok(hash(row.unwrap_or(Value::Null).to_string().as_bytes()))
}
pub async fn consume(
    state: &AppState,
    v: &Verified,
    method: &str,
    path: &str,
    payload: &Value,
    id: i64,
) -> AppResult<()> {
    let fp = fingerprint(state, method, path).await?;
    let mut tx = state.db.begin().await?;
    let row:Option<(i64,i64,String,String,String,i64,i64)>=sqlx::query_as("SELECT a.requester_id,a.requester_revision,a.digest,a.target_fingerprint,a.status,a.approver_id,a.approver_revision FROM admin_approvals a WHERE a.id=$1 AND a.expires_at>now() AND a.status='approved' AND a.approver_id IS NOT NULL AND a.approver_revision IS NOT NULL FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let Some((owner, rev, dig, target, status, approver, approver_rev)) = row else {
        return Err(AppError::Conflict("유효한 승인이 필요합니다.".into()));
    };
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_principals p JOIN users u ON u.id=p.user_id JOIN privacy_account_controls c ON c.user_id=u.id WHERE p.user_id=$1 AND p.revision=$2 AND p.role='officer' AND p.enabled AND u.role='admin' AND NOT c.restricted)").bind(approver).bind(approver_rev).fetch_one(&mut *tx).await?;
    if owner != v.principal.user_id
        || rev != v.principal.revision
        || approver == owner
        || !active
        || v.principal.role != "operator"
        || status != "approved"
        || dig != digest(method, path, payload)
        || fp != target
    {
        return Err(AppError::Conflict(
            "승인한 대상·내용·권한이 변경됐거나 이미 실행했습니다.".into(),
        ));
    }
    sqlx::query(
        "UPDATE admin_approvals SET status='consumed',consumed_at=clock_timestamp() WHERE id=$1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO admin_security_events(actor_id,ip,action,route,outcome,approval_id) VALUES($1,$2,'execute',$3,'consumed',$4)").bind(owner).bind(&v.ip).bind(path).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn middleware(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    if !enabled() {
        if relative(req.uri().path()).starts_with("/admin/security/")
            && !relative(req.uri().path()).ends_with("/status")
        {
            return AppError::Conflict("관리자 보안 기능이 아직 활성화되지 않았습니다.".into())
                .into_response();
        }
        return next.run(req).await;
    }
    let path = relative(req.uri().path()).to_string();
    if !path.starts_with("/admin/") {
        return next.run(req).await;
    }
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|p| relative(p.as_str()))
        .unwrap_or("/admin/unmatched")
        .to_string();
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|v| v.0);
    let ip = peer
        .and_then(|p| client_ip(p, req.headers()).ok())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unresolved".into());
    let actor = identity(req.headers(), &state).ok();
    let mut approval = None;
    let result: AppResult<()> = async {
        let peer = peer.ok_or(AppError::Forbidden)?;
        if bootstrap(&path) {
            let uid = identity(req.headers(), &state)?;
            principal(&state, uid, &ip).await?;
            return Ok(());
        }
        let verified = authenticate(&state, req.headers(), peer).await?;
        permission(&state, &verified.principal, req.method().as_str(), &path).await?;
        if needs_approval(req.method().as_str(), &path) && !workflow(&path) {
            let id = req
                .headers()
                .get("x-admin-approval")
                .and_then(|s| s.to_str().ok())
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| AppError::Conflict("책임자 승인 후 실행해 주세요.".into()))?;
            let body = std::mem::replace(req.body_mut(), Body::empty());
            let bytes = to_bytes(body, 1024 * 1024)
                .await
                .map_err(|_| AppError::BadRequest("요청이 너무 큽니다.".into()))?;
            let payload = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes)
                    .map_err(|_| AppError::BadRequest("JSON 요청이 필요합니다.".into()))?
            };
            consume(
                &state,
                &verified,
                req.method().as_str(),
                &path,
                &payload,
                id,
            )
            .await?;
            approval = Some(id);
            *req.body_mut() = Body::from(bytes);
        }
        req.extensions_mut().insert(verified);
        Ok(())
    }
    .await;
    let outcome = if result.is_ok() {
        "authorized"
    } else {
        "denied"
    };
    if let Err(e) = event(&state, actor, &ip, "access", &route, outcome, approval).await {
        return e.into_response();
    }
    if let Err(e) = result {
        return e.into_response();
    }
    let mut response = next.run(req).await;
    if let Err(e) = event(
        &state,
        actor,
        &ip,
        "response",
        &route,
        if response.status().is_success() {
            "ready"
        } else {
            "failed"
        },
        approval,
    )
    .await
    {
        response = e.into_response();
    }
    response
        .headers_mut()
        .insert("cache-control", "no-store, private".parse().unwrap());
    response
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rfc6238_sha256() {
        let seed = b"12345678901234567890123456789012";
        for (t, want) in [
            (59, "46119246"),
            (1111111109, "68084774"),
            (1111111111, "67062674"),
            (1234567890, "91819424"),
            (2000000000, "90698825"),
            (20000000000, "77737706"),
        ] {
            assert_eq!(otp(seed, t / 30, 8), want);
        }
    }
    #[test]
    fn encoding_and_password() {
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
        assert!(password_valid("Example-123"));
        assert!(!password_valid("123456789"));
        assert!(!password_valid("abcdefgh!"));
    }
    #[test]
    fn proxy_boundary() {
        let peer = "127.0.0.1:5000".parse().unwrap();
        let trusted = vec!["127.0.0.1/32".parse().unwrap()];
        let mut h = HeaderMap::new();
        assert!(resolved_ip(peer, &h, &trusted).is_err());
        h.insert("x-real-ip", "203.0.113.10".parse().unwrap());
        assert_eq!(
            resolved_ip(peer, &h, &trusted).unwrap().to_string(),
            "203.0.113.10"
        );
        assert_eq!(resolved_ip(peer, &h, &[]).unwrap().to_string(), "127.0.0.1");
        h.insert("x-real-ip", "203.0.113.10, 127.0.0.1".parse().unwrap());
        assert!(resolved_ip(peer, &h, &trusted).is_err());
    }
    #[test]
    fn read_only_post_allowlist() {
        assert!(read_action(
            "POST",
            "/admin/privacy/requests/1/receipt-sources/2/3"
        ));
        assert!(read_action(
            "POST",
            "/admin/privacy/requests/1/documents/2/review"
        ));
        assert!(!read_action(
            "POST",
            "/admin/privacy/requests/1/receipt-sources/2/3/delete"
        ));
        assert!(!read_action("POST", "/admin/privacy/new-feature/review"));
        assert!(needs_approval("POST", "/admin/privacy/new-feature/review"));
        assert!(needs_approval("POST", "/admin/privacy/requests/1/images"));
    }
    #[test]
    fn bound_digest() {
        assert_eq!(
            digest("POST", "/a", &json!({"b":2,"a":1})),
            digest("POST", "/a", &json!({"a":1,"b":2}))
        );
        assert_ne!(
            digest("POST", "/a", &json!({"a":1})),
            digest("POST", "/b", &json!({"a":1}))
        );
    }
}
