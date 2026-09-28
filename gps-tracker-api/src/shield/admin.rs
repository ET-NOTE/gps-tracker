use super::*;
use axum::extract::{Path, Query};
use serde::Deserialize;
use sqlx::{Postgres, Transaction};

pub async fn require(app: &App, h: &HeaderMap) -> Result<i64> {
    let id = auth::user(app, h).await?;
    if !sqlx::query_scalar::<_, bool>("SELECT role='admin' AND NOT disabled FROM users WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await?
    {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "관리자 권한이 필요합니다.".into(),
        ));
    }
    Ok(id)
}
pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Option<i64>,
    action: &str,
    kind: &str,
    id: &str,
    detail: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO audit_log(actor_id,action,target_type,target_id,detail) VALUES($1,$2,$3,$4,$5)")
        .bind(actor).bind(action).bind(kind).bind(id).bind(detail).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Default, Deserialize)]
pub struct Page {
    pub before: Option<i64>,
    pub q: Option<String>,
}
pub async fn overview(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    require(&app, &h).await?;
    let counts:Value=sqlx::query_scalar("SELECT jsonb_build_object('users',(SELECT count(*) FROM users),'devices',(SELECT count(*) FROM devices),'reports_today',(SELECT count(*) FROM messages WHERE received_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'),'open_requests',(SELECT count(*) FROM sim_requests WHERE status IN ('pending','approved','submitting','submitted','unknown')),'posts',(SELECT count(*) FROM content_posts))").fetch_one(&app.db).await?;
    Ok(Json(json!({"counts":counts,"provider":app.nce.status()})))
}
pub async fn users(
    State(app): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Value>> {
    require(&app, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'email',email,'display_name',display_name,'role',role,'disabled',disabled,'credit_balance',credit_balance,'created_at',created_at,'device_count',(SELECT count(*) FROM devices d WHERE d.owner_id=u.id)) FROM users u WHERE id<$1 AND (email ILIKE $2 OR display_name ILIKE $2) ORDER BY id DESC LIMIT 100")
        .bind(p.before.unwrap_or(i64::MAX)).bind(format!("%{}%",p.q.unwrap_or_default().chars().take(100).collect::<String>())).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserEdit {
    display_name: String,
    role: String,
    disabled: bool,
}
pub async fn edit_user(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Json(v): Json<UserEdit>,
) -> Result<Json<Value>> {
    let actor = require(&app, &h).await?;
    if v.display_name.trim().is_empty()
        || v.display_name.chars().count() > 50
        || !["user", "admin"].contains(&v.role.as_str())
    {
        return Err(bad("이름과 역할을 확인해 주세요."));
    }
    let mut tx = app.db.begin().await?;
    // Serialize administrator role changes, including the last-admin invariant.
    sqlx::query("SELECT pg_advisory_xact_lock(8043001)")
        .execute(&mut *tx)
        .await?;
    let before:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('display_name',display_name,'role',role,'disabled',disabled) FROM users WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let before = before.ok_or_else(missing)?;
    if id == actor && (v.disabled || v.role != "admin") {
        return Err(bad("현재 로그인한 관리자의 권한을 해제할 수 없습니다."));
    }
    let admins: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE role='admin' AND NOT disabled AND id<>$1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if admins == 0 && (v.disabled || v.role != "admin") {
        return Err(bad("활성 관리자는 최소 한 명 필요합니다."));
    }
    sqlx::query("UPDATE users SET display_name=$2,role=$3,disabled=$4 WHERE id=$1")
        .bind(id)
        .bind(v.display_name.trim())
        .bind(&v.role)
        .bind(v.disabled)
        .execute(&mut *tx)
        .await?;
    if before["role"] != v.role || before["disabled"] != v.disabled {
        sqlx::query("DELETE FROM sessions WHERE user_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    audit(&mut tx,Some(actor),"user.update","user",&id.to_string(),json!({"before":before,"after":{"display_name":v.display_name.trim(),"role":v.role,"disabled":v.disabled}})).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn revoke_sessions(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    let actor = require(&app, &h).await?;
    let mut tx = app.db.begin().await?;
    let n = sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    audit(
        &mut tx,
        Some(actor),
        "user.sessions.revoke",
        "user",
        &id.to_string(),
        json!({"sessions":n}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn devices(
    State(app): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Value>> {
    require(&app, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',d.id,'device_uid',device_uid,'display_name',d.display_name,'owner_email',u.email,'last_seen_at',last_seen_at,'sim_iccid',sim_iccid,'sim_updated_at',sim_updated_at,'sim_error',sim_error,'active_sensor_set',active_sensor_set) FROM devices d LEFT JOIN users u ON u.id=d.owner_id WHERE d.id<$1 ORDER BY d.id DESC LIMIT 100").bind(p.before.unwrap_or(i64::MAX)).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceEdit {
    display_name: String,
    sim_iccid: Option<String>,
}
pub async fn edit_device(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Json(v): Json<DeviceEdit>,
) -> Result<Json<Value>> {
    let actor = require(&app, &h).await?;
    if v.display_name.trim().is_empty() || v.display_name.chars().count() > 60 {
        return Err(bad("장치 이름을 확인해 주세요."));
    }
    let sim = v
        .sim_iccid
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(nce::normalize_iccid)
        .transpose()?;
    let mut tx = app.db.begin().await?;
    let before:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('display_name',display_name,'sim_iccid',sim_iccid) FROM devices WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let before = before.ok_or_else(missing)?;
    let old = before["sim_iccid"]
        .as_str()
        .map(nce::normalize_iccid)
        .transpose()?;
    if old != sim {
        let open:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sim_requests WHERE device_id=$1 AND status IN ('pending','approved','submitting','submitted','unknown'))").bind(id).fetch_one(&mut *tx).await?;
        if open {
            return Err(bad("진행 중인 USIM 요청을 정리한 뒤 SIM을 변경해 주세요."));
        }
    }
    let conflict: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM devices WHERE id<>$1 AND left(sim_iccid,19)=$2)",
    )
    .bind(id)
    .bind(&sim)
    .fetch_one(&mut *tx)
    .await?;
    if conflict {
        return Err(bad("다른 장치에 연결된 USIM입니다."));
    }
    sqlx::query("UPDATE devices SET display_name=$2,sim_iccid=$3,sim_info=CASE WHEN left(sim_iccid,19) IS DISTINCT FROM $3 THEN NULL ELSE sim_info END,sim_updated_at=CASE WHEN left(sim_iccid,19) IS DISTINCT FROM $3 THEN NULL ELSE sim_updated_at END,sim_attempted_at=NULL,sim_error=NULL WHERE id=$1")
        .bind(id).bind(v.display_name.trim()).bind(&sim).execute(&mut *tx).await?;
    // Subscriber identifiers are masked even in the audit trail.
    audit(&mut tx,Some(actor),"device.update","device",&id.to_string(),json!({"before_name":before["display_name"],"after_name":v.display_name.trim(),"sim_changed":old!=sim})).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn events(
    State(app): State<App>,
    h: HeaderMap,
    Query(p): Query<Page>,
) -> Result<Json<Value>> {
    require(&app, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',a.id,'actor',COALESCE(u.email,'시스템'),'action',action,'target_type',target_type,'target_id',target_id,'detail',detail,'created_at',a.created_at) FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE a.id<$1 ORDER BY a.id DESC LIMIT 100").bind(p.before.unwrap_or(i64::MAX)).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn invite(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let actor = require(&app, &h).await?;
    auth::rate(&app, format!("invite:{actor}"), 20).await?;
    let code = secret();
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO invites(code_hash,expires_at) VALUES($1,now()+interval '7 days')")
        .bind(hash(&code))
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        Some(actor),
        "invite.create",
        "invite",
        "new",
        json!({"expires_in_days":7}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"invite_code":code,"expires_in_days":7})))
}
