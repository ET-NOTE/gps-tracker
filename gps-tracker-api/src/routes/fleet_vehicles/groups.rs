use crate::{
    auth::{fleet::FleetScope, AuthUser},
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{extract::State, Extension, Json};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};

#[derive(Serialize, FromRow)]
pub(super) struct VehicleGroup {
    id: i64,
    name: String,
}

pub(super) async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<VehicleGroup>>> {
    let visible = scope.as_ref().filter(|s| !s.permits("manage_vehicles") && s.actor != s.owner).map(|s| &s.vehicles);
    let rows = sqlx::query_as(
        "SELECT g.id, g.name FROM fleet_vehicle_groups g WHERE g.owner_id=$1
         AND ($2::bigint[] IS NULL OR EXISTS (
           SELECT 1 FROM fleet_vehicles v WHERE v.owner_id=g.owner_id AND v.group_id=g.id AND v.id=ANY($2)))
         ORDER BY g.name,g.id"
    ).bind(user.user_id).bind(visible).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GroupInput {
    name: String,
}

pub(super) async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<GroupInput>,
) -> AppResult<Json<VehicleGroup>> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 50 {
        return Err(AppError::BadRequest("그룹 이름을 1~50자로 입력해 주세요.".into()));
    }
    let row = sqlx::query_as(
        "INSERT INTO fleet_vehicle_groups(owner_id,name) VALUES ($1,$2)
         ON CONFLICT DO NOTHING RETURNING id,name"
    ).bind(user.user_id).bind(name).fetch_optional(&state.db).await?
      .ok_or_else(|| AppError::Conflict("같은 이름의 차량 그룹이 있습니다.".into()))?;
    Ok(Json(row))
}

pub(super) async fn validate_assignment(
    tx: &mut Transaction<'_,Postgres>, owner: i64, group: Option<i64>
) -> AppResult<()> {
    if let Some(group) = group {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_vehicle_groups WHERE owner_id=$1 AND id=$2)")
            .bind(owner).bind(group).fetch_one(&mut **tx).await?;
        if !valid { return Err(AppError::BadRequest("현재 회사의 차량 그룹을 선택해 주세요.".into())); }
    }
    Ok(())
}
