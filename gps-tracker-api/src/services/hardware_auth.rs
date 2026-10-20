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
    let changed=sqlx::query("UPDATE hardware_credentials SET last_counter=$2,activated_at=COALESCE(activated_at,now()),last_seen_at=now() WHERE auth_uid=$1 AND last_counter<$2")
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
    let sim_owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if owner.is_some() && owner == sim_owner {
        Ok((id, IngestMode::Hardware, tx))
    } else {
        Ok((id, IngestMode::HardwarePending, tx))
    }
}

/// Publish foreign-key bindings after ingest releases its device row locks.
/// Both hardware and SIM advisory locks remain held by the outer transaction.
pub async fn finish(
    tx: &mut Transaction<'_, Postgres>,
    id: i64,
    uid: &str,
    mode: IngestMode,
    payload: &Value,
) -> AppResult<()> {
    if let Some(hash) = payload["pairing_hash"]
        .as_str()
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        sqlx::query("UPDATE hardware_credentials SET pending_device_id=$2,claim_code_hash=$3,
           claim_issued_at=CASE WHEN claim_code_hash IS DISTINCT FROM $3 OR pending_device_id IS DISTINCT FROM $2 THEN now() ELSE claim_issued_at END,
           claim_expires_at=CASE WHEN claim_code_hash IS DISTINCT FROM $3 OR pending_device_id IS DISTINCT FROM $2 THEN now()+interval '24 hours' ELSE claim_expires_at END
           WHERE auth_uid=$1 AND last_claim_code_hash IS DISTINCT FROM $3")
            .bind(uid).bind(id).bind(hash.to_ascii_lowercase()).execute(&mut **tx).await?;
    }

    if mode == IngestMode::Hardware {
        sqlx::query("UPDATE hardware_credentials SET current_device_id=$2 WHERE auth_uid=$1")
            .bind(uid)
            .bind(id)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE devices SET active_auth_uid=$2,sim_auth_required=true WHERE id=$1")
            .bind(id)
            .bind(uid)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// SIM selects the records; the private code authorizes the presenting hardware.
pub async fn pair_by_sim(
    state: &AppState,
    user: i64,
    sim: i64,
    input: &str,
    name: &str,
) -> AppResult<Option<i64>> {
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM devices WHERE id=$1")
        .bind(sim)
        .fetch_one(&state.db)
        .await?;
    if owner.is_some_and(|v| v != user) {
        return Err(AppError::Conflict(
            "이미 다른 계정에 연결된 SIM입니다.".into(),
        ));
    }
    // A short suffix is lookup convenience for the existing owner, never first-claim proof.
    if input.trim().len() < 19 {
        if owner == Some(user) {
            return Ok(None);
        }
        return Err(AppError::BadRequest(
            "처음 등록할 때는 SIM 전체 번호 19~20자리를 입력해 주세요.".into(),
        ));
    }
    let candidates:Vec<String>=sqlx::query_scalar("SELECT auth_uid FROM hardware_credentials WHERE pending_device_id=$1 AND last_seen_at>now()-interval '5 minutes' AND last_seen_at>=(SELECT claim_not_before FROM devices WHERE id=$1) AND activated_at IS NOT NULL AND (authorized_owner_id IS NULL OR authorized_owner_id=$2 OR ($3::boolean AND current_device_id=$1)) ORDER BY last_seen_at DESC")
        .bind(sim).bind(user).bind(owner.is_none()).fetch_all(&state.db).await?;
    if candidates.is_empty() {
        if owner == Some(user) {
            return Ok(None);
        }
        return Err(AppError::BadRequest(
            "인증된 운영 펌웨어로 단말기를 켜고 LTE 연결 후 SIM 전체 번호를 다시 입력해 주세요."
                .into(),
        ));
    }
    // Prefer the new, as-yet unassigned hardware over previously linked hardware.
    let unassigned:Vec<String>=sqlx::query_scalar("SELECT auth_uid FROM hardware_credentials WHERE auth_uid=ANY($1) AND authorized_owner_id IS NULL")
        .bind(&candidates).fetch_all(&state.db).await?;
    let choices = if unassigned.is_empty() {
        &candidates
    } else {
        &unassigned
    };
    if choices.len() != 1 {
        return Err(AppError::BadRequest("같은 SIM으로 최근 연결된 단말기가 여러 대입니다. 이전 단말기의 전원을 끄고 5분 후 다시 시도해 주세요.".into()));
    }
    let uid = &choices[0];
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('gps-hardware:'||$1,0))")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(sim)
        .execute(&mut *tx)
        .await?;
    let current: Option<i64> =
        sqlx::query_scalar("SELECT owner_id FROM devices WHERE id=$1 FOR UPDATE")
            .bind(sim)
            .fetch_one(&mut *tx)
            .await?;
    if current.is_some_and(|v| v != user) {
        return Err(AppError::Conflict(
            "이미 다른 계정에 연결된 SIM입니다.".into(),
        ));
    }
    let valid:bool=sqlx::query_scalar("SELECT COALESCE(pending_device_id=$2 AND last_seen_at>now()-interval '5 minutes' AND last_seen_at>=(SELECT claim_not_before FROM devices WHERE id=$2) AND activated_at IS NOT NULL AND (authorized_owner_id IS NULL OR authorized_owner_id=$3 OR ($4::boolean AND current_device_id=$2)),false) FROM hardware_credentials WHERE auth_uid=$1")
        .bind(uid).bind(sim).bind(user).bind(current.is_none()).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(AppError::BadRequest(
            "SIM 연결 상태가 바뀌었습니다. 다시 시도해 주세요.".into(),
        ));
    }
    sqlx::query("UPDATE hardware_credentials SET authorized_owner_id=$2,current_device_id=$3,claim_code_hash=NULL,claim_expires_at=NULL,pending_device_id=NULL WHERE auth_uid=$1")
        .bind(uid).bind(user).bind(sim).execute(&mut *tx).await?;
    sqlx::query("UPDATE devices SET owner_id=$2,display_name=$3,paired_at=COALESCE(paired_at,now()),active_auth_uid=$4,sim_auth_required=true WHERE id=$1")
        .bind(sim).bind(user).bind(name).bind(uid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(sim))
}

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
    sqlx::query("UPDATE hardware_credentials SET authorized_owner_id=$2,current_device_id=$3,last_claim_code_hash=$4,claim_code_hash=NULL,claim_expires_at=NULL,pending_device_id=NULL WHERE auth_uid=$1")
        .bind(&uid).bind(user).bind(sim).bind(proof).execute(&mut *tx).await?;
    sqlx::query("UPDATE devices SET owner_id=$2,display_name=$3,paired_at=COALESCE(paired_at,now()),active_auth_uid=$4,sim_auth_required=true WHERE id=$1")
        .bind(sim).bind(user).bind(name).bind(uid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(sim))
}
