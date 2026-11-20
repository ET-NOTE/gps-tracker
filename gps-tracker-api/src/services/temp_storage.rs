//! SQL-side guard for a provisioned protected temporary tablespace.
//! This cannot attest filesystem encryption or swap policy: the host preflight
//! must verify those independently. Unconfigured pilots remain unqualified.
use sqlx::PgConnection;

fn validate(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        && name != "pg_default"
        && name != "pg_global"
}

pub fn configured() -> anyhow::Result<Option<String>> {
    let name = match std::env::var("GPS_LOCATION_TEMP_TABLESPACE") {
        Ok(name) => name,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(_) => anyhow::bail!("invalid protected temporary tablespace setting"),
    };
    anyhow::ensure!(
        validate(&name),
        "a single dedicated temporary tablespace is required"
    );
    Ok(Some(name))
}

pub async fn configure(
    connection: &mut PgConnection,
    name: Option<&str>,
) -> Result<(), sqlx::Error> {
    let Some(name) = name else {
        return Ok(());
    };
    // PostgreSQL can ignore a missing/inaccessible role-configured tablespace
    // and silently spill into pg_default. Check on EVERY pool checkout, then
    // SET interactively; failures discard the connection and block the request.
    let allowed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_tablespace WHERE spcname=$1 AND has_tablespace_privilege(current_user,oid,'CREATE'))")
        .bind(name).fetch_one(&mut *connection).await?;
    if !allowed {
        return Err(sqlx::Error::Configuration(
            "protected temporary tablespace unavailable".into(),
        ));
    }
    sqlx::query("SELECT set_config('temp_tablespaces',$1,false)")
        .bind(name)
        .execute(connection)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cannot_configure_default_or_fallback_list() {
        for bad in [
            "",
            "pg_default",
            "pg_global",
            "private,pg_default",
            "private,",
            "\"\"",
            "../tmp",
            "temp;RESET ALL",
            "T",
        ] {
            assert!(!validate(bad));
        }
        assert!(validate("gps_private_temp"));
        assert!(!validate(&"a".repeat(64)));
    }
}
