use axum::{extract::{Path, State}, routing::{get, post, put}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rentcar/team/config",get(config))
        .route("/rentcar/team/branches",post(branch))
        .route("/rentcar/team/groups",post(create_group))
        .route("/rentcar/team/groups/:id",put(update_group))
        .route("/rentcar/team/staff",post(invite))
        .route("/rentcar/team/staff/:id",put(update_staff))
        .route("/rentcar/team/staff/:id/invite",post(reissue))
        .route("/rentcar/team/join",post(join))
        .route("/rentcar/team/memberships",get(memberships))
        .route("/rentcar/team/desk/:owner",get(desk))
        .route("/rentcar/team/desk/:owner/:contract/notes",post(note))
}
const CAPS: [&str;3] = ["dispatch_read","service_read","handover_note"];
fn invalid(message: &str)->AppError { AppError::BadRequest(message.into()) }
fn changed()->AppError { AppError::Conflict("목록이 변경되었습니다. 최신 목록을 다시 확인해 주세요.".into()) }
fn db(e:sqlx::Error)->AppError {
    if let Some(cause)=e.as_database_error() {
        if cause.is_unique_violation(){return AppError::Conflict("이미 등록된 이름 또는 이메일입니다.".into());}
        if cause.is_foreign_key_violation(){return invalid("소속 지점과 권한 그룹을 다시 확인해 주세요.");}
    }
    e.into()
}
fn name(value:&str)->AppResult<&str>{
    let s=value.trim();
    if !(1..=80).contains(&s.chars().count()) {Err(invalid("이름은 1~80자로 입력해 주세요."))} else {Ok(s)}
}
async fn owner(s:&AppState,u:&AuthUser)->AppResult<i64>{
    let yes:bool=sqlx::query_scalar("SELECT EXISTS(SELECT FROM users WHERE id=$1 AND account_type='rentcar')")
        .bind(u.user_id).fetch_one(&s.db).await?;
    if yes {Ok(u.user_id)} else {Err(AppError::Forbidden)}
}
async fn config(State(s):State<AppState>,u:AuthUser)->AppResult<Json<Value>>{
    let id=owner(&s,&u).await?;
    let data=sqlx::query_scalar("SELECT jsonb_build_object(
      'branches',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'active',true) ORDER BY name),'[]') FROM rental_branches WHERE owner_id=$1),
      'groups',(SELECT coalesce(jsonb_agg(to_jsonb(g)-'owner_id' ORDER BY name),'[]') FROM rental_staff_groups g WHERE owner_id=$1),
      'staff',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email,'active',active,'branch_id',branch_id,'group_id',group_id,'revision',revision,'joined',account_id IS NOT NULL,'expires_at',expires_at) ORDER BY name),'[]') FROM rental_staff WHERE owner_id=$1),
      'notes',(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY id DESC),'[]') FROM (SELECT n.id,n.contract_id,n.body,n.created_at,b.name branch,t.name staff FROM rental_handover_notes n JOIN rental_staff t ON t.id=n.staff_id JOIN rental_branches b ON b.id=n.branch_id WHERE t.owner_id=$1 ORDER BY n.id DESC LIMIT 100) n))")
        .bind(id).fetch_one(&s.db).await?;
    Ok(Json(data))
}
#[derive(Deserialize)] struct Named{name:String}
async fn branch(State(s):State<AppState>,u:AuthUser,Json(v):Json<Named>)->AppResult<Json<Value>>{
    let id:i64=sqlx::query_scalar("INSERT INTO rental_branches(owner_id,name) VALUES($1,$2) RETURNING id")
        .bind(owner(&s,&u).await?).bind(name(&v.name)?).fetch_one(&s.db).await.map_err(db)?;
    Ok(Json(json!({"id":id})))
}
#[derive(Deserialize)] struct Group {name:String,permissions:Vec<String>,revision:Option<i32>}
fn caps(v:&mut Group)->AppResult<()>{
    name(&v.name)?;v.permissions.sort();v.permissions.dedup();
    if v.permissions.iter().any(|p|!CAPS.contains(&p.as_str())) || (v.permissions.iter().any(|p|p=="handover_note")&&!v.permissions.iter().any(|p|p=="dispatch_read")) {
        return Err(invalid("인수인계 메모 작성에는 배차 조회 권한이 필요합니다."));
    }
    Ok(())
}
async fn create_group(State(s):State<AppState>,u:AuthUser,Json(mut v):Json<Group>)->AppResult<Json<Value>>{
    caps(&mut v)?;
    let id:i64=sqlx::query_scalar("INSERT INTO rental_staff_groups(owner_id,name,permissions) VALUES($1,$2,$3) RETURNING id")
        .bind(owner(&s,&u).await?).bind(v.name.trim()).bind(v.permissions).fetch_one(&s.db).await.map_err(db)?;
    Ok(Json(json!({"id":id})))
}
async fn update_group(State(s):State<AppState>,u:AuthUser,Path(id):Path<i64>,Json(mut v):Json<Group>)->AppResult<Json<Value>>{
    caps(&mut v)?;
    let row=sqlx::query("UPDATE rental_staff_groups SET name=$3,permissions=$4,revision=revision+1 WHERE owner_id=$1 AND id=$2 AND revision=$5")
        .bind(owner(&s,&u).await?).bind(id).bind(v.name.trim()).bind(v.permissions).bind(v.revision).execute(&s.db).await.map_err(db)?;
    if row.rows_affected()!=1{return Err(changed());} Ok(Json(json!({"id":id})))
}
#[derive(Deserialize)]struct Staff {name:String, email:Option<String>,branch_id:i64,group_id:i64,active:Option<bool>,revision:Option<i32>}
fn token()->(String,String){
    let code=uuid::Uuid::new_v4().simple().to_string();
    let hash=format!("{:x}",Sha256::digest(code.as_bytes()));(code,hash)
}
async fn invite(State(s):State<AppState>,u:AuthUser,Json(v):Json<Staff>)->AppResult<Json<Value>>{
    let email=v.email.unwrap_or_default().trim().to_lowercase();
    if email.len()>254||!email.split_once('@').is_some_and(|(a,b)|!a.is_empty()&&b.contains('.')){return Err(invalid("직원 이메일을 확인해 주세요."));}
    let (code,hash)=token();
    let id:i64=sqlx::query_scalar("INSERT INTO rental_staff(owner_id,email,name,branch_id,group_id,invite_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days') RETURNING id")
        .bind(owner(&s,&u).await?).bind(email).bind(name(&v.name)?).bind(v.branch_id).bind(v.group_id).bind(hash).fetch_one(&s.db).await.map_err(db)?;
    Ok(Json(json!({"id":id,"code":code})))
}
async fn update_staff(State(s):State<AppState>,u:AuthUser,Path(id):Path<i64>,Json(v):Json<Staff>)->AppResult<Json<Value>>{
    let r=sqlx::query("UPDATE rental_staff SET name=$3,branch_id=$4,group_id=$5,active=$6,revision=revision+1,
      invite_digest=CASE WHEN $6 THEN invite_digest END,expires_at=CASE WHEN $6 THEN expires_at END WHERE owner_id=$1 AND id=$2 AND revision=$7")
        .bind(owner(&s,&u).await?).bind(id).bind(name(&v.name)?).bind(v.branch_id).bind(v.group_id).bind(v.active.unwrap_or(true)).bind(v.revision).execute(&s.db).await.map_err(db)?;
    if r.rows_affected()!=1{return Err(changed());}Ok(Json(json!({"id":id})))
}
async fn reissue(State(s):State<AppState>,u:AuthUser,Path(id):Path<i64>)->AppResult<Json<Value>>{
    let (code,hash)=token();
    let r=sqlx::query("UPDATE rental_staff SET invite_digest=$3,expires_at=now()+interval '7 days',revision=revision+1 WHERE owner_id=$1 AND id=$2 AND active AND account_id IS NULL")
        .bind(owner(&s,&u).await?).bind(id).bind(hash).execute(&s.db).await?;
    if r.rows_affected()!=1{return Err(changed());}Ok(Json(json!({"id":id,"code":code})))
}
#[derive(Deserialize)]struct Code{code:String}
async fn join(State(s):State<AppState>,u:AuthUser,Json(v):Json<Code>)->AppResult<Json<Value>>{
    let code=v.code.trim(); if code.len()!=32{return Err(invalid("초대 코드를 확인해 주세요."));}
    let hash=format!("{:x}",Sha256::digest(code.as_bytes()));
    let id:i64=sqlx::query_scalar("UPDATE rental_staff t SET account_id=$1,invite_digest=NULL,expires_at=NULL,revision=revision+1 FROM users a,users o
      WHERE a.id=$1 AND o.id=t.owner_id AND o.account_type='rentcar' AND t.owner_id<>$1 AND lower(a.email)=t.email AND t.invite_digest=$2 AND t.account_id IS NULL AND t.active AND t.expires_at>now() RETURNING owner_id")
        .bind(u.user_id).bind(hash).fetch_optional(&s.db).await.map_err(db)?.ok_or(AppError::Forbidden)?;
    Ok(Json(json!({"owner_id":id})))
}
async fn memberships(State(s):State<AppState>,u:AuthUser)->AppResult<Json<Value>>{
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('owner_id',t.owner_id,'company',o.display_name,'branch',b.name,'group',g.name) FROM rental_staff t JOIN users o ON o.id=t.owner_id AND o.account_type='rentcar' JOIN rental_branches b ON b.id=t.branch_id JOIN rental_staff_groups g ON g.id=t.group_id WHERE t.account_id=$1 AND t.active ORDER BY o.display_name,t.owner_id")
        .bind(u.user_id).fetch_all(&s.db).await?;
    Ok(Json(json!(rows)))
}
async fn desk(State(s):State<AppState>,u:AuthUser,Path(id):Path<i64>)->AppResult<Json<Value>>{
    let obj:Value=sqlx::query_scalar(include_str!("rental_staff_desk.sql")).bind(u.user_id).bind(id).fetch_optional(&s.db).await?.ok_or(AppError::Forbidden)?;
    Ok(Json(obj))
}
#[derive(Deserialize)]struct Note{body:String}
async fn note(State(s):State<AppState>,u:AuthUser,Path((id,contract)):Path<(i64,i64)>,Json(v):Json<Note>)->AppResult<Json<Value>>{
    let body=v.body.trim();if !(1..=500).contains(&body.chars().count()){return Err(invalid("메모를 1~500자로 입력해 주세요."));}
    let id:i64=sqlx::query_scalar("INSERT INTO rental_handover_notes(contract_id,staff_id,branch_id,body)
      SELECT c.id,t.id,b.id,$4 FROM rental_staff t JOIN rental_branches b ON b.id=t.branch_id JOIN rental_staff_groups g ON g.id=t.group_id JOIN users o ON o.id=t.owner_id AND o.account_type='rentcar'
      JOIN rental_contracts c ON c.user_id=t.owner_id AND c.id=$3
      WHERE t.account_id=$1 AND t.owner_id=$2 AND t.active AND 'handover_note'=ANY(g.permissions) AND 'dispatch_read'=ANY(g.permissions)
        AND b.name IN(c.pickup_location,c.return_location) FOR SHARE OF t,g,b,c RETURNING id")
        .bind(u.user_id).bind(id).bind(contract).bind(body).fetch_optional(&s.db).await?.ok_or(AppError::Forbidden)?;
    Ok(Json(json!({"id":id})))
}
