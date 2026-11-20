use crate::{
    auth::{
        fleet::{self, FleetScope},
        AuthUser,
    },
    error::{AppError, AppResult},
    services::fleet_sites::Geometry,
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/sites", get(list).post(create))
        .route("/corporate/sites/:id", axum::routing::put(update))
        .route("/corporate/site-groups", get(groups).post(create_group))
        .route(
            "/corporate/site-groups/:id",
            axum::routing::put(update_group),
        )
        .route("/corporate/site-visits", get(visits))
}
async fn principal(
    state: &AppState,
    user: AuthUser,
    s: Option<Extension<FleetScope>>,
) -> AppResult<FleetScope> {
    match s {
        Some(Extension(s)) => Ok(s),
        None => fleet::load(state, user.user_id, user.user_id).await,
    }
}
async fn lock(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-sites:{owner}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    s: &FleetScope,
    id: i64,
    action: &str,
    before: Value,
    after: Value,
) -> AppResult<()> {
    sqlx::query("INSERT INTO fleet_team_audit(owner_id,actor_id,action,target_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6)").bind(s.owner).bind(s.actor).bind(action).bind(id).bind(before).bind(after).execute(&mut **tx).await?;
    Ok(())
}
fn text(value: &str, max: usize, required: bool) -> AppResult<String> {
    let v = value.trim();
    if v.chars().count() > max || required && v.is_empty() {
        return Err(AppError::BadRequest(
            "이름·주소·메모의 길이를 확인해 주세요.".into(),
        ));
    }
    Ok(v.to_owned())
}
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = principal(&state, user, scope).await?;
    let rows=sqlx::query_scalar("SELECT to_jsonb(s)||jsonb_build_object('group_name',g.name,'last_visit_at',(SELECT max(v.last_inside_at) FROM gps_read_fleet_site_visits v WHERE v.site_id=s.id AND v.owner_id=$1 AND v.vehicle_id=ANY($2))) FROM gps_read_fleet_sites s LEFT JOIN fleet_site_groups g ON g.id=s.group_id WHERE s.owner_id=$1 ORDER BY s.active DESC,s.name,s.id").bind(s.owner).bind(&s.vehicles).fetch_all(&state.db).await?;
    Ok(Json(rows))
}
async fn groups(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<Value>>> {
    Ok(Json(sqlx::query_scalar("SELECT to_jsonb(g) FROM fleet_site_groups g WHERE owner_id=$1 ORDER BY active DESC,name,id").bind(user.user_id).fetch_all(&state.db).await?))
}
#[derive(Deserialize)]
struct GroupInput {
    name: String,
    active: bool,
    updated_at: Option<DateTime<Utc>>,
}
async fn create_group(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<GroupInput>,
) -> AppResult<Json<Value>> {
    save_group(&state, principal(&state, user, scope).await?, None, p).await
}
async fn update_group(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(p): Json<GroupInput>,
) -> AppResult<Json<Value>> {
    save_group(&state, principal(&state, user, scope).await?, Some(id), p).await
}
async fn save_group(
    state: &AppState,
    s: FleetScope,
    id: Option<i64>,
    p: GroupInput,
) -> AppResult<Json<Value>> {
    if !s.admin() {
        return Err(AppError::Forbidden);
    }
    let name = text(&p.name, 80, true)?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM fleet_site_groups WHERE owner_id=$1")
        .bind(s.owner)
        .fetch_one(&mut *tx)
        .await?;
    if id.is_none() && count >= 100 {
        return Err(AppError::BadRequest(
            "그룹은 최대 100개까지 등록할 수 있습니다.".into(),
        ));
    }
    let duplicate:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_site_groups WHERE owner_id=$1 AND name=$2 AND ($3::bigint IS NULL OR id<>$3))").bind(s.owner).bind(&name).bind(id).fetch_one(&mut *tx).await?;
    if duplicate {
        return Err(AppError::Conflict("같은 이름의 그룹이 있습니다.".into()));
    }
    let before: Value = if let Some(id) = id {
        sqlx::query_scalar(
            "SELECT to_jsonb(g) FROM fleet_site_groups g WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        )
        .bind(id)
        .bind(s.owner)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?
    } else {
        Value::Null
    };
    if id.is_some()
        && before["updated_at"]
            .as_str()
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.with_timezone(&Utc))
            != p.updated_at
    {
        return Err(AppError::Conflict(
            "그룹이 변경되었습니다. 새로고침 후 다시 시도해 주세요.".into(),
        ));
    }
    let after: Value = if let Some(id) = id {
        sqlx::query_scalar("UPDATE fleet_site_groups g SET name=$3,active=$4,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING to_jsonb(g)").bind(id).bind(s.owner).bind(name).bind(p.active).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar("INSERT INTO fleet_site_groups AS g(owner_id,name,active) VALUES($1,$2,$3) RETURNING to_jsonb(g)").bind(s.owner).bind(name).bind(p.active).fetch_one(&mut *tx).await?
    };
    audit(
        &mut tx,
        &s,
        after["id"].as_i64().unwrap(),
        "site_group",
        before,
        after.clone(),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(after))
}
#[derive(Deserialize)]
struct SiteInput {
    name: String,
    address: String,
    group_id: Option<i64>,
    geometry: Geometry,
    active: bool,
    #[serde(default)]
    note: String,
    updated_at: Option<DateTime<Utc>>,
}
async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<SiteInput>,
) -> AppResult<Json<Value>> {
    save(&state, principal(&state, user, scope).await?, None, p).await
}
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(p): Json<SiteInput>,
) -> AppResult<Json<Value>> {
    save(&state, principal(&state, user, scope).await?, Some(id), p).await
}
async fn save(
    state: &AppState,
    s: FleetScope,
    id: Option<i64>,
    p: SiteInput,
) -> AppResult<Json<Value>> {
    if !s.admin() {
        return Err(AppError::Forbidden);
    }
    let name = text(&p.name, 120, true)?;
    let address = text(&p.address, 300, false)?;
    let note = text(&p.note, 1000, false)?;
    if !p.geometry.valid() {
        return Err(AppError::BadRequest(
            "반경은 20m~50km, 영역은 교차하지 않는 3~32개 꼭짓점으로 지정해 주세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM gps_read_fleet_sites WHERE owner_id=$1")
            .bind(s.owner)
            .fetch_one(&mut *tx)
            .await?;
    if id.is_none() && count >= 200 {
        return Err(AppError::BadRequest(
            "지점은 최대 200개까지 등록할 수 있습니다.".into(),
        ));
    }
    let before: Value = if let Some(id) = id {
        sqlx::query_scalar(
            "SELECT to_jsonb(s) FROM gps_read_fleet_sites s WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        )
        .bind(id)
        .bind(s.owner)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?
    } else {
        Value::Null
    };
    if id.is_some()
        && before["updated_at"]
            .as_str()
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.with_timezone(&Utc))
            != p.updated_at
    {
        return Err(AppError::Conflict(
            "지점이 변경되었습니다. 새로고침 후 다시 시도해 주세요.".into(),
        ));
    }
    if let Some(group) = p.group_id {
        let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_site_groups WHERE id=$1 AND owner_id=$2 AND (active OR id=$3))").bind(group).bind(s.owner).bind(before["group_id"].as_i64()).fetch_one(&mut *tx).await?;
        if !ok {
            return Err(AppError::BadRequest(
                "사용 가능한 회사 지점 그룹을 선택해 주세요.".into(),
            ));
        }
    }
    let geometry = serde_json::to_value(p.geometry).map_err(|e| AppError::Internal(e.into()))?;
    let after: Value = if let Some(id) = id {
        sqlx::query_scalar("UPDATE fleet_sites s SET name=$3,address=$4,group_id=$5,geometry=$6,active=$7,note=$8 WHERE id=$1 AND owner_id=$2 RETURNING gps_open_row('fleet_sites',to_jsonb(s))").bind(id).bind(s.owner).bind(name).bind(address).bind(p.group_id).bind(geometry).bind(p.active).bind(note).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar("INSERT INTO fleet_sites AS s(owner_id,name,address,group_id,geometry,active,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING gps_open_row('fleet_sites',to_jsonb(s))").bind(s.owner).bind(name).bind(address).bind(p.group_id).bind(geometry).bind(p.active).bind(note).fetch_one(&mut *tx).await?
    };
    audit(
        &mut tx,
        &s,
        after["id"].as_i64().unwrap(),
        "site",
        before,
        after.clone(),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(after))
}
#[derive(Deserialize)]
struct VisitQuery {
    from: Option<String>,
    to: Option<String>,
    site_id: Option<i64>,
    vehicle_id: Option<i64>,
    before: Option<i64>,
}
async fn visits(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Query(q): Query<VisitQuery>,
) -> AppResult<Json<Value>> {
    let s = principal(&state, user, scope).await?;
    if let Some(v) = q.vehicle_id {
        s.vehicle(v)?;
    }
    if let Some(id) = q.site_id {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM gps_read_fleet_sites WHERE id=$1 AND owner_id=$2)",
        )
        .bind(id)
        .bind(s.owner)
        .fetch_one(&state.db)
        .await?;
        if !ok {
            return Err(AppError::NotFound);
        }
    }
    let range: super::corporate::TripQuery =
        serde_json::from_value(json!({"from":q.from,"to":q.to}))
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
    let (from, to) = super::corporate::parse_range(&range)?;
    if to - from > chrono::Duration::days(93) {
        return Err(AppError::BadRequest(
            "방문 기록은 최대 93일씩 조회해 주세요.".into(),
        ));
    }
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(v)||jsonb_build_object('observed_seconds',GREATEST(0,extract(epoch FROM last_inside_at-first_inside_at)::bigint),'status',CASE WHEN end_reason IS NOT NULL THEN end_reason WHEN last_inside_at<now()-interval '30 minutes' THEN 'stale' ELSE 'inside' END) FROM gps_read_fleet_site_visits v WHERE owner_id=$1 AND vehicle_id=ANY($2) AND first_inside_at<=$4 AND last_inside_at>=$3 AND ($5::bigint IS NULL OR site_id=$5) AND ($6::bigint IS NULL OR vehicle_id=$6) AND ($7::bigint IS NULL OR (first_inside_at,id)<(SELECT first_inside_at,id FROM gps_read_fleet_site_visits WHERE id=$7 AND owner_id=$1 AND vehicle_id=ANY($2))) ORDER BY first_inside_at DESC,id DESC LIMIT 101").bind(s.owner).bind(&s.vehicles).bind(from).bind(to).bind(q.site_id).bind(q.vehicle_id).bind(q.before).fetch_all(&state.db).await?;
    let more = rows.len() > 100;
    rows.truncate(100);
    let next = if more {
        rows.last().and_then(|v| v["id"].as_i64())
    } else {
        None
    };
    Ok(Json(
        json!({"items":rows,"next_before":next,"poll_seconds":30,"gap_minutes":30}),
    ))
}
