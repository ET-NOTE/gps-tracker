use super::{
    device_auth::{self, IngestMode},
    sim_identity,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use axum::http::HeaderMap;
use serde_json::Value;
use sqlx::{Postgres, Transaction};

pub async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    body: &[u8],
    payload: &Value,
) -> AppResult<(i64, IngestMode, Transaction<'static, Postgres>)> {
    if payload.get("phone").is_some() {
        return Err(AppError::Forbidden);
    }
    let uid = device_auth::header(headers, "x-gps-uid")?;
    let counter: i64 = device_auth::header(headers, "x-gps-counter")?
        .parse()
        .map_err(|_| AppError::Unauthorized)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('gps-hardware:'||$1,0))")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    let (key, owner): (Vec<u8>, Option<i64>) = sqlx::query_as(
        "SELECT key_digest,authorized_owner_id FROM hardware_credentials WHERE auth_uid=$1",
    )
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::Unauthorized)?;
    device_auth::verify(
        &key,
        uid,
        counter,
        body,
        device_auth::header(headers, "x-gps-signature")?,
    )?;
    let changed=sqlx::query("UPDATE hardware_credentials SET last_counter=$2,activated_at=COALESCE(activated_at,now()) WHERE auth_uid=$1 AND last_counter<$2")
        .bind(uid).bind(counter).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Err(AppError::Conflict("replayed hardware request".into()));
    }
    let iccid = sim_identity::canonical(
        payload["iccid"]
            .as_str()
            .ok_or_else(|| AppError::BadRequest("full SIM number required".into()))?,
    )?;
    // One logical device per SIM, regardless of the modem or the hardware signing key.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('gps-sim:'||$1,0))")
        .bind(&iccid)
        .execute(&mut *tx)
        .await?;
    let id =
        match sim_identity::find(&state.db, &iccid).await? {
            Some(id) => id,
            None => sqlx::query_scalar(
                "INSERT INTO devices(device_uid,iccid,api_key_hash) VALUES($1,$2,'') RETURNING id",
            )
            .bind(format!("sim-{iccid}"))
            .bind(&iccid)
            .fetch_one(&state.db)
            .await?,
        };
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if let Some(hash) = payload["pairing_hash"]
        .as_str()
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        sqlx::query("UPDATE hardware_credentials SET pending_device_id=$2,claim_code_hash=$3,
           claim_issued_at=CASE WHEN claim_code_hash IS DISTINCT FROM $3 OR pending_device_id IS DISTINCT FROM $2 THEN now() ELSE claim_issued_at END,
           claim_expires_at=CASE WHEN claim_code_hash IS DISTINCT FROM $3 OR pending_device_id IS DISTINCT FROM $2 THEN now()+interval '24 hours' ELSE claim_expires_at END
           WHERE auth_uid=$1 AND last_claim_code_hash IS DISTINCT FROM $3")
            .bind(uid).bind(id).bind(hash.to_ascii_lowercase()).execute(&mut *tx).await?;
    }
    let sim_owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if owner.is_some() && owner == sim_owner {
        sqlx::query("UPDATE hardware_credentials SET current_device_id=$2 WHERE auth_uid=$1")
            .bind(uid)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE devices SET active_auth_uid=$2 WHERE id=$1")
            .bind(id)
            .bind(uid)
            .execute(&state.db)
            .await?;
        Ok((id, IngestMode::Hardware, tx))
    } else {
        Ok((id, IngestMode::HardwarePending, tx))
    }
}

/// SIM selects the records; the private code authorizes the presenting hardware.
pub async fn pair(
    state: &AppState,
    user: i64,
    sim: i64,
    proof: &str,
    name: &str,
) -> AppResult<Option<i64>> {
    let auth: Option<String> = sqlx::query_scalar(
        "SELECT auth_uid FROM hardware_credentials WHERE
        (claim_code_hash=$1 AND claim_expires_at>now()) OR
        (last_claim_code_hash=$1 AND authorized_owner_id=$2 AND current_device_id=$3)",
    )
    .bind(proof)
    .bind(user)
    .bind(sim)
    .fetch_optional(&state.db)
    .await?;
    let Some(uid) = auth else { return Ok(None) };
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('gps-hardware:'||$1,0))")
        .bind(&uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(sim)
        .execute(&mut *tx)
        .await?;
    let (owner, cutoff): (Option<i64>, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT owner_id,claim_not_before FROM devices WHERE id=$1 FOR UPDATE")
            .bind(sim)
            .fetch_one(&mut *tx)
            .await?;
    if owner.is_some_and(|v| v != user) {
        return Err(AppError::Conflict(
            "이미 다른 계정에 연결된 SIM입니다.".into(),
        ));
    }
    let valid:bool=sqlx::query_scalar("SELECT COALESCE((pending_device_id=$2 AND claim_code_hash=$3 AND claim_expires_at>now() AND claim_issued_at>=$5)
        OR (last_claim_code_hash=$3 AND authorized_owner_id=$4 AND current_device_id=$2 AND $6::boolean)
        ,false) FROM hardware_credentials WHERE auth_uid=$1")
        .bind(&uid).bind(sim).bind(proof).bind(user).bind(cutoff).bind(owner==Some(user)).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(AppError::BadRequest("SIM 번호와 단말기의 연결 확인번호가 일치하지 않습니다. 연결 해제 후에는 REGISTER로 새 번호를 확인해 주세요.".into()));
    }
    sqlx::query("UPDATE hardware_credentials SET authorized_owner_id=$2,current_device_id=$3,last_claim_code_hash=COALESCE(claim_code_hash,last_claim_code_hash),claim_code_hash=NULL,claim_expires_at=NULL,pending_device_id=NULL WHERE auth_uid=$1")
        .bind(&uid).bind(user).bind(sim).execute(&mut *tx).await?;
    sqlx::query("UPDATE devices SET owner_id=$2,display_name=$3,paired_at=COALESCE(paired_at,now()),active_auth_uid=$4 WHERE id=$1")
        .bind(sim).bind(user).bind(name).bind(uid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(sim))
}
