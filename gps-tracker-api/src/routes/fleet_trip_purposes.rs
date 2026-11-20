use crate::{
    auth::{fleet::FleetScope, AuthUser},
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::{get, put},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/trip-purposes", get(list).post(create))
        .route("/corporate/trip-purposes/:id", put(update).delete(remove))
}

#[derive(Deserialize)]
struct Fields {
    name: String,
    active: bool,
    updated_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
struct Version {
    updated_at: DateTime<Utc>,
}

// None is the old client's omitted field. Some(None) deliberately unlinks it.
pub(crate) fn read_link<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
    Option::<i64>::deserialize(d).map(Some)
}

pub(crate) async fn validate_link(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    target: Option<i64>,
    previous: Option<i64>,
) -> AppResult<()> {
    let Some(id) = target else { return Ok(()); };
    let active: Option<bool> = sqlx::query_scalar(
        "SELECT active FROM fleet_trip_purposes WHERE owner_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(owner).bind(id).fetch_optional(&mut **tx).await?;
    if active == Some(true) || (active == Some(false) && previous == Some(id)) {
        Ok(())
    } else {
        Err(AppError::BadRequest("사용 가능한 회사 운행 목적을 선택해 주세요.".into()))
    }
}

fn admin(scope: &Option<Extension<FleetScope>>) -> AppResult<()> {
    if scope.as_ref().is_none_or(|s| s.permits("manage_team")) {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}
fn normalized_name(name: &str) -> AppResult<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > 50 {
        Err(AppError::BadRequest("운행 목적 이름을 1~50자로 입력해 주세요.".into()))
    } else { Ok(name) }
}
fn save_error(error: sqlx::Error) -> AppError {
    if error.as_database_error().is_some_and(|e| e.constraint() == Some("fleet_trip_purposes_company_name")) {
        AppError::Conflict("같은 이름의 운행 목적이 있습니다.".into())
    } else { error.into() }
}
async fn list(State(state): State<AppState>, user: AuthUser, scope: Option<Extension<FleetScope>>) -> AppResult<Json<Vec<Value>>> {
    // Team-wide aggregate usage is visible only to company settings managers.
    let items = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',p.id,'name',p.name,'active',p.active,'updated_at',p.updated_at,
          'reservation_count',CASE WHEN $2 THEN (SELECT count(*) FROM vehicle_reservations r WHERE r.user_id=p.owner_id AND r.company_purpose_id=p.id) END,
          'trip_count',CASE WHEN $2 THEN (SELECT count(*) FROM trip_annotations a WHERE a.user_id=p.owner_id AND a.company_purpose_id=p.id) END)
          FROM fleet_trip_purposes p WHERE p.owner_id=$1 ORDER BY p.active DESC,p.name,p.id",
    )
    .bind(user.user_id).bind(admin(&scope).is_ok()).fetch_all(&state.db).await?;
    Ok(Json(items))
}
async fn create(State(state): State<AppState>, user: AuthUser, scope: Option<Extension<FleetScope>>, Json(input): Json<Fields>) -> AppResult<Json<Value>> {
    admin(&scope)?;
    let row = sqlx::query_scalar("INSERT INTO fleet_trip_purposes(owner_id,name,active) VALUES($1,$2,$3) RETURNING to_jsonb(fleet_trip_purposes)-'owner_id'")
        .bind(user.user_id).bind(normalized_name(&input.name)?).bind(input.active)
        .fetch_one(&state.db).await.map_err(save_error)?;
    Ok(Json(row))
}
async fn lock_version(tx: &mut Transaction<'_, Postgres>, owner: i64, id: i64, expected: Option<DateTime<Utc>>) -> AppResult<()> {
    let current: DateTime<Utc> = sqlx::query_scalar("SELECT updated_at FROM fleet_trip_purposes WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner).bind(id).fetch_optional(&mut **tx).await?.ok_or(AppError::NotFound)?;
    if expected != Some(current) {
        return Err(AppError::Conflict("운행 목적이 변경됐습니다. 목록을 다시 확인해 주세요.".into()));
    }
    Ok(())
}
async fn update(State(state): State<AppState>, user: AuthUser, Path(id): Path<i64>, scope: Option<Extension<FleetScope>>, Json(input): Json<Fields>) -> AppResult<Json<Value>> {
    admin(&scope)?;
    let name = normalized_name(&input.name)?;
    let mut tx = state.db.begin().await?;
    lock_version(&mut tx,user.user_id,id,input.updated_at).await?;
    let row = sqlx::query_scalar("UPDATE fleet_trip_purposes SET name=$3,active=$4,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING to_jsonb(fleet_trip_purposes)-'owner_id'")
        .bind(user.user_id).bind(id).bind(name).bind(input.active)
        .fetch_one(&mut *tx).await.map_err(save_error)?;
    tx.commit().await?;
    Ok(Json(row))
}
async fn remove(State(state): State<AppState>, user: AuthUser, Path(id): Path<i64>, scope: Option<Extension<FleetScope>>, Query(v): Query<Version>) -> AppResult<Json<Value>> {
    admin(&scope)?;
    let mut tx = state.db.begin().await?;
    lock_version(&mut tx,user.user_id,id,Some(v.updated_at)).await?;
    let used: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vehicle_reservations WHERE user_id=$1 AND company_purpose_id=$2) OR EXISTS(SELECT 1 FROM trip_annotations WHERE user_id=$1 AND company_purpose_id=$2)")
        .bind(user.user_id).bind(id).fetch_one(&mut *tx).await?;
    if used {
        sqlx::query("UPDATE fleet_trip_purposes SET active=false,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND active")
            .bind(user.user_id).bind(id).execute(&mut *tx).await?;
    } else {
        sqlx::query("DELETE FROM fleet_trip_purposes WHERE owner_id=$1 AND id=$2")
            .bind(user.user_id).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"id":id,"archived":used})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_normalized_and_count_unicode_characters() {
        assert_eq!(normalized_name("  외부   방문  ").unwrap(), "외부 방문");
        assert!(normalized_name(&"가".repeat(50)).is_ok());
        assert!(normalized_name(&"가".repeat(51)).is_err());
        assert!(normalized_name(" \t ").is_err());
    }
    #[test]
    fn missing_and_cleared_links_are_distinct() {
        #[derive(Deserialize)]
        struct Patch {
            #[serde(default, deserialize_with="read_link")]
            company_purpose_id: Option<Option<i64>>,
        }
        for (v, expected) in [(json!({}),None),(json!({"company_purpose_id":null}),Some(None)),(json!({"company_purpose_id":8}),Some(Some(8)))] {
            assert_eq!(serde_json::from_value::<Patch>(v).unwrap().company_purpose_id,expected);
        }
    }
}
