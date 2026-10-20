use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};

use crate::{
    auth::jwt,
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IngestMode {
    Signed,
    Phone,
    Legacy,
}

pub fn enabled(key: &str) -> bool {
    std::env::var(key).is_ok_and(|v| matches!(v.as_str(), "1" | "true"))
}

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub async fn signed_response(
    gate: &mut Transaction<'_, Postgres>,
    id: i64,
    counter: i64,
    uid: &str,
    value: &Value,
) -> AppResult<Value> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let key: Vec<u8> =
        sqlx::query_scalar("SELECT key_digest FROM device_credentials WHERE device_id=$1")
            .bind(id)
            .fetch_one(&mut **gate)
            .await?;
    let encoded =
        STANDARD.encode(serde_json::to_vec(value).map_err(|e| AppError::Internal(e.into()))?);
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| AppError::Unauthorized)?;
    mac.update(format!("response\n{uid}\n{counter}\n{encoded}").as_bytes());
    Ok(
        serde_json::json!({"ok":true,"counter":counter,"payload":encoded,
        "signature":format!("{:x}",mac.finalize().into_bytes())}),
    )
}

pub fn claim_hash(code: &str) -> AppResult<String> {
    let clean = code.trim().replace('-', "").to_ascii_lowercase();
    if clean.len() != 20 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest(
            "장치 시리얼 모니터의 등록번호 20자리를 입력해 주세요.".into(),
        ));
    }
    Ok(digest(&clean))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> AppResult<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)
}

fn verify(key: &[u8], uid: &str, counter: i64, body: &[u8], signature: &str) -> AppResult<()> {
    if counter <= 0 || signature.len() != 64 || !signature.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Unauthorized);
    }
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&signature[i * 2..i * 2 + 2], 16)
            .map_err(|_| AppError::Unauthorized)?;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| AppError::Unauthorized)?;
    mac.update(format!("{uid}\n{counter}\n").as_bytes());
    mac.update(body);
    mac.verify_slice(&bytes).map_err(|_| AppError::Unauthorized)
}

/// Hold a dedicated advisory lock until the entire ingest finishes. It serializes
/// activation and legacy requests without holding a device row used by ingest SQL.
pub async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    body: &[u8],
    payload: &Value,
) -> AppResult<(i64, IngestMode, Transaction<'static, Postgres>)> {
    let uid = payload
        .get("device_uid")
        .and_then(Value::as_str)
        .filter(|u| {
            !u.is_empty()
                && u.len() <= 128
                && u.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
        .ok_or_else(|| AppError::BadRequest("device_uid required".into()))?;
    let iccid = payload.get("iccid").and_then(Value::as_str);
    let mut row: Option<(i64, Option<i64>, Option<String>, bool)> = sqlx::query_as(
        "SELECT id,owner_id,device_kind,ingest_legacy_allowed FROM devices
         WHERE device_uid=$1 OR ($2::text IS NOT NULL AND iccid=$2)
         ORDER BY (device_uid=$1) DESC LIMIT 1",
    )
    .bind(uid)
    .bind(iccid)
    .fetch_optional(&state.db)
    .await?;
    if row.is_none()
        && enabled("GPS_KC_INGEST_ENABLED")
        && payload.get("phone").is_none()
        && !headers.contains_key("x-gps-signature")
    {
        row = Some(sqlx::query_as(
            "INSERT INTO devices(device_uid,api_key_hash,iccid,ingest_legacy_allowed)
             VALUES($1,'',$2,true) ON CONFLICT(device_uid) DO UPDATE SET device_uid=EXCLUDED.device_uid
             RETURNING id,owner_id,device_kind,ingest_legacy_allowed")
            .bind(uid).bind(iccid).fetch_one(&state.db).await?);
    }
    let (id, owner, kind, legacy) = row.ok_or(AppError::Unauthorized)?;
    let mut gate = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(id)
        .execute(&mut *gate)
        .await?;
    if kind.as_deref() == Some("phone") {
        let token = header(headers, "authorization")?
            .strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?;
        let claims = jwt::verify(token, &state.config.jwt_secret, "access")
            .map_err(|_| AppError::Unauthorized)?;
        if claims.sub.parse::<i64>().ok() != owner
            || owner.is_none()
            || payload.get("phone").is_none()
            || payload.get("l80").is_some()
            || payload.get("lte").is_some()
            || payload.get("fixes").is_some()
        {
            return Err(AppError::Forbidden);
        }
        return Ok((id, IngestMode::Phone, gate));
    }
    let credential: Option<(Vec<u8>, Option<chrono::DateTime<chrono::Utc>>)> =
        sqlx::query_as("SELECT key_digest,activated_at FROM device_credentials WHERE device_id=$1")
            .bind(id)
            .fetch_optional(&mut *gate)
            .await?;
    if headers.contains_key("x-gps-signature") {
        let (key, _) = credential.ok_or(AppError::Unauthorized)?;
        if header(headers, "x-gps-uid")? != uid {
            return Err(AppError::Unauthorized);
        }
        let counter: i64 = header(headers, "x-gps-counter")?
            .parse()
            .map_err(|_| AppError::Unauthorized)?;
        verify(
            &key,
            uid,
            counter,
            body,
            header(headers, "x-gps-signature")?,
        )?;
        let updated = sqlx::query(
            "UPDATE device_credentials SET last_counter=$2,
            activated_at=COALESCE(activated_at,now()) WHERE device_id=$1 AND last_counter<$2",
        )
        .bind(id)
        .bind(counter)
        .execute(&mut *gate)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(AppError::Conflict("replayed device request".into()));
        }
        return Ok((id, IngestMode::Signed, gate));
    }
    if legacy
        && (enabled("GPS_LEGACY_INGEST_ENABLED") || enabled("GPS_KC_INGEST_ENABLED"))
        && credential.is_none_or(|(_, at)| at.is_none())
        && payload.get("phone").is_none()
    {
        return Ok((id, IngestMode::Legacy, gate));
    }
    Err(AppError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_signature_binds_identity_counter_and_exact_body() {
        let key = Sha256::digest(b"per-device-secret");
        let body = br#"{"vbat_mv":4000}"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        mac.update(b"sim-test\n42\n");
        mac.update(body);
        let sig = format!("{:x}", mac.finalize().into_bytes());
        assert!(verify(&key, "sim-test", 42, body, &sig).is_ok());
        assert!(verify(&key, "sim-other", 42, body, &sig).is_err());
        assert!(verify(&key, "sim-test", 43, body, &sig).is_err());
        assert!(verify(&key, "sim-test", 42, b"changed", &sig).is_err());
        assert!(verify(&key, "sim-test", 42, body, &"g".repeat(64)).is_err());
    }
}
