//! Core location field encryption pilot. Keys never go in a database table or
//! a command-line argument. PostgreSQL performs OpenPGP AES-256 + MDC operations;
//! this protects stored data/backups, not a compromised API or database superuser.
use anyhow::{ensure, Context};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path, sync::Arc};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Keyring {
    active: String,
    keys: BTreeMap<String, String>,
}

fn validate(contents: &str) -> anyhow::Result<()> {
    let ring: Keyring = serde_json::from_str(contents).context("invalid location keyring")?;
    ensure!(
        !ring.keys.is_empty() && ring.keys.len() <= 16 && ring.keys.contains_key(&ring.active),
        "invalid active location key"
    );
    let mut unique = std::collections::HashSet::new();
    for (id, key) in &ring.keys {
        ensure!(
            !id.is_empty()
                && id.len() <= 40
                && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "invalid location key identifier"
        );
        let bytes = STANDARD
            .decode(key)
            .context("invalid location key encoding")?;
        ensure!(
            bytes.len() == 32 && STANDARD.encode(&bytes) == *key && unique.insert(bytes),
            "location keys must be distinct 256-bit values"
        );
    }
    Ok(())
}

pub fn load() -> anyhow::Result<Option<Arc<String>>> {
    let mode = std::env::var("GPS_LOCATION_ENCRYPTION").unwrap_or_else(|_| "off".into());
    ensure!(
        matches!(mode.as_str(), "off" | "pilot"),
        "location encryption mode must be off or pilot"
    );
    if mode == "off" {
        return Ok(None);
    }
    let path =
        std::env::var("GPS_LOCATION_KEYRING_FILE").context("location keyring file required")?;
    let metadata =
        std::fs::symlink_metadata(Path::new(&path)).context("location keyring metadata")?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 8192,
        "location keyring must be a small regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "location keyring must not be group/world readable"
        );
    }
    let contents = std::fs::read_to_string(path).context("location keyring file")?;
    validate(&contents)?;
    Ok(Some(Arc::new(contents)))
}

pub async fn verify(pool: &sqlx::PgPool, configured: bool) -> anyhow::Result<()> {
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM location_storage_policy WHERE singleton")
            .fetch_one(pool)
            .await?;
    ensure!(
        enabled == configured,
        "location storage policy/key configuration mismatch; never fall back to plaintext"
    );
    let maintenance: bool =
        sqlx::query_scalar("SELECT maintenance FROM location_storage_policy WHERE singleton")
            .fetch_one(pool)
            .await?;
    ensure!(
        !maintenance,
        "location storage maintenance: refusing API startup"
    );
    if enabled {
        // An authenticated round-trip at startup also detects a bad active key.
        let good: bool = sqlx::query_scalar("SELECT gps_open_cell(gps_seal_cell('\"startup\"'::jsonb,'startup'),'startup')='\"startup\"'::jsonb").fetch_one(pool).await?;
        ensure!(good, "location encryption self-test failed");
        // Historic key IDs are checked by the conversion/readiness tool. A missing
        // historic key or damaged cell causes that read to fail, never return NULL.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyring_is_bounded_and_validated() {
        let key = STANDARD.encode([42u8; 32]);
        assert!(
            validate(&serde_json::json!({"active":"v1","keys":{"v1":key}}).to_string()).is_ok()
        );
        for bad in [
            serde_json::json!({"active":"missing","keys":{"v1":key}}),
            serde_json::json!({"active":"v1","keys":{"v1":"short"}}),
            serde_json::json!({"active":"v1","keys":{"v1":key,"v2":key}}),
            serde_json::json!({"active":"v1","keys":{"v1":key},"password":"no"}),
        ] {
            assert!(validate(&bad.to_string()).is_err());
        }
    }
}
