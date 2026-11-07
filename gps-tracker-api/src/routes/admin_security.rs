use crate::{
    auth::{password, AdminUser},
    error::{AppError, AppResult},
    services::admin_security::{self as sec, Proposal, Verified},
    state::AppState,
};
use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/security/status", get(status))
        .route("/admin/security/enroll", post(enroll))
        .route("/admin/security/verify", post(verify))
        .route("/admin/security/logout", post(logout))
        .route("/admin/security/principals", get(principals))
        .route(
            "/admin/security/principals/:id",
            axum::routing::patch(update_principal),
        )
        .route("/admin/security/events", get(events))
        .route("/admin/security/approvals", get(approvals).post(propose))
        .route("/admin/security/approvals/:id/decision", post(decide))
}
async fn who(s: &AppState, h: &HeaderMap, peer: SocketAddr) -> AppResult<(i64, String)> {
    if !sec::enabled() {
        return Err(AppError::Conflict(
            "관리자 보안 기능이 아직 활성화되지 않았습니다.".into(),
        ));
    }
    let uid = sec::identity(h, s)?;
    let ip = sec::client_ip(peer, h)?.to_string();
    sec::principal(s, uid, &ip).await?;
    Ok((uid, ip))
}
async fn status(
    State(s): State<AppState>,
    h: HeaderMap,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> AppResult<Json<Value>> {
    if !sec::enabled() {
        return Ok(Json(json!({"enforced":false})));
    }
    let (uid, ip) = who(&s, &h, peer).await?;
    let enrolled: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM admin_mfa WHERE user_id=$1 AND nonce IS NOT NULL)",
    )
    .bind(uid)
    .fetch_one(&s.db)
    .await?;
    let verified = sec::authenticate(&s, &h, peer).await.ok();
    let p = sec::principal(&s, uid, &ip).await?;
    Ok(Json(
        json!({"enforced":true,"enrolled":enrolled,"verified":verified.is_some(),"role":p.role,"subject_ids":if verified.is_some(){p.subject_ids}else{vec![]},"ip":ip,"session_minutes":15,"password_days":90}),
    ))
}
#[derive(Deserialize)]
struct Credentials {
    password: String,
    #[serde(default)]
    code: String,
}
async fn enroll(
    State(s): State<AppState>,
    h: HeaderMap,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(c): Json<Credentials>,
) -> AppResult<Json<Value>> {
    let (uid, ip) = who(&s, &h, peer).await?;
    let mut tx = s.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(1910,$1::int)")
        .bind(uid as i32)
        .execute(&mut *tx)
        .await?;
    let pw: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(uid)
        .fetch_one(&mut *tx)
        .await?;
    // Account-level failures shared by enrollment and verification, including valid stolen JWTs.
    sqlx::query(
        "INSERT INTO admin_mfa(user_id,password_hash) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(uid)
    .bind(&pw)
    .execute(&mut *tx)
    .await?;
    let(enrolled,locked):(bool,bool)=sqlx::query_as("SELECT nonce IS NOT NULL,COALESCE(locked_until>now(),false) FROM admin_mfa WHERE user_id=$1 FOR UPDATE").bind(uid).fetch_one(&mut *tx).await?;
    if locked {
        return Err(AppError::TooManyRequests(
            "관리자 인증이 잠겼습니다. 15분 후 다시 시도해 주세요.".into(),
        ));
    }
    if enrolled {
        return Err(AppError::Conflict(
            "이미 등록된 OTP입니다. 분실 시 책임자 승인으로 초기화해 주세요.".into(),
        ));
    }
    if !password::verify(&c.password, &pw) {
        failure(&mut tx, uid).await?;
        tx.commit().await?;
        sec::event(
            &s,
            Some(uid),
            &ip,
            "mfa_enroll",
            "/admin/security/enroll",
            "denied",
            None,
        )
        .await?;
        return Err(AppError::Unauthorized);
    }
    if !sec::password_valid(&c.password) {
        return Err(AppError::BadRequest(
            "먼저 영문·숫자·특수문자를 포함한 9자 이상 비밀번호로 변경해 주세요.".into(),
        ));
    }
    let nonce = Uuid::new_v4().to_string();
    let secret = sec::secret(uid, &nonce)?;
    sqlx::query("UPDATE admin_mfa SET pending_nonce=$2,pending_until=now()+interval '10 minutes',failures=0,password_hash=$3,password_set_at=now() WHERE user_id=$1").bind(uid).bind(&nonce).bind(pw).execute(&mut *tx).await?;
    tx.commit().await?;
    sec::event(
        &s,
        Some(uid),
        &ip,
        "mfa_enroll",
        "/admin/security/enroll",
        "pending",
        None,
    )
    .await?;
    Ok(Json(
        json!({"secret":secret,"uri":format!("otpauth://totp/GPS:admin-{uid}?secret={secret}&issuer=GPS&algorithm=SHA256&digits=6&period=30"),"algorithm":"SHA256","digits":6,"period":30,"expires_in":600}),
    ))
}
async fn failure(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, uid: i64) -> AppResult<()> {
    sqlx::query("UPDATE admin_mfa SET failures=CASE WHEN locked_until<=now() THEN 1 ELSE failures+1 END,locked_until=CASE WHEN (CASE WHEN locked_until<=now() THEN 1 ELSE failures+1 END)>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE user_id=$1").bind(uid).execute(&mut **tx).await?;
    Ok(())
}
async fn verify(
    State(s): State<AppState>,
    h: HeaderMap,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(c): Json<Credentials>,
) -> AppResult<Json<Value>> {
    let (uid, ip) = who(&s, &h, peer).await?;
    let p = sec::principal(&s, uid, &ip).await?;
    let mut tx = s.db.begin().await?;
    type MfaRow = (
        Option<String>,
        Option<String>,
        Option<DateTime<Utc>>,
        i64,
        bool,
        String,
        DateTime<Utc>,
    );
    let row:Option<MfaRow>=sqlx::query_as("SELECT nonce,pending_nonce,pending_until,last_counter,COALESCE(locked_until>now(),false),password_hash,password_set_at FROM admin_mfa WHERE user_id=$1 FOR UPDATE").bind(uid).fetch_optional(&mut *tx).await?;
    let Some((active, pending, until, last, locked, oldpw, set_at)) = row else {
        return Err(AppError::Conflict("OTP를 먼저 등록해 주세요.".into()));
    };
    if locked {
        return Err(AppError::TooManyRequests(
            "관리자 인증이 잠겼습니다. 15분 후 다시 시도해 주세요.".into(),
        ));
    }
    let pw: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(uid)
        .fetch_one(&mut *tx)
        .await?;
    let changed = pw != oldpw;
    let nonce = active.clone().or_else(|| {
        if until.is_some_and(|t| t > Utc::now()) {
            pending
        } else {
            None
        }
    });
    let counter = if let Some(n) = &nonce {
        sec::verify_code(uid, n, &c.code, last)?
    } else {
        None
    };
    if !password::verify(&c.password, &pw) || counter.is_none() {
        failure(&mut tx, uid).await?;
        tx.commit().await?;
        sec::event(
            &s,
            Some(uid),
            &ip,
            "mfa_verify",
            "/admin/security/verify",
            "denied",
            None,
        )
        .await?;
        return Err(AppError::Unauthorized);
    }
    if !sec::password_valid(&c.password)
        || (!changed && set_at < Utc::now() - chrono::Duration::days(90))
    {
        return Err(AppError::Conflict(
            "관리자 비밀번호를 변경한 뒤 다시 인증해 주세요.".into(),
        ));
    }
    sqlx::query("UPDATE admin_mfa SET nonce=$2,pending_nonce=NULL,pending_until=NULL,last_counter=$3,failures=0,locked_until=NULL,password_hash=$4,password_set_at=CASE WHEN password_hash<>$4 THEN now() ELSE password_set_at END WHERE user_id=$1").bind(uid).bind(nonce).bind(counter).bind(&pw).execute(&mut *tx).await?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO admin_sessions(token_hash,user_id,ip,principal_revision,password_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')").bind(sec::hash(token.as_bytes())).bind(uid).bind(&ip).bind(p.revision).bind(pw).execute(&mut *tx).await?;
    tx.commit().await?;
    sec::event(
        &s,
        Some(uid),
        &ip,
        "mfa_verify",
        "/admin/security/verify",
        "verified",
        None,
    )
    .await?;
    Ok(Json(
        json!({"session":token,"expires_in":900,"role":p.role}),
    ))
}
async fn logout(State(s): State<AppState>, _: AdminUser, h: HeaderMap) -> AppResult<Json<Value>> {
    let token = h
        .get("x-admin-session")
        .and_then(|x| x.to_str().ok())
        .unwrap_or("");
    sqlx::query("UPDATE admin_sessions SET revoked_at=now() WHERE token_hash=$1")
        .bind(sec::hash(token.as_bytes()))
        .execute(&s.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}
async fn principals(State(s): State<AppState>, _: AdminUser) -> AppResult<Json<Value>> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(p)||jsonb_build_object('name',u.display_name,'email',u.email,'mfa_enrolled',m.nonce IS NOT NULL) FROM admin_principals p JOIN users u ON u.id=p.user_id LEFT JOIN admin_mfa m ON m.user_id=p.user_id ORDER BY p.user_id").fetch_all(&s.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
struct PrincipalEdit {
    role: String,
    enabled: bool,
    allowed_cidrs: Vec<String>,
    #[serde(default)]
    subject_ids: Vec<i64>,
    #[serde(default)]
    reset_mfa: bool,
}
async fn update_principal(
    State(s): State<AppState>,
    a: AdminUser,
    Path(id): Path<i64>,
    h: HeaderMap,
    Json(q): Json<PrincipalEdit>,
) -> AppResult<Json<Value>> {
    if !matches!(q.role.as_str(), "officer" | "operator" | "handler")
        || q.allowed_cidrs.is_empty()
        || q.allowed_cidrs.len() > 16
        || q.subject_ids.len() > 200
        || q.subject_ids.iter().any(|n| *n <= 0)
    {
        return Err(AppError::BadRequest(
            "역할·허용 IP·담당 계정을 확인해 주세요.".into(),
        ));
    }
    let cidrs: Vec<ipnet::IpNet> = q
        .allowed_cidrs
        .iter()
        .map(|s| {
            s.parse()
                .map_err(|_| AppError::BadRequest("올바른 IP/CIDR을 입력해 주세요.".into()))
        })
        .collect::<AppResult<_>>()?;
    if cidrs.iter().any(|n| n.prefix_len() == 0) {
        return Err(AppError::BadRequest(
            "전체 인터넷 허용은 사용할 수 없습니다.".into(),
        ));
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(1911,0)")
        .execute(&mut *tx)
        .await?;
    let user: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT email,display_name FROM users WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((_, name)) = user else {
        return Err(AppError::NotFound);
    };
    if name.unwrap_or_default().trim().is_empty() {
        return Err(AppError::BadRequest(
            "담당자 실명으로 만든 개인 계정이 필요합니다.".into(),
        ));
    }
    // Recheck the approved principal version while holding the same serialization lock as all role edits.
    let aid: i64 = h
        .get("x-admin-approval")
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.parse().ok())
        .ok_or(AppError::Forbidden)?;
    let before: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM admin_principals p WHERE user_id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let expected:String=sqlx::query_scalar("SELECT target_fingerprint FROM admin_approvals WHERE id=$1 AND requester_id=$2 AND status='consumed'").bind(aid).bind(a.user_id).fetch_one(&mut *tx).await?;
    if sec::hash(before.clone().unwrap_or(Value::Null).to_string().as_bytes()) != expected {
        return Err(AppError::Conflict(
            "대상이 변경되어 새 승인이 필요합니다.".into(),
        ));
    }
    let old: Option<String> =
        sqlx::query_scalar("SELECT role FROM admin_principals WHERE user_id=$1 AND enabled")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(old) = old {
        if matches!(old.as_str(), "officer" | "operator") && (q.role != old || !q.enabled) {
            let others: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM admin_principals WHERE role=$1 AND enabled AND user_id<>$2",
            )
            .bind(old)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if others == 0 {
                return Err(AppError::Conflict(
                    "마지막 책임자 또는 관리자를 해제할 수 없습니다.".into(),
                ));
            }
        }
    }
    sqlx::query("UPDATE users SET role='admin' WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO admin_principals(user_id,role,enabled,allowed_cidrs,subject_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET role=$2,enabled=$3,allowed_cidrs=$4,subject_ids=$5,revision=admin_principals.revision+1").bind(id).bind(q.role).bind(q.enabled).bind(cidrs.iter().map(|n|n.to_string()).collect::<Vec<_>>()).bind(q.subject_ids).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE admin_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if q.reset_mfa {
        sqlx::query("UPDATE admin_mfa SET nonce=NULL,pending_nonce=NULL,pending_until=NULL,last_counter=-1,failures=0,locked_until=NULL WHERE user_id=$1").bind(id).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO admin_audit_log(admin_id,target_user,action,data) VALUES($1,$2,'admin_principal_changed',jsonb_build_object('reset_mfa',$3::boolean,'before',$4::jsonb,'after',(SELECT to_jsonb(p) FROM admin_principals p WHERE user_id=$2),'approval_id',$5::bigint))").bind(a.user_id).bind(id).bind(q.reset_mfa).bind(before).bind(aid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
async fn events(State(s): State<AppState>, _: AdminUser) -> AppResult<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM admin_security_events e ORDER BY id DESC LIMIT 200",
    )
    .fetch_all(&s.db)
    .await?;
    Ok(Json(json!(rows)))
}
async fn approvals(State(s): State<AppState>, _: AdminUser) -> AppResult<Json<Value>> {
    let rows: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM admin_approvals a ORDER BY id DESC LIMIT 100")
            .fetch_all(&s.db)
            .await?;
    Ok(Json(json!(rows)))
}
async fn propose(
    State(s): State<AppState>,
    _: AdminUser,
    Extension(v): Extension<Verified>,
    Json(q): Json<Proposal>,
) -> AppResult<Json<Value>> {
    if v.principal.role != "operator" {
        return Err(AppError::Forbidden);
    }
    if q.reason.trim().is_empty() || q.reason.len() > 300 || q.payload.to_string().len() > 65536 {
        return Err(AppError::BadRequest(
            "처리 근거와 작업 내용을 확인해 주세요.".into(),
        ));
    }
    let fp = sec::fingerprint(&s, &q.method, &q.path).await?;
    let id:i64=sqlx::query_scalar("INSERT INTO admin_approvals(requester_id,requester_revision,method,path,payload,digest,target_fingerprint,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id").bind(v.principal.user_id).bind(v.principal.revision).bind(&q.method).bind(&q.path).bind(&q.payload).bind(sec::digest(&q.method,&q.path,&q.payload)).bind(fp).bind(q.reason.trim()).fetch_one(&s.db).await?;
    sec::event(
        &s,
        Some(v.principal.user_id),
        &v.ip,
        "propose",
        "/admin/security/approvals",
        "pending",
        Some(id),
    )
    .await?;
    Ok(Json(json!({"id":id,"status":"pending"})))
}
#[derive(Deserialize)]
struct Decision {
    approve: bool,
}
async fn decide(
    State(s): State<AppState>,
    _: AdminUser,
    Extension(v): Extension<Verified>,
    Path(id): Path<i64>,
    Json(q): Json<Decision>,
) -> AppResult<Json<Value>> {
    if v.principal.role != "officer" {
        return Err(AppError::Forbidden);
    }
    let mut tx = s.db.begin().await?;
    let row:Option<(i64,String,String,String,String)>=sqlx::query_as("SELECT requester_id,status,method,path,target_fingerprint FROM admin_approvals WHERE id=$1 AND expires_at>now() FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let Some((owner, status, method, path, fp)) = row else {
        return Err(AppError::NotFound);
    };
    if owner == v.principal.user_id || status != "pending" {
        return Err(AppError::Conflict(
            "본인 요청이거나 이미 처리한 승인입니다.".into(),
        ));
    }
    if q.approve && sec::fingerprint(&s, &method, &path).await? != fp {
        return Err(AppError::Conflict(
            "대상이 변경되었습니다. 새 승인을 요청해 주세요.".into(),
        ));
    }
    sqlx::query("UPDATE admin_approvals SET status=$2,approver_id=$3,approver_revision=$4,approved_at=now() WHERE id=$1").bind(id).bind(if q.approve{"approved"}else{"rejected"}).bind(v.principal.user_id).bind(v.principal.revision).execute(&mut *tx).await?;
    tx.commit().await?;
    sec::event(
        &s,
        Some(v.principal.user_id),
        &v.ip,
        "decision",
        "/admin/security/approvals/:id/decision",
        if q.approve { "approved" } else { "rejected" },
        Some(id),
    )
    .await?;
    Ok(Json(json!({"ok":true})))
}
