//! Organization records, explicit invitations and auditable membership changes.
use crate::{
    auth::{
        fleet::{self, FleetScope},
        AuthUser,
    },
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    routing::{delete, get, post, put},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
#[path = "fleet_staff_import.rs"]
mod staff_import;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/workspaces", get(workspaces))
        .route("/corporate/join", post(join))
        .route("/corporate/access", get(access))
        .route("/corporate/organization", get(organization))
        .route("/corporate/organization/items", post(create_item))
        .route("/corporate/organization/items/:id", put(update_item))
        .route("/corporate/staff", get(list_staff).post(create_staff))
        .route("/corporate/staff/import", post(staff_import::import))
        .route(
            "/corporate/staff/:id",
            axum::routing::patch(update_staff).delete(disable_staff),
        )
        .route("/corporate/staff/:id/account", delete(unlink))
        .route("/corporate/invites", get(invites).post(invite))
        .route("/corporate/invites/:id", delete(revoke))
        .route("/corporate/team-audit", get(audit))
        .route(
            "/corporate/terminals",
            get(super::fleet_subject_readers::terminals),
        )
}

async fn principal(
    state: &AppState,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<FleetScope> {
    if let Some(Extension(s)) = scope {
        Ok(s)
    } else {
        fleet::load(state, user.user_id, user.user_id).await
    }
}
async fn admin(
    state: &AppState,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<FleetScope> {
    let s = principal(state, user, scope).await?;
    if !s.admin() {
        return Err(AppError::Forbidden);
    }
    Ok(s)
}
async fn log(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    actor: i64,
    action: &str,
    id: i64,
    before: Value,
    after: Value,
) -> AppResult<()> {
    sqlx::query("INSERT INTO fleet_team_audit(owner_id,actor_id,action,target_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6)")
 .bind(owner).bind(actor).bind(action).bind(id).bind(before).bind(after).execute(&mut **tx).await?;
    Ok(())
}
async fn lock(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-team:{owner}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
fn text(v: &Value, key: &str, max: usize, required: bool) -> AppResult<Option<String>> {
    let value = match v.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        }
        _ => return Err(AppError::BadRequest(format!("{key} 입력을 확인해 주세요."))),
    };
    if required && value.is_none() || value.as_ref().is_some_and(|v| v.chars().count() > max) {
        return Err(AppError::BadRequest(format!("{key} 입력을 확인해 주세요.")));
    }
    Ok(value)
}
fn number(v: &Value, key: &str) -> AppResult<Option<i64>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(x) if x.as_i64().is_some_and(|n| n > 0) => Ok(x.as_i64()),
        _ => Err(AppError::BadRequest(format!("{key} 선택을 확인해 주세요."))),
    }
}
fn boolean(v: &Value, key: &str, default: bool) -> AppResult<bool> {
    match v.get(key) {
        None => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(AppError::BadRequest(format!("{key} 값을 확인해 주세요."))),
    }
}
const STAFF:&str="SELECT to_jsonb(s)||jsonb_build_object('department',d.name,'position',p.name,'account_id',a.account_id,'account_email',u.email,'vehicle_ids',COALESCE((SELECT jsonb_agg(x.vehicle_id ORDER BY x.vehicle_id) FROM fleet_staff_vehicles x WHERE x.owner_id=s.user_id AND x.staff_id=s.id),'[]'::jsonb)) FROM staff s LEFT JOIN fleet_org_items d ON d.id=s.department_id LEFT JOIN fleet_org_items p ON p.id=s.position_id LEFT JOIN fleet_staff_accounts a ON a.owner_id=s.user_id AND a.staff_id=s.id LEFT JOIN users u ON u.id=a.account_id";

async fn access(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Value>> {
    let s = principal(&state, user, scope).await?;
    Ok(Json(
        json!({"owner_id":s.owner,"actor_id":s.actor,"staff_id":s.staff,"role":s.role,"department_id":s.department,"manage_team":s.admin(),"manage_vehicles":s.admin(),"manage_reports":s.manager(),"billing":s.owner==s.actor,"vehicle_ids":s.vehicles,"staff_ids":s.staff_ids}),
    ))
}
async fn workspaces(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('owner_id',a.owner_id,'company_name',COALESCE(nullif(c.company_name,''),'회사명 미등록'),'staff_name',s.name,'role',s.access_role) FROM fleet_staff_accounts a JOIN staff s ON s.id=a.staff_id AND s.user_id=a.owner_id LEFT JOIN corporate_info c ON c.user_id=a.owner_id WHERE a.account_id=$1 AND s.active ORDER BY a.owner_id")
 .bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(json!({"own_id":user.user_id,"memberships":rows})))
}
async fn organization(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<Value>>> {
    Ok(Json(sqlx::query_scalar("SELECT to_jsonb(i) FROM fleet_org_items i WHERE owner_id=$1 ORDER BY kind,active DESC,name,id").bind(user.user_id).fetch_all(&state.db).await?))
}
#[derive(Deserialize)]
struct ItemInput {
    kind: String,
    name: String,
    active: bool,
    updated_at: Option<DateTime<Utc>>,
}
async fn create_item(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<ItemInput>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    save_item(&state, &s, None, p).await.map(Json)
}
async fn update_item(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(p): Json<ItemInput>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    save_item(&state, &s, Some(id), p).await.map(Json)
}
async fn save_item(
    state: &AppState,
    s: &FleetScope,
    id: Option<i64>,
    p: ItemInput,
) -> AppResult<Value> {
    let name = p.name.trim();
    if !["department", "position"].contains(&p.kind.as_str())
        || name.is_empty()
        || name.chars().count() > 100
    {
        return Err(AppError::BadRequest(
            "항목 이름을 100자 이내로 입력해 주세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let before: Value = if let Some(id) = id {
        sqlx::query_scalar(
            "SELECT to_jsonb(i) FROM fleet_org_items i WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        )
        .bind(id)
        .bind(s.owner)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?
    } else {
        Value::Null
    };
    let row: Value = if let Some(id) = id {
        if before["kind"].as_str() != Some(&p.kind) {
            return Err(AppError::BadRequest(
                "항목 종류는 변경할 수 없습니다.".into(),
            ));
        }
        sqlx::query_scalar("UPDATE fleet_org_items SET name=$3,active=$4,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND updated_at=$5 RETURNING to_jsonb(fleet_org_items)")
   .bind(id).bind(s.owner).bind(name).bind(p.active).bind(p.updated_at).fetch_optional(&mut *tx).await.map_err(conflict)?.ok_or_else(||AppError::Conflict("항목이 변경됐습니다. 새로고침 후 저장해 주세요.".into()))?
    } else {
        sqlx::query_scalar("INSERT INTO fleet_org_items(owner_id,kind,name,active) VALUES($1,$2,$3,$4) RETURNING to_jsonb(fleet_org_items)").bind(s.owner).bind(p.kind).bind(name).bind(p.active).fetch_one(&mut *tx).await.map_err(conflict)?
    };
    let id = row["id"].as_i64().unwrap();
    if row["kind"] == "department" {
        sqlx::query("UPDATE fleet_vehicles SET department=$2,updated_at=clock_timestamp() WHERE department_id=$1 AND owner_id=$3").bind(id).bind(name).bind(s.owner).execute(&mut *tx).await?;
    }
    log(
        &mut tx,
        s.owner,
        s.actor,
        "organization",
        id,
        before,
        row.clone(),
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}
fn conflict(e: sqlx::Error) -> AppError {
    if e.as_database_error().and_then(|e| e.code()).as_deref() == Some("23505") {
        AppError::Conflict("이미 등록된 항목입니다.".into())
    } else {
        e.into()
    }
}
async fn list_staff(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<Value>>> {
    Ok(Json(
        sqlx::query_scalar(&format!(
            "{STAFF} WHERE s.user_id=$1 ORDER BY s.active DESC,s.name,s.id"
        ))
        .bind(user.user_id)
        .fetch_all(&state.db)
        .await?,
    ))
}
async fn create_staff(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<Value>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    save_staff(&state, &s, None, p).await.map(Json)
}
async fn update_staff(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(p): Json<Value>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    save_staff(&state, &s, Some(id), p).await.map(Json)
}
async fn disable_staff(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    save_staff(&state, &s, Some(id), json!({"active":false}))
        .await
        .map(Json)
}
async fn save_staff(
    state: &AppState,
    s: &FleetScope,
    id: Option<i64>,
    p: Value,
) -> AppResult<Value> {
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let before: Value = if let Some(id) = id {
        sqlx::query_scalar(&format!("{STAFF} WHERE s.id=$1 AND s.user_id=$2"))
            .bind(id)
            .bind(s.owner)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?
    } else {
        json!({"active":true,"access_role":"member","all_vehicles":true,"vehicle_ids":[]})
    };
    if let Some(expected) = p.get("updated_at") {
        if expected != &before["updated_at"] {
            return Err(AppError::Conflict(
                "사용자 정보가 변경됐습니다. 새로고침 후 저장해 주세요.".into(),
            ));
        }
    }
    let mut merged = before.clone();
    let obj = p
        .as_object()
        .ok_or_else(|| AppError::BadRequest("입력 내용을 확인해 주세요.".into()))?;
    for (k, v) in obj {
        if ![
            "name",
            "role",
            "phone",
            "active",
            "department_id",
            "position_id",
            "access_role",
            "all_vehicles",
            "vehicle_ids",
            "updated_at",
        ]
        .contains(&k.as_str())
        {
            return Err(AppError::BadRequest(
                "지원하지 않는 사용자 항목입니다.".into(),
            ));
        }
        merged[k] = v.clone();
    }
    let name = text(&merged, "name", 64, true)?.unwrap();
    let role = text(&merged, "role", 100, false)?;
    let phone = text(&merged, "phone", 50, false)?;
    let department = number(&merged, "department_id")?;
    let position = number(&merged, "position_id")?;
    let access = text(&merged, "access_role", 32, true)?.unwrap();
    let active = boolean(&merged, "active", true)?;
    let all = boolean(&merged, "all_vehicles", true)?;
    if !["admin", "department_manager", "member"].contains(&access.as_str())
        || (access == "department_manager" && department.is_none())
    {
        return Err(AppError::BadRequest(
            "부서 관리자에게는 부서를 지정해 주세요.".into(),
        ));
    }
    if s.role != "owner" && (access == "admin" || before["access_role"] == "admin") {
        return Err(AppError::Forbidden);
    }
    for (id, kind, key) in [
        (department, "department", "department_id"),
        (position, "position", "position_id"),
    ] {
        if let Some(id) = id {
            let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_org_items WHERE id=$1 AND owner_id=$2 AND kind=$3 AND (active OR id=$4))").bind(id).bind(s.owner).bind(kind).bind(before[key].as_i64()).fetch_one(&mut *tx).await?;
            if !valid {
                return Err(AppError::BadRequest(
                    "현재 회사의 부서·직책을 선택해 주세요.".into(),
                ));
            }
        }
    }
    let ids = merged["vehicle_ids"]
        .as_array()
        .ok_or_else(|| AppError::BadRequest("차량 선택을 확인해 주세요.".into()))?;
    if ids.len() > 1000 {
        return Err(AppError::BadRequest(
            "차량을 1,000대 이내로 선택해 주세요.".into(),
        ));
    }
    let mut vehicles = ids
        .iter()
        .map(|v| {
            v.as_i64()
                .filter(|v| *v > 0)
                .ok_or_else(|| AppError::BadRequest("차량 선택을 확인해 주세요.".into()))
        })
        .collect::<AppResult<Vec<_>>>()?;
    vehicles.sort_unstable();
    vehicles.dedup();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM fleet_vehicles WHERE owner_id=$1 AND id=ANY($2)")
            .bind(s.owner)
            .bind(&vehicles)
            .fetch_one(&mut *tx)
            .await?;
    if count != vehicles.len() as i64 {
        return Err(AppError::NotFound);
    }
    let saved = if let Some(id) = id {
        sqlx::query_scalar::<_,i64>("UPDATE staff SET name=$3,role=$4,phone=$5,active=$6,department_id=$7,position_id=$8,access_role=$9,all_vehicles=$10,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING id").bind(id).bind(s.owner).bind(name).bind(role).bind(phone).bind(active).bind(department).bind(position).bind(access).bind(all).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar("INSERT INTO staff(user_id,name,role,phone,active,department_id,position_id,access_role,all_vehicles) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id").bind(s.owner).bind(name).bind(role).bind(phone).bind(active).bind(department).bind(position).bind(access).bind(all).fetch_one(&mut *tx).await?
    };
    sqlx::query("DELETE FROM fleet_staff_vehicles WHERE owner_id=$1 AND staff_id=$2")
        .bind(s.owner)
        .bind(saved)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO fleet_staff_vehicles(owner_id,staff_id,vehicle_id) SELECT $1,$2,unnest($3::bigint[])").bind(s.owner).bind(saved).bind(vehicles).execute(&mut *tx).await?;
    if !active {
        sqlx::query("UPDATE fleet_invites SET revoked_at=now() WHERE owner_id=$1 AND staff_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL").bind(s.owner).bind(saved).execute(&mut *tx).await?;
    }
    let row: Value = sqlx::query_scalar(&format!("{STAFF} WHERE s.id=$1 AND s.user_id=$2"))
        .bind(saved)
        .bind(s.owner)
        .fetch_one(&mut *tx)
        .await?;
    log(
        &mut tx,
        s.owner,
        s.actor,
        "staff",
        saved,
        before,
        row.clone(),
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}
async fn invites(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = admin(&state, user, scope).await?;
    Ok(Json(sqlx::query_scalar("SELECT jsonb_build_object('id',i.id,'staff_id',i.staff_id,'name',s.name,'expires_at',i.expires_at,'revoked_at',i.revoked_at,'accepted_at',i.accepted_at,'created_at',i.created_at) FROM fleet_invites i JOIN staff s ON s.id=i.staff_id WHERE i.owner_id=$1 ORDER BY i.id DESC LIMIT 100").bind(s.owner).fetch_all(&state.db).await?))
}
#[derive(Deserialize)]
struct InviteInput {
    staff_id: i64,
}
async fn invite(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<InviteInput>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let role: String = sqlx::query_scalar(
        "SELECT access_role FROM staff WHERE id=$1 AND user_id=$2 AND active FOR UPDATE",
    )
    .bind(p.staff_id)
    .bind(s.owner)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if s.role != "owner" && role == "admin" {
        return Err(AppError::Forbidden);
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE owner_id=$1 AND staff_id=$2)",
    )
    .bind(s.owner)
    .bind(p.staff_id)
    .fetch_one(&mut *tx)
    .await?;
    if exists {
        return Err(AppError::Conflict(
            "이미 로그인 계정이 연결되어 있습니다. 연결 해제 후 초대해 주세요.".into(),
        ));
    }
    sqlx::query("UPDATE fleet_invites SET revoked_at=now() WHERE owner_id=$1 AND staff_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL").bind(s.owner).bind(p.staff_id).execute(&mut *tx).await?;
    use base64::Engine;
    let random: [u8; 32] = rand::random();
    let code = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    let hash = format!("{:x}", Sha256::digest(code.as_bytes()));
    let(id,expires):(i64,DateTime<Utc>)=sqlx::query_as("INSERT INTO fleet_invites(owner_id,staff_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING id,expires_at").bind(s.owner).bind(p.staff_id).bind(hash).bind(s.actor).fetch_one(&mut *tx).await?;
    log(
        &mut tx,
        s.owner,
        s.actor,
        "invite_create",
        id,
        Value::Null,
        json!({"staff_id":p.staff_id,"expires_at":expires}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"code":code,"expires_at":expires})))
}
async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let row:Value=sqlx::query_scalar("UPDATE fleet_invites SET revoked_at=now() WHERE id=$1 AND owner_id=$2 AND accepted_at IS NULL RETURNING jsonb_build_object('staff_id',staff_id)").bind(id).bind(s.owner).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    log(
        &mut tx,
        s.owner,
        s.actor,
        "invite_revoke",
        id,
        Value::Null,
        row,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct JoinInput {
    code: String,
    #[serde(default)]
    confirm: bool,
}
async fn join(
    State(state): State<AppState>,
    user: AuthUser,
    Json(p): Json<JoinInput>,
) -> AppResult<Json<Value>> {
    let code = p.code.trim();
    if code.len() != 43 {
        return Err(AppError::BadRequest("초대 코드를 확인해 주세요.".into()));
    }
    let hash = format!("{:x}", Sha256::digest(code.as_bytes()));
    let owner:i64=sqlx::query_scalar("SELECT owner_id FROM fleet_invites WHERE token_hash=$1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>now()").bind(&hash).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, owner).await?;
    let row:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',i.id,'owner_id',i.owner_id,'staff_id',s.id,'staff_name',s.name,'role',s.access_role,'company_name',COALESCE(nullif(c.company_name,''),'회사명 미등록'),'expires_at',i.expires_at) FROM fleet_invites i JOIN staff s ON s.id=i.staff_id AND s.user_id=i.owner_id LEFT JOIN corporate_info c ON c.user_id=i.owner_id WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>now() AND s.active FOR UPDATE OF i,s")
 .bind(hash).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    if owner == user.user_id {
        return Err(AppError::BadRequest(
            "소유자 계정은 초대 없이 관리할 수 있습니다.".into(),
        ));
    }
    if p.confirm {
        let staff = row["staff_id"].as_i64().unwrap();
        sqlx::query(
            "INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES($1,$2,$3)",
        )
        .bind(owner)
        .bind(staff)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await
        .map_err(conflict)?;
        sqlx::query("UPDATE fleet_invites SET accepted_at=now() WHERE id=$1")
            .bind(row["id"].as_i64())
            .execute(&mut *tx)
            .await?;
        log(
            &mut tx,
            owner,
            user.user_id,
            "invite_accept",
            staff,
            Value::Null,
            json!({"account_id":user.user_id}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(row))
}
async fn unlink(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let s = admin(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let role: String =
        sqlx::query_scalar("SELECT access_role FROM staff WHERE id=$1 AND user_id=$2")
            .bind(id)
            .bind(s.owner)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    if s.role != "owner" && role == "admin" {
        return Err(AppError::Forbidden);
    }
    let before:Value=sqlx::query_scalar("DELETE FROM fleet_staff_accounts WHERE owner_id=$1 AND staff_id=$2 RETURNING to_jsonb(fleet_staff_accounts)").bind(s.owner).bind(id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    sqlx::query("UPDATE fleet_invites SET revoked_at=now() WHERE owner_id=$1 AND staff_id=$2 AND revoked_at IS NULL AND accepted_at IS NULL").bind(s.owner).bind(id).execute(&mut *tx).await?;
    log(
        &mut tx,
        s.owner,
        s.actor,
        "account_unlink",
        id,
        before,
        Value::Null,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
async fn audit(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = admin(&state, user, scope).await?;
    Ok(Json(sqlx::query_scalar("SELECT to_jsonb(a) FROM gps_read_fleet_team_audit a WHERE owner_id=$1 ORDER BY id DESC LIMIT 100").bind(s.owner).fetch_all(&state.db).await?))
}

pub async fn driver_allowed(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    staff: Option<i64>,
    vehicle: i64,
) -> AppResult<()> {
    if let Some(staff) = staff {
        let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff s WHERE s.id=$1 AND s.user_id=$2 AND s.active AND (s.all_vehicles OR EXISTS(SELECT 1 FROM fleet_staff_vehicles x WHERE x.owner_id=$2 AND x.staff_id=s.id AND x.vehicle_id=$3) OR EXISTS(SELECT 1 FROM fleet_vehicles v WHERE v.id=$3 AND v.owner_id=$2 AND v.manager_staff_id=s.id)))")
 .bind(staff).bind(owner).bind(vehicle).fetch_one(&mut **tx).await?;
        if !ok {
            return Err(AppError::BadRequest(
                "이 사용자는 선택한 차량에 배정할 수 없습니다.".into(),
            ));
        }
    }
    Ok(())
}

// Legacy clients may still send a department name. Resolve it in the same
// company without accepting a foreign organization ID.
pub async fn resolve_department(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    id: Option<i64>,
    name: Option<String>,
    previous: Option<i64>,
) -> AppResult<(Option<i64>, Option<String>)> {
    if let Some(id) = id {
        let name:String=sqlx::query_scalar("SELECT name FROM fleet_org_items WHERE owner_id=$1 AND id=$2 AND kind='department' AND (active OR id=$3)").bind(owner).bind(id).bind(previous).fetch_optional(&mut **tx).await?.ok_or_else(||AppError::BadRequest("현재 회사의 부서를 선택해 주세요.".into()))?;
        return Ok((Some(id), Some(name)));
    }
    if let Some(name) = name.filter(|s| !s.trim().is_empty()) {
        let row:(i64,bool)=sqlx::query_as("INSERT INTO fleet_org_items(owner_id,kind,name) VALUES($1,'department',$2) ON CONFLICT(owner_id,kind,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,active").bind(owner).bind(name.trim()).fetch_one(&mut **tx).await?;
        if !row.1 && previous != Some(row.0) {
            return Err(AppError::BadRequest(
                "사용 중인 부서를 선택해 주세요.".into(),
            ));
        }
        return Ok((Some(row.0), Some(name.trim().to_string())));
    }
    Ok((None, None))
}
