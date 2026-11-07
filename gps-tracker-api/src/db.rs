use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

pub async fn make_pool(database_url: &str) -> anyhow::Result<PgPool> {
    let keys = crate::services::location_storage::load()?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Some(Duration::from_secs(60 * 10)))
        // JSON batch/window queries spend seconds compiling hundreds of JIT
        // functions for millisecond-scale scans. Scope this to our API pool;
        // do not change the PostgreSQL defaults used by neighboring services.
        .after_connect(move |connection, _| {
            let keys = keys.clone();
            Box::pin(async move {
                sqlx::query("SET timezone='UTC'")
                    .execute(&mut *connection)
                    .await?;
                if let Some(keys) = keys {
                    let safe: bool = sqlx::query_scalar("SELECT current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0' AND coalesce(current_setting('pgaudit.log_parameter',true),'off') IN ('off','false','0')").fetch_one(&mut *connection).await?;
                    if !safe {
                        return Err(sqlx::Error::Configuration("location keys require database bind-parameter logging disabled".into()));
                    }
                    sqlx::query("SELECT set_config('gps.storage_keys',$1,false)")
                        .bind(keys.as_str())
                        .execute(&mut *connection)
                        .await?;
                }
                sqlx::query("SET jit=off").execute(connection).await?;
                Ok(())
            })
        })
        .connect(database_url)
        .await?;
    Ok(pool)
}

/// Refuse a supposedly restricted runtime that still owns objects or can assume the owner.
pub async fn verify_runtime(pool: &PgPool) -> anyhow::Result<()> {
    let unsafe_role:bool=sqlx::query_scalar("SELECT r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND pg_has_role(current_user,p.proowner,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_roles x WHERE (x.rolsuper OR x.rolcreaterole OR x.rolcreatedb OR x.rolbypassrls) AND pg_has_role(current_user,x.oid,'MEMBER')) OR has_schema_privilege(current_user,'public','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE') FROM pg_roles r WHERE r.rolname=current_user").fetch_one(pool).await?;
    anyhow::ensure!(
        !unsafe_role,
        "API role owns schema objects or retains DDL/elevated capabilities"
    );
    let applied: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT version,checksum FROM _sqlx_migrations WHERE success ORDER BY version",
    )
    .fetch_all(pool)
    .await?;
    let migrations = sqlx::migrate!("./migrations");
    anyhow::ensure!(
        applied.len() == migrations.iter().count(),
        "migration count mismatch; migrate separately"
    );
    for (m, (version, checksum)) in migrations.iter().zip(applied) {
        anyhow::ensure!(
            m.version == version && m.checksum.as_ref() == checksum,
            "migration checksum mismatch"
        );
    }
    Ok(())
}
