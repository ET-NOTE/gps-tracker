use super::{principal, FleetScope};
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    services::fleet_mail,
    state::AppState,
};
use axum::{extract::State, routing::get, Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/notification-policy", get(policy).put(update))
        .route("/corporate/notification-results", get(results))
        .route("/corporate/notification-mail-preview", get(mail_preview))
}

const KEYS: [&str; 7] = [
    "reservation",
    "trip",
    "maintenance",
    "connection",
    "expense",
    "in_app",
    "email",
];

fn response(settings: &Value, revision: i64) -> Value {
    let mode = fleet_mail::mode();
    let mut output =
        json!({"revision":revision,"email_available":mode!="unavailable","email_mode":mode});
    for key in KEYS {
        output[key] = json!(settings[key].as_bool().unwrap_or(key != "email"));
    }
    output
}

async fn read(pool: &PgPool, owner: i64) -> AppResult<Value> {
    let row: Option<(Value, i64)> =
        sqlx::query_as("SELECT settings,revision FROM fleet_notification_policy WHERE owner_id=$1")
            .bind(owner)
            .fetch_optional(pool)
            .await?;
    let (settings, revision) = row.unwrap_or((Value::Null, 0));
    Ok(response(&settings, revision))
}

async fn policy(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Value>> {
    let scope = principal(&state, user, scope).await?;
    Ok(Json(read(&state.db, scope.owner).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    key: String,
    enabled: bool,
    revision: i64,
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(change): Json<Change>,
) -> AppResult<Json<Value>> {
    let scope = principal(&state, user, scope).await?;
    if scope.actor != scope.owner {
        return Err(AppError::Forbidden);
    }
    let key = change.key.as_str();
    if !KEYS.contains(&key) {
        return Err(AppError::BadRequest("알림 항목을 확인해 주세요.".into()));
    }
    if key == "email" && change.enabled && fleet_mail::mode() == "unavailable" {
        return Err(AppError::BadRequest(
            "메일 발송 서버를 연결한 뒤 사용할 수 있습니다.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO fleet_notification_policy(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
    )
    .bind(scope.owner)
    .execute(&mut *tx)
    .await?;
    let (mut settings, mut revision): (Value, i64) = sqlx::query_as(
        "SELECT settings,revision FROM fleet_notification_policy WHERE owner_id=$1 FOR UPDATE",
    )
    .bind(scope.owner)
    .fetch_one(&mut *tx)
    .await?;
    let old = settings[key].as_bool().unwrap_or(key != "email");
    if old != change.enabled {
        if revision != change.revision {
            return Err(AppError::Conflict(
                "다른 화면에서 알림 설정을 변경했습니다. 최신 설정을 확인해 주세요.".into(),
            ));
        }
        settings[key] = json!(change.enabled);
        revision=sqlx::query_scalar("UPDATE fleet_notification_policy SET settings=$2,revision=revision+1 WHERE owner_id=$1 RETURNING revision")
            .bind(scope.owner).bind(&settings).fetch_one(&mut *tx).await?;
        if !change.enabled && key != "in_app" {
            sqlx::query("UPDATE fleet_notification_mail SET finished_at=now() WHERE owner_id=$1 AND finished_at IS NULL AND ($2='email' OR category=$2)")
                .bind(scope.owner).bind(key).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO fleet_team_audit(owner_id,actor_id,action,before_value,after_value) VALUES($1,$1,'notification_policy',$2,$3)")
            .bind(scope.owner).bind(json!({(key):old})).bind(json!({(key):change.enabled})).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(response(&settings, revision)))
}

// Reuse the same company, vehicle, staff and department boundaries as the
// underlying booking and expense screens; return only status and time.
async fn results(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = principal(&state, user, scope).await?;
    let rows = sqlx::query_scalar(include_str!("fleet_notification_results.sql"))
        .bind(s.owner)
        .bind(&s.vehicles)
        .bind(s.admin())
        .bind(s.staff)
        .bind(s.department)
        .bind(s.role == "department_manager")
        .bind(s.actor)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}

async fn mail_preview(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = principal(&state, user, scope).await?;
    if fleet_mail::mode() != "preview" {
        return Err(AppError::NotFound);
    }
    let rows=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'category',category,'at',finished_at) FROM fleet_notification_mail WHERE owner_id=$1 AND recipient_id=$2 AND preview ORDER BY finished_at DESC,id DESC LIMIT 5")
        .bind(s.owner).bind(s.actor).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_explicit_false_are_distinct() {
        let defaults = response(&Value::Null, 0);
        assert_eq!(defaults["reservation"], true);
        assert_eq!(defaults["in_app"], true);
        assert_eq!(defaults["email"], false);
        let saved = response(&json!({"in_app":false,"trip":false,"expense":true}), 4);
        assert_eq!(saved["in_app"], false);
        assert_eq!(saved["trip"], false);
        assert_eq!(saved["revision"], 4);
    }
}
