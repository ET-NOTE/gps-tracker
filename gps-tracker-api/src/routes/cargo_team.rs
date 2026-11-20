use axum::{extract::{Path, State}, routing::{get, post, put}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use super::cargo::CargoOwner;
use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/cargo/team/config",get(config))
        .route("/cargo/team/company",put(company))
        .route("/cargo/team/groups",post(create_group))
        .route("/cargo/team/groups/:id",put(update_group))
        .route("/cargo/team/staff",post(invite))
        .route("/cargo/team/staff/:id",put(update_staff))
        .route("/cargo/team/staff/:id/invite",post(reissue))
        .route("/cargo/team/join",post(join))
        .route("/cargo/team/memberships",get(memberships))
        .route("/cargo/team/desk/:owner",get(desk))
        .route("/cargo/team/desk/:owner/:shipment/notes",post(note))
}
const CAPS: [&str;3] = ["dispatch_read","fleet_read","handover_note"];
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
async fn config(State(s):State<AppState>,u:CargoOwner)->AppResult<Json<Value>>{
    let id=u.user_id;
    let data=sqlx::query_scalar("SELECT jsonb_build_object(
      'branches',coalesce((SELECT data->'branches' FROM cargo_workspaces WHERE owner_id=$1),'[]'),
      'company',coalesce((SELECT to_jsonb(c)-'owner_id' FROM cargo_companies c WHERE owner_id=$1),jsonb_build_object('name',(SELECT display_name FROM users WHERE id=$1),'revision',0)),
      'groups',(SELECT coalesce(jsonb_agg(to_jsonb(g)-'owner_id' ORDER BY name),'[]') FROM cargo_staff_groups g WHERE owner_id=$1),
      'staff',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email,'active',active,'branch_id',branch_id,'group_id',group_id,'revision',revision,'joined',account_id IS NOT NULL,'expires_at',expires_at) ORDER BY name),'[]') FROM cargo_staff WHERE owner_id=$1),
      'notes',(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY id DESC),'[]') FROM (SELECT n.id,n.shipment_id,n.body,n.created_at,coalesce(b->>'name','미지정') branch,t.name staff FROM cargo_handover_notes n JOIN cargo_staff t ON t.id=n.staff_id JOIN cargo_workspaces w ON w.owner_id=t.owner_id LEFT JOIN LATERAL jsonb_array_elements(w.data->'branches') b ON b->>'id'=n.branch_id WHERE t.owner_id=$1 ORDER BY n.id DESC LIMIT 100) n))")
        .bind(id).fetch_one(&s.db).await?;
    Ok(Json(data))
}
#[derive(Deserialize)]
struct Company { name:String, representative:String, phone:String, business_number:String, address:String, revision:i32 }
async fn company(State(s):State<AppState>, u:CargoOwner, Json(v):Json<Company>)->AppResult<Json<Value>> {
    let id=u.user_id;
    if v.address.chars().count()>300 || [&v.phone,&v.representative,&v.business_number].iter().any(|x|x.chars().count()>80) {return Err(invalid("회사 정보 길이를 확인해 주세요."));}
    let n=name(&v.name)?;
    let rev:Option<i32>=if v.revision==0 {
        sqlx::query_scalar("INSERT INTO cargo_companies(owner_id,name,representative,phone,business_number,address) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING revision").bind(id).bind(n).bind(v.representative.trim()).bind(v.phone.trim()).bind(v.business_number.trim()).bind(v.address.trim()).fetch_optional(&s.db).await?
    } else {
        sqlx::query_scalar("UPDATE cargo_companies SET name=$2,representative=$3,phone=$4,business_number=$5,address=$6,revision=revision+1 WHERE owner_id=$1 AND revision=$7 RETURNING revision").bind(id).bind(n).bind(v.representative.trim()).bind(v.phone.trim()).bind(v.business_number.trim()).bind(v.address.trim()).bind(v.revision).fetch_optional(&s.db).await?
    }; Ok(Json(json!({"revision":rev.ok_or_else(changed)?})))
}
#[derive(Deserialize)] struct Group {name:String,permissions:Vec<String>,revision:Option<i32>}
fn caps(v:&mut Group)->AppResult<()>{
    name(&v.name)?;v.permissions.sort();v.permissions.dedup();
    if v.permissions.iter().any(|p|!CAPS.contains(&p.as_str())) || (v.permissions.iter().any(|p|p=="handover_note")&&!v.permissions.iter().any(|p|p=="dispatch_read")) {
        return Err(invalid("인수인계 메모 작성에는 배차 조회 권한이 필요합니다."));
    }
    Ok(())
}
async fn create_group(State(s):State<AppState>,u:CargoOwner,Json(mut v):Json<Group>)->AppResult<Json<Value>>{
    caps(&mut v)?;
    let id:i64=sqlx::query_scalar("INSERT INTO cargo_staff_groups(owner_id,name,permissions) VALUES($1,$2,$3) RETURNING id")
        .bind(u.user_id).bind(v.name.trim()).bind(v.permissions).fetch_one(&s.db).await.map_err(db)?;
    Ok(Json(json!({"id":id})))
}
async fn update_group(State(s):State<AppState>,u:CargoOwner,Path(id):Path<i64>,Json(mut v):Json<Group>)->AppResult<Json<Value>>{
    caps(&mut v)?;
    let row=sqlx::query("UPDATE cargo_staff_groups SET name=$3,permissions=$4,revision=revision+1 WHERE owner_id=$1 AND id=$2 AND revision=$5")
        .bind(u.user_id).bind(id).bind(v.name.trim()).bind(v.permissions).bind(v.revision).execute(&s.db).await.map_err(db)?;
    if row.rows_affected()!=1{return Err(changed());} Ok(Json(json!({"id":id})))
}
#[derive(Deserialize)]struct Staff {name:String, email:Option<String>,branch_id:String,group_id:i64,active:Option<bool>,revision:Option<i32>}
fn token()->(String,String){
    let code=uuid::Uuid::new_v4().simple().to_string();
    let hash=format!("{:x}",Sha256::digest(code.as_bytes()));(code,hash)
}
async fn invite(State(s):State<AppState>,u:CargoOwner,Json(v):Json<Staff>)->AppResult<Json<Value>>{
    let email=v.email.unwrap_or_default().trim().to_lowercase();
    if email.len()>254||!email.split_once('@').is_some_and(|(a,b)|!a.is_empty()&&b.contains('.')){return Err(invalid("직원 이메일을 확인해 주세요."));}
    let (code,hash)=token();
    let id:i64=sqlx::query_scalar("INSERT INTO cargo_staff(owner_id,email,name,branch_id,group_id,invite_digest,expires_at) SELECT $1,$2,$3,$4,$5,$6,now()+interval '7 days' FROM cargo_workspaces WHERE owner_id=$1 AND EXISTS(SELECT FROM jsonb_array_elements(data->'branches') b WHERE b->>'id'=$4 AND coalesce((b->>'active')::boolean,true)) RETURNING id")
        .bind(u.user_id).bind(email).bind(name(&v.name)?).bind(v.branch_id).bind(v.group_id).bind(hash).fetch_optional(&s.db).await.map_err(db)?.ok_or_else(||invalid("소속 지점을 확인해 주세요."))?;
    Ok(Json(json!({"id":id,"code":code})))
}
async fn update_staff(State(s):State<AppState>,u:CargoOwner,Path(id):Path<i64>,Json(v):Json<Staff>)->AppResult<Json<Value>>{
    let r=sqlx::query("UPDATE cargo_staff SET name=$3,branch_id=$4,group_id=$5,active=$6,revision=revision+1,
      invite_digest=CASE WHEN $6 THEN invite_digest END,expires_at=CASE WHEN $6 THEN expires_at END WHERE owner_id=$1 AND id=$2 AND revision=$7 AND EXISTS(SELECT FROM cargo_workspaces w, jsonb_array_elements(w.data->'branches') b WHERE w.owner_id=$1 AND b->>'id'=$4)")
        .bind(u.user_id).bind(id).bind(name(&v.name)?).bind(v.branch_id).bind(v.group_id).bind(v.active.unwrap_or(true)).bind(v.revision).execute(&s.db).await.map_err(db)?;
    if r.rows_affected()!=1{return Err(changed());}Ok(Json(json!({"id":id})))
}
async fn reissue(State(s):State<AppState>,u:CargoOwner,Path(id):Path<i64>)->AppResult<Json<Value>>{
    let (code,hash)=token();
    let r=sqlx::query("UPDATE cargo_staff SET invite_digest=$3,expires_at=now()+interval '7 days',revision=revision+1 WHERE owner_id=$1 AND id=$2 AND active AND account_id IS NULL")
        .bind(u.user_id).bind(id).bind(hash).execute(&s.db).await?;
    if r.rows_affected()!=1{return Err(changed());}Ok(Json(json!({"id":id,"code":code})))
}
#[derive(Deserialize)]struct Code{code:String}
async fn join(State(s):State<AppState>,u:AuthUser,Json(v):Json<Code>)->AppResult<Json<Value>>{
    let code=v.code.trim(); if code.len()!=32{return Err(invalid("초대 코드를 확인해 주세요."));}
    let hash=format!("{:x}",Sha256::digest(code.as_bytes()));
    let id:i64=sqlx::query_scalar("UPDATE cargo_staff t SET account_id=$1,invite_digest=NULL,expires_at=NULL,revision=revision+1 FROM users a,users o
      WHERE a.id=$1 AND o.id=t.owner_id AND gps_owner_service(o,'delivery') AND t.owner_id<>$1 AND lower(a.email)=t.email AND t.invite_digest=$2 AND t.account_id IS NULL AND t.active AND t.expires_at>now() RETURNING owner_id")
        .bind(u.user_id).bind(hash).fetch_optional(&s.db).await.map_err(db)?.ok_or(AppError::Forbidden)?;
    Ok(Json(json!({"owner_id":id})))
}
async fn memberships(State(s):State<AppState>,u:AuthUser)->AppResult<Json<Value>>{
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('owner_id',t.owner_id,'company',coalesce(c.name,o.display_name),'branch',b->>'name','group',g.name) FROM cargo_staff t JOIN users o ON o.id=t.owner_id AND gps_owner_service(o,'delivery') JOIN cargo_workspaces w ON w.owner_id=t.owner_id JOIN LATERAL jsonb_array_elements(w.data->'branches') b ON b->>'id'=t.branch_id AND coalesce((b->>'active')::boolean,true) LEFT JOIN cargo_companies c ON c.owner_id=t.owner_id JOIN cargo_staff_groups g ON g.id=t.group_id WHERE t.account_id=$1 AND t.active ORDER BY o.display_name,t.owner_id")
        .bind(u.user_id).fetch_all(&s.db).await?;
    Ok(Json(json!(rows)))
}
async fn desk(State(s):State<AppState>,u:AuthUser,Path(id):Path<i64>)->AppResult<Json<Value>>{
    let obj:Value=sqlx::query_scalar(include_str!("cargo_staff_desk.sql")).bind(u.user_id).bind(id).fetch_optional(&s.db).await?.ok_or(AppError::Forbidden)?;
    Ok(Json(obj))
}
#[derive(Deserialize)]struct Note{body:String}
async fn note(State(s):State<AppState>,u:AuthUser,Path((id,shipment)):Path<(i64,String)>,Json(v):Json<Note>)->AppResult<Json<Value>>{
    let body=v.body.trim();if !(1..=500).contains(&body.chars().count()){return Err(invalid("메모를 1~500자로 입력해 주세요."));}
    let id:i64=sqlx::query_scalar("INSERT INTO cargo_handover_notes(shipment_id,staff_id,branch_id,body) SELECT j->>'id',t.id,t.branch_id,$4 FROM cargo_staff t JOIN cargo_staff_groups g ON g.id=t.group_id JOIN users o ON o.id=t.owner_id AND gps_owner_service(o,'delivery') JOIN cargo_workspaces w ON w.owner_id=t.owner_id CROSS JOIN LATERAL jsonb_array_elements(w.data->'shipments') j WHERE t.account_id=$1 AND t.owner_id=$2 AND t.active AND 'handover_note'=ANY(g.permissions) AND 'dispatch_read'=ANY(g.permissions) AND j->>'id'=$3 AND j->>'branchId'=t.branch_id AND EXISTS(SELECT FROM jsonb_array_elements(w.data->'branches') b WHERE b->>'id'=t.branch_id AND coalesce((b->>'active')::boolean,true)) FOR SHARE OF t,g,w RETURNING id")
        .bind(u.user_id).bind(id).bind(shipment).bind(body).fetch_optional(&s.db).await?.ok_or(AppError::Forbidden)?;
    Ok(Json(json!({"id":id})))
}
