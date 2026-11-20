use super::{conflict, lock, log, principal};
use crate::{
    auth::{
        fleet::{FleetScope, GROUP_PERMISSIONS},
        AuthUser,
    },
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::{get, put},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn group_fields_cannot_enable_account_or_billing_management() {
        for key in ["owner","billing","manage_team","unknown"] {
            let mut group=Group{name:" 제한 ".into(),permissions:vec![key.into()],updated_at:None};
            assert!(group.validate().is_err());
        }
        let mut read_only=Group{name:"  조회 ".into(),permissions:vec![],updated_at:None};
        assert!(read_only.validate().is_ok());
        assert_eq!(read_only.name,"조회");
        assert!(serde_json::from_value::<Assignment>(json!({"members":[]})).is_err());
        assert!(serde_json::from_value::<Assignment>(json!({"group_id":null,"members":[]})).is_ok());
    }
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/permission-groups", get(list).post(create))
        .route("/corporate/permission-groups/assignment", put(assign))
        .route(
            "/corporate/permission-groups/:id",
            put(update).delete(remove),
        )
}

async fn owner(
    state: &AppState,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<i64> {
    let s = principal(state, user, scope).await?;
    if s.owner != s.actor {
        return Err(AppError::Forbidden);
    }
    Ok(s.owner)
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let owner = owner(&state, user, scope).await?;
    let groups=sqlx::query_scalar("SELECT to_jsonb(g)-'owner_id'||jsonb_build_object('members',(SELECT count(*) FROM staff s WHERE s.user_id=g.owner_id AND s.permission_group_id=g.id)) FROM fleet_permission_groups g WHERE g.owner_id=$1 ORDER BY g.name,g.id")
        .bind(owner).fetch_all(&state.db).await?;
    Ok(Json(groups))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    name: String,
    permissions: Vec<String>,
    updated_at: Option<DateTime<Utc>>,
}
impl Group {
    fn validate(&mut self) -> AppResult<()> {
        self.name = self.name.trim().to_owned();
        if self.name.is_empty() || self.name.chars().count() > 60 {
            return Err(AppError::BadRequest(
                "그룹명은 1~60자로 입력해 주세요.".into(),
            ));
        }
        if self.permissions.len() > GROUP_PERMISSIONS.len()
            || self
                .permissions
                .iter()
                .any(|p| !GROUP_PERMISSIONS.contains(&p.as_str()))
        {
            return Err(AppError::BadRequest(
                "지원되지 않는 그룹 권한입니다.".into(),
            ));
        }
        self.permissions.sort();
        self.permissions.dedup();
        Ok(())
    }
}
fn changed() -> AppError {
    AppError::Conflict(
        "권한 또는 사용자 정보가 변경되었습니다. 새로고침 후 다시 시도해 주세요.".into(),
    )
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(group): Json<Group>,
) -> AppResult<Json<Value>> {
    save(&state, owner(&state, user, scope).await?, None, group)
        .await
        .map(Json)
}
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(group): Json<Group>,
) -> AppResult<Json<Value>> {
    save(&state, owner(&state, user, scope).await?, Some(id), group)
        .await
        .map(Json)
}
async fn save(state: &AppState, owner: i64, id: Option<i64>, mut group: Group) -> AppResult<Value> {
    group.validate()?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, owner).await?;
    let mut before = Value::Null;
    let row: Value = if let Some(id) = id {
        let (old,version):(Value,DateTime<Utc>)=sqlx::query_as("SELECT to_jsonb(g),updated_at FROM fleet_permission_groups g WHERE owner_id=$1 AND id=$2 FOR UPDATE")
            .bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
        if Some(version) != group.updated_at {
            return Err(changed());
        }
        before = old;
        sqlx::query_scalar("UPDATE fleet_permission_groups g SET name=$3,permissions=$4,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING to_jsonb(g)")
            .bind(owner).bind(id).bind(group.name).bind(group.permissions).fetch_one(&mut *tx).await.map_err(conflict)?
    } else {
        sqlx::query_scalar("INSERT INTO fleet_permission_groups AS g(owner_id,name,permissions) VALUES($1,$2,$3) RETURNING to_jsonb(g)")
            .bind(owner).bind(group.name).bind(group.permissions).fetch_one(&mut *tx).await.map_err(conflict)?
    };
    let group_id = row["id"]
        .as_i64()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("permission group id is missing")))?;
    log(
        &mut tx,
        owner,
        owner,
        "permission_group",
        group_id,
        before,
        row.clone(),
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Version {
    updated_at: DateTime<Utc>,
}
async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Query(version): Query<Version>,
) -> AppResult<Json<Value>> {
    let owner = owner(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, owner).await?;
    let before: Value = sqlx::query_scalar(
        "SELECT to_jsonb(g) FROM fleet_permission_groups g WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let assigned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM staff WHERE user_id=$1 AND permission_group_id=$2)",
    )
    .bind(owner)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if assigned {
        return Err(AppError::Conflict(
            "배정된 사용자를 다른 그룹으로 이동하거나 기본 역할로 복원한 뒤 삭제해 주세요.".into(),
        ));
    }
    if sqlx::query(
        "DELETE FROM fleet_permission_groups WHERE owner_id=$1 AND id=$2 AND updated_at=$3",
    )
    .bind(owner)
    .bind(id)
    .bind(version.updated_at)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        != 1
    {
        return Err(changed());
    }
    log(
        &mut tx,
        owner,
        owner,
        "permission_group",
        id,
        before,
        Value::Null,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    id: i64,
    updated_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    // An explicit null restores the base role. An omitted field is an invalid request.
    #[serde(deserialize_with = "explicit_group")]
    group_id: Option<i64>,
    members: Vec<Member>,
}
fn explicit_group<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Option::<i64>::deserialize(d)
}
async fn assign(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<Assignment>,
) -> AppResult<Json<Value>> {
    let owner = owner(&state, user, scope).await?;
    let mut ids: Vec<i64> = p.members.iter().map(|m| m.id).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() || ids.len() > 100 || ids.len() != p.members.len() || ids[0] <= 0 {
        return Err(AppError::BadRequest(
            "배정할 사용자를 1~100명 선택해 주세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    lock(&mut tx, owner).await?;
    if let Some(group) = p.group_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM fleet_permission_groups WHERE owner_id=$1 AND id=$2)",
        )
        .bind(owner)
        .bind(group)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(AppError::NotFound);
        }
    }
    let members:Vec<(i64,DateTime<Utc>,Option<i64>)>=sqlx::query_as("SELECT id,updated_at,permission_group_id FROM staff WHERE user_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE")
        .bind(owner).bind(&ids).fetch_all(&mut *tx).await?;
    if members.len() != ids.len() {
        return Err(AppError::NotFound);
    }
    let mut changed_count = 0;
    for (id, version, prior) in members {
        if !p
            .members
            .iter()
            .any(|m| m.id == id && m.updated_at == version)
        {
            return Err(changed());
        }
        if prior != p.group_id {
            sqlx::query("UPDATE staff SET permission_group_id=$3,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2")
                .bind(owner).bind(id).bind(p.group_id).execute(&mut *tx).await?;
            log(
                &mut tx,
                owner,
                owner,
                "permission_assignment",
                id,
                json!({"group_id":prior}),
                json!({"group_id":p.group_id}),
            )
            .await?;
            changed_count += 1;
        }
    }
    tx.commit().await?;
    Ok(Json(json!({"count":changed_count})))
}
