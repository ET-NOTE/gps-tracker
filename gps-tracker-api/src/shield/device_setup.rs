use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bootstrap {}

// Exposed only by the HTTPS vhost. No account, SIM identity or shared firmware
// secret proves ownership: the separate one-use code must be claimed in a session.
pub async fn bootstrap(State(app): State<App>, Json(_): Json<Bootstrap>) -> Result<String> {
    auth::rate(&app, "device-bootstrap".into(), 60).await?;
    let mut tx = app.db.begin().await?;
    // Bound anonymous pending records across concurrent requests.
    sqlx::query("SELECT pg_advisory_xact_lock(736443,14)").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM devices d USING device_enrollments e WHERE d.id=e.device_id AND d.owner_id IS NULL AND e.expires_at<now()")
        .execute(&mut *tx).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM device_enrollments")
        .fetch_one(&mut *tx).await?;
    if count >= 512 {
        return Err(Error(StatusCode::TOO_MANY_REQUESTS, "잠시 후 장치 연결을 다시 시도해 주세요.".into()));
    }
    let uid = format!("uno-shield-{}", Uuid::new_v4().simple());
    let key = secret();
    let code = hash(&secret())[..16].to_string();
    let id: i64 = sqlx::query_scalar("INSERT INTO devices(device_uid,display_name,key_hash,claim_hash) VALUES($1,'등록 대기 쉴드',$2,$3) RETURNING id")
        .bind(&uid).bind(hash(&key)).bind(hash(&code)).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO device_enrollments(device_id,expires_at) VALUES($1,now()+interval '24 hours')")
        .bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    // Fixed 126-byte ASCII protocol keeps the UNO response buffer small.
    // Credentials never appear in URLs, logs, browser APIs or database plaintext.
    Ok(format!("{uid}\n{key}\n{code}\n"))
}
