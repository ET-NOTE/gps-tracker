use super::*;
use axum::extract::Path;
use chrono::{DateTime, Utc};
use serde::Deserialize;

pub fn valid_uid(value: &str) -> bool {
    value.len() == 37
        && value.starts_with("demo-")
        && value.as_bytes()[5..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

pub async fn get(State(app): State<App>, h: HeaderMap, Path(id): Path<i64>) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    devices::own(&app, user, id).await?;
    let expiry: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT expires_at FROM http_demo_links WHERE device_id=$1 AND owner_id=$2",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&app.db)
    .await?;
    Ok(Json(
        json!({"enabled":expiry.is_some_and(|v|v>Utc::now()),"expires_at":expiry}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    enabled: bool,
}

pub async fn set(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Json(v): Json<Edit>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    auth::rate(&app, format!("http-demo-settings:{user}"), 20).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query_scalar::<_, i64>("SELECT id FROM devices WHERE id=$1 AND owner_id=$2 FOR UPDATE")
        .bind(id)
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(missing)?;
    let mut uid = None;
    let mut expiry = None;
    if v.enabled {
        let fresh = format!("demo-{}", Uuid::new_v4().simple());
        expiry = Some(sqlx::query_scalar::<_, DateTime<Utc>>(
            "INSERT INTO http_demo_links(device_id,owner_id,uid_hash,expires_at) VALUES($1,$2,$3,now()+interval '24 hours') ON CONFLICT(device_id) DO UPDATE SET owner_id=$2,uid_hash=$3,expires_at=now()+interval '24 hours' RETURNING expires_at",
        ).bind(id).bind(user).bind(hash(&fresh)).fetch_one(&mut *tx).await?);
        uid = Some(fresh);
    } else {
        sqlx::query("DELETE FROM http_demo_links WHERE device_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    // Neither the raw educational UID nor an operational key enters the audit log.
    admin::audit(
        &mut tx,
        Some(user),
        "device.http_demo",
        "device",
        &id.to_string(),
        json!({"enabled":v.enabled,"expires_at":expiry}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"enabled":v.enabled,"device_uid":uid,"expires_at":expiry}),
    ))
}
