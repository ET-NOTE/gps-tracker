use crate::error::AppResult;
use serde_json::{json, Value};
use sqlx::PgPool;

// The caller holds the SIM advisory lock throughout evaluation, ingestion and
// response. Commit control metadata before nested telemetry transactions run.
pub async fn evaluate(
    db: &PgPool,
    id: i64,
    uid: &str,
    signed: bool,
    blocked: bool,
    payload: &Value,
) -> AppResult<(bool, Value)> {
    let capable = signed && payload["collection"]["version"] == 1;
    if capable && !blocked {
        sqlx::query("UPDATE device_data_controls SET collection_enforced=true WHERE device_id=$1 AND NOT collection_enforced")
            .bind(id).execute(db).await?;
    }
    let (paused,enforced,epoch):(bool,bool,String)=sqlx::query_as(
        "SELECT collection_paused,collection_enforced,collection_epoch::text FROM device_data_controls WHERE device_id=$1")
        .bind(id).fetch_one(db).await?;
    let matched = capable
        && payload["collection"]["epoch"].as_str() == Some(&epoch)
        && payload["collection"]["paused"].as_bool() == Some(paused);
    if matched && !blocked {
        sqlx::query("UPDATE device_data_controls SET collection_ack_epoch=collection_epoch,collection_ack_uid=$2,collection_ack_at=now() WHERE device_id=$1")
            .bind(id).bind(uid).execute(db).await?;
    }
    let store = !blocked
        && !paused
        && (!enforced || (matched && fresh(payload)))
        && !payload["collection"]["control_only"]
            .as_bool()
            .unwrap_or(false);
    let policy = json!({"version":1,"epoch":epoch,"paused":paused||blocked,"sim":payload["iccid"],"restricted":blocked});
    Ok((store, policy))
}

// A new epoch alone must not make a stale buffer acceptable. Firmware also
// reports the boot-local collection boundary; uint32 elapsed handles rollover.
fn fresh(p: &Value) -> bool {
    let c = &p["collection"];
    let u32_value = |v: &Value| v.as_u64().and_then(|n| u32::try_from(n).ok());
    let (Some(now), Some(since)) = (u32_value(&c["uptime_ms"]), u32_value(&c["since_ms"])) else {
        return false;
    };
    let elapsed = now.wrapping_sub(since);
    let valid = |at: u32| now.wrapping_sub(at) <= elapsed && now.wrapping_sub(at) <= 300_000;
    if p["l80"]["fix"] == true && !u32_value(&c["fix_up_ms"]).is_some_and(valid) {
        return false;
    }
    // This protocol is implemented by the GNSS firmware, not arbitrary sources.
    if p.get("phone").is_some() || p.get("lte").is_some() {
        return false;
    }
    if let Some(fixes) = p.get("fixes") {
        let Some(fixes) = fixes.as_array() else {
            return false;
        };
        if fixes.iter().any(|f| {
            !u32_value(&f["up_ms"]).is_some_and(valid)
                || f["age_ms"]
                    .as_u64()
                    .is_none_or(|a| a > u64::from(elapsed.min(300_000)))
        }) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collection_boundary_and_wrap() {
        let mut p = json!({"collection":{"uptime_ms":2000,"since_ms":1000,"fix_up_ms":1500},"l80":{"fix":true},"fixes":[{"up_ms":1500,"age_ms":500}]});
        assert!(fresh(&p));
        p["fixes"][0]["up_ms"] = json!(999);
        assert!(!fresh(&p));
        p["fixes"] = json!([]);
        p["collection"]["fix_up_ms"] = json!(999);
        assert!(!fresh(&p));
        p["collection"] = json!({"uptime_ms":10,"since_ms":u32::MAX-50,"fix_up_ms":u32::MAX-10});
        assert!(fresh(&p));
        p["collection"]["since_ms"] = Value::Null;
        assert!(!fresh(&p));
    }
}
