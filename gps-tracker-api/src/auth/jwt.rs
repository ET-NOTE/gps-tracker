use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, errors::Error, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // user_id as string
    pub exp: i64,
    pub iat: i64,
    pub typ: String, // "access" | "refresh"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>, // refresh 토큰 유일성 보장용 (access는 비움)
}

pub fn issue_access(user_id: i64, secret: &str, ttl_min: i64) -> Result<String, Error> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id.to_string(),
        exp: (now + Duration::minutes(ttl_min)).timestamp(),
        iat: now.timestamp(),
        typ: "access".into(),
        jti: None,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub fn issue_refresh(user_id: i64, secret: &str, ttl_days: i64) -> Result<String, Error> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id.to_string(),
        exp: (now + Duration::days(ttl_days)).timestamp(),
        iat: now.timestamp(),
        typ: "refresh".into(),
        jti: Some(Uuid::new_v4().to_string()),
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub fn verify(token: &str, secret: &str, expected_typ: &str) -> Result<Claims, Error> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )?;
    if data.claims.typ != expected_typ {
        return Err(jsonwebtoken::errors::ErrorKind::InvalidToken.into());
    }
    Ok(data.claims)
}
