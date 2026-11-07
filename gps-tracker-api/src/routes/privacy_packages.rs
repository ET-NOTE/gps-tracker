//! Deliberately bounded access delivery, not a complete subject-data dump.
//! Personal uploads retain their uploader boundary; company and shared paths fail closed.
use super::privacy_delivery::{active, no_store, rate_limit};
use crate::{
    auth::{password, AdminUser, AuthUser},
    error::{AppError, AppResult},
    services::{privacy::RequestRow, privacy_account_export, privacy_location_facts},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/privacy/requests/:id/account-packages", get(list))
        .route("/privacy/account-packages/:id/account", post(account))
        .route(
            "/privacy/account-packages/:id/documents/:document",
            post(document),
        )
        .route(
            "/admin/privacy/requests/:id/account-packages",
            get(admin_list).post(issue),
        )
        .route(
            "/admin/privacy/requests/:id/personal-documents",
            get(options),
        )
        .route(
            "/admin/privacy/requests/:id/documents/:document/review",
            post(review_document),
        )
        .route("/admin/privacy/account-packages/:id/revoke", post(revoke))
        .layer(middleware::from_fn(no_store))
}

#[derive(Serialize, FromRow)]
struct Package {
    id: i64,
    request_id: i64,
    documents: Value,
    sections: Vec<String>,
    facts_from: Option<DateTime<Utc>>,
    facts_until: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
struct Proof {
    id: i64,
    sha256: String,
}
#[derive(Deserialize)]
struct Issue {
    revision: i32,
    confirmed: bool,
    documents: Vec<Proof>,
    #[serde(default)]
    sections: Vec<String>,
    /// The period of the collection, use and provision facts; given with that section only.
    #[serde(default)]
    facts_from: Option<DateTime<Utc>>,
    #[serde(default)]
    facts_until: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
struct Download {
    password: String,
}
#[derive(FromRow)]
struct Doc {
    id: i64,
    user_id: i64,
    device_id: i64,
    filename: String,
    stored_path: String,
    mime: String,
    size_bytes: i64,
    kind: String,
    uploaded_at: DateTime<Utc>,
}
const LIMIT: u64 = 10 * 1024 * 1024;
const ELIGIBLE:&str="d.user_id=$1 AND d.fleet_vehicle_id IS NULL AND d.device_id IS NOT NULL AND EXISTS(SELECT 1 FROM gps_read_devices v WHERE v.id=d.device_id AND v.owner_id=d.user_id) AND NOT EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.device_id=d.device_id) AND NOT EXISTS(SELECT 1 FROM device_data_controls c WHERE c.device_id=d.device_id AND c.blocked) AND NOT EXISTS(SELECT 1 FROM device_documents x WHERE x.stored_path=d.stored_path AND x.id<>d.id)";
fn conflict() -> AppError {
    AppError::Conflict("제공 범위 또는 파일이 변경됐습니다. 담당자의 재검토가 필요합니다.".into())
}
async fn begin(state: &AppState) -> AppResult<Transaction<'_, Postgres>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
async fn review_request(tx: &mut Transaction<'_, Postgres>, id: i64) -> AppResult<RequestRow> {
    let row: RequestRow = sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::NotFound)?;
    if row.kind != "access"
        || !matches!(row.status.as_str(), "in_review" | "needs_information")
        || row.due_at.is_none()
    {
        return Err(conflict());
    }
    active(tx, row.user_id).await?;
    Ok(row)
}
async fn scope_lock(tx: &mut Transaction<'_, Postgres>) -> AppResult<()> {
    // Serialize scope changes and cleanup while reading immutable server uploads.
    sqlx::query("LOCK TABLE device_documents,devices,device_data_controls,fleet_vehicle_bindings IN SHARE MODE").execute(&mut **tx).await?;
    Ok(())
}
async fn doc(tx: &mut Transaction<'_, Postgres>, uid: i64, id: i64) -> AppResult<Doc> {
    sqlx::query_as(&format!("SELECT d.id,d.user_id,d.device_id,d.filename,d.stored_path,d.mime,d.size_bytes,d.kind,d.uploaded_at FROM device_documents d WHERE {ELIGIBLE} AND d.id=$2"))
 .bind(uid).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(conflict)
}
fn extension(mime: &str) -> AppResult<&'static str> {
    match mime {
        "application/pdf" => Ok("pdf"),
        "image/jpeg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        _ => Err(conflict()),
    }
}
async fn bytes(db: &sqlx::PgPool, d: &Doc) -> AppResult<Vec<u8>> {
    extension(&d.mime)?;
    if d.size_bytes <= 0 || d.size_bytes > LIMIT as i64 {
        return Err(conflict());
    }
    let root = std::path::PathBuf::from(
        std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "/home/mmm/uploads".into()),
    );
    let path = std::path::PathBuf::from(&d.stored_path);
    let relative = path.strip_prefix(&root).map_err(|_| conflict())?;
    let parts: Vec<String> = relative
        .components()
        .map(|c| match c {
            std::path::Component::Normal(x) => x.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(conflict)?;
    if parts.len() != 4
        || parts[0] != "device_documents"
        || parts[1] != d.user_id.to_string()
        || parts[2] != d.device_id.to_string()
    {
        return Err(conflict());
    }
    let data = crate::services::private_files::read(db, &path).await?;
    if data.len() != d.size_bytes as usize {
        return Err(conflict());
    }
    Ok(data)
}
fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    rid: i64,
    pid: Option<i64>,
    uid: i64,
    action: &str,
    did: Option<i64>,
    sha: Option<&str>,
) -> AppResult<()> {
    sqlx::query("INSERT INTO privacy_account_package_events(request_id,package_id,actor_id,action,document_id,sha256) VALUES($1,$2,$3,$4,$5,$6)").bind(rid).bind(pid).bind(uid).bind(action).bind(did).bind(sha).execute(&mut **tx).await?;
    Ok(())
}
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<Package>>> {
    Ok(Json(sqlx::query_as("SELECT p.* FROM privacy_account_packages p JOIN privacy_requests r ON r.id=p.request_id WHERE r.id=$1 AND r.user_id=$2 ORDER BY p.id DESC LIMIT 20").bind(id).bind(user.user_id).fetch_all(&state.db).await?))
}
async fn admin_list(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let items: Vec<Package> = sqlx::query_as(
        "SELECT * FROM privacy_account_packages WHERE request_id=$1 ORDER BY id DESC LIMIT 20",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM privacy_account_package_events e WHERE request_id=$1 ORDER BY id DESC LIMIT 100").bind(id).fetch_all(&state.db).await?;
    Ok(Json(json!({"items":items,"events":events})))
}
async fn options(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = begin(&state).await?;
    let row = review_request(&mut tx, id).await?;
    let items:Vec<Value>=sqlx::query_scalar(&format!("SELECT jsonb_build_object('id',d.id,'filename',d.filename,'mime',d.mime,'size_bytes',d.size_bytes,'uploaded_at',d.uploaded_at) FROM device_documents d WHERE {ELIGIBLE} ORDER BY d.id LIMIT 101")).bind(row.user_id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":items.iter().take(100).collect::<Vec<_>>(),"more":items.len()>100}),
    ))
}
async fn review_document(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((id, did)): Path<(i64, i64)>,
) -> AppResult<Response> {
    let mut tx = begin(&state).await?;
    let row = review_request(&mut tx, id).await?;
    scope_lock(&mut tx).await?;
    let d = doc(&mut tx, row.user_id, did).await?;
    let data = bytes(&state.db, &d).await?;
    let sha = digest(&data);
    event(
        &mut tx,
        id,
        None,
        admin.user_id,
        "document_review",
        Some(did),
        Some(&sha),
    )
    .await?;
    tx.commit().await?;
    Ok((
        [
            (
                header::CONTENT_TYPE.to_string(),
                "application/octet-stream".into(),
            ),
            (
                header::CONTENT_DISPOSITION.to_string(),
                format!(
                    "attachment; filename=\"review-{did}.{}\"",
                    extension(&d.mime)?
                ),
            ),
            (
                "access-control-expose-headers".into(),
                "x-document-sha256".into(),
            ),
            ("x-document-sha256".into(), sha),
        ],
        data,
    )
        .into_response())
}
async fn issue(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(body): Json<Issue>,
) -> AppResult<Json<Package>> {
    if !body.confirmed
        || !privacy_account_export::valid_sections(&body.sections)
        || !privacy_location_facts::valid_period(
            body.sections
                .iter()
                .any(|s| s == privacy_location_facts::SECTION),
            body.facts_from,
            body.facts_until,
            Utc::now(),
        )
        || body.documents.len() > 20
        || body
            .documents
            .iter()
            .any(|d| d.id <= 0 || d.sha256.len() != 64)
        || body
            .documents
            .iter()
            .map(|d| d.id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != body.documents.len()
    {
        return Err(AppError::BadRequest(
            "제공 범위를 확인하고 첨부파일을 최대 20개 선택해 주세요. 수집·이용·제공사실은 과거에 시작하는 366일 이내의 기간이 필요합니다.".into(),
        ));
    }
    let mut tx = begin(&state).await?;
    let row = review_request(&mut tx, id).await?;
    if row.revision != body.revision {
        return Err(conflict());
    }
    scope_lock(&mut tx).await?;
    let mut documents = vec![];
    for proof in body.documents {
        let d = doc(&mut tx, row.user_id, proof.id).await?;
        let data = bytes(&state.db, &d).await?;
        let sha = digest(&data);
        let reviewed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_account_package_events WHERE request_id=$1 AND actor_id=$2 AND document_id=$3 AND sha256=$4 AND action='document_review' AND created_at>now()-interval '24 hours')").bind(id).bind(admin.user_id).bind(d.id).bind(&sha).fetch_one(&mut *tx).await?;
        if sha != proof.sha256 || !reviewed {
            return Err(conflict());
        }
        documents.push(json!({"id":d.id,"filename":d.filename,"mime":d.mime,"size_bytes":d.size_bytes,"sha256":sha,"kind":d.kind,"uploaded_at":d.uploaded_at}));
    }
    sqlx::query("WITH x AS(UPDATE privacy_account_packages SET revoked_at=now() WHERE request_id=$1 AND revoked_at IS NULL RETURNING id) INSERT INTO privacy_account_package_events(request_id,package_id,actor_id,action) SELECT $1,id,$2,'revoked' FROM x").bind(id).bind(admin.user_id).execute(&mut *tx).await?;
    let p:Package=sqlx::query_as("INSERT INTO privacy_account_packages(request_id,created_by,documents,sections,facts_from,facts_until) VALUES($1,$2,$3,$4,$5,CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE LEAST($6::timestamptz,now()) END) RETURNING *").bind(id).bind(admin.user_id).bind(json!(documents)).bind(&body.sections).bind(body.facts_from).bind(body.facts_until).fetch_one(&mut *tx).await?;
    event(&mut tx, id, Some(p.id), admin.user_id, "issued", None, None).await?;
    let message="계정 기본정보·요청 처리이력과 담당자가 선택한 추가 범위·개인 서류를 준비했습니다. 발급 내역의 포함 범위를 확인하고 24시간 이내 내려받으세요. 요청 전체의 제공 완료를 의미하지 않습니다.";
    sqlx::query("UPDATE privacy_requests SET revision=revision+1,assigned_to=$2,result_message=$3,updated_at=now() WHERE id=$1").bind(id).bind(admin.user_id).bind(message).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,due_at) SELECT id,$2,revision,status,$3,due_at FROM privacy_requests WHERE id=$1").bind(id).bind(admin.user_id).bind(message).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(p))
}
async fn revoke(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = begin(&state).await?;
    let rid:Option<i64>=sqlx::query_scalar("UPDATE privacy_account_packages SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING request_id").bind(id).fetch_optional(&mut *tx).await?;
    if let Some(rid) = rid {
        event(&mut tx, rid, Some(id), admin.user_id, "revoked", None, None).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    uid: i64,
    id: i64,
    body: Download,
) -> AppResult<Package> {
    let rid:Option<i64>=sqlx::query_scalar("SELECT p.request_id FROM privacy_account_packages p JOIN privacy_requests r ON r.id=p.request_id WHERE p.id=$1 AND r.user_id=$2").bind(id).bind(uid).fetch_optional(&mut **tx).await?;
    let status: String =
        sqlx::query_scalar("SELECT status FROM privacy_requests WHERE id=$1 FOR SHARE")
            .bind(rid.ok_or(AppError::NotFound)?)
            .fetch_one(&mut **tx)
            .await?;
    active(tx, uid).await?;
    let p: Package = sqlx::query_as("SELECT * FROM privacy_account_packages WHERE id=$1 FOR SHARE")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    if p.revoked_at.is_some()
        || p.expires_at <= Utc::now()
        || matches!(status.as_str(), "cancelled" | "rejected")
    {
        return Err(AppError::Gone(
            "자료가 만료되거나 회수됐습니다. 재발급을 요청해 주세요.".into(),
        ));
    }
    if body.password.len() > 1024 {
        return Err(AppError::Unauthorized);
    }
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1 FOR SHARE")
        .bind(uid)
        .fetch_one(&mut **tx)
        .await?;
    if !tokio::task::spawn_blocking(move || password::verify(&body.password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
    {
        return Err(AppError::Unauthorized);
    }
    Ok(p)
}
async fn account(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<Download>,
) -> AppResult<Response> {
    rate_limit(&state, &format!("user:{}", user.user_id), &headers).await?;
    let mut tx = begin(&state).await?;
    let p = authorize(&mut tx, user.user_id, id, body).await?;
    // Whitelists only. Never serialize users/prefs/security rows wholesale.
    let profile:Value=sqlx::query_scalar("SELECT jsonb_build_object('email',email,'display_name',display_name,'phone',phone,'secondary_phone',secondary_phone,'phone_verified',phone_verified,'created_at',created_at,'updated_at',updated_at) FROM users WHERE id=$1").bind(user.user_id).fetch_one(&mut *tx).await?;
    let requests:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',r.id,'kind',r.kind,'status',r.status,'scope',r.scope,'result_message',r.result_message,'created_at',r.created_at,'updated_at',r.updated_at,'due_at',r.due_at) FROM privacy_requests r WHERE r.user_id=$1 ORDER BY r.id LIMIT 201").bind(user.user_id).fetch_all(&mut *tx).await?;
    let history:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('request_id',e.request_id,'status',e.status,'message',e.message,'created_at',e.created_at) FROM privacy_request_events e JOIN privacy_requests r ON r.id=e.request_id WHERE r.user_id=$1 ORDER BY e.id LIMIT 2001").bind(user.user_id).fetch_all(&mut *tx).await?;
    if requests.len() > 200 || history.len() > 2000 {
        return Err(AppError::Conflict(
            "처리이력 제공 한도를 초과했습니다. 담당자에게 분할 제공을 요청해 주세요.".into(),
        ));
    }
    let additional = privacy_account_export::export(
        &mut tx,
        user.user_id,
        &p.sections,
        p.facts_from.zip(p.facts_until),
    )
    .await?;
    let mut coverage = vec![
        "current_account_basic_fields",
        "privacy_requests",
        "public_request_status_history",
        "reviewed_document_manifest",
    ];
    coverage.extend(p.sections.iter().map(String::as_str));
    let unselected: Vec<_> = privacy_account_export::SECTIONS
        .iter()
        .filter(|s| !p.sections.iter().any(|p| p == **s))
        .collect();
    let data=serde_json::to_vec_pretty(&json!({"format":if p.sections.is_empty(){"gps-personal-account-v1"}else{"gps-personal-account-v2"},"generated_at":Utc::now(),"request_id":p.request_id,"coverage":coverage,"unselected_sections":unselected,"excluded":["location_records:separate_csv","company_records:separate_review","unselected_attachments_and_vehicle_photos:separate_review","chat_ai_contents_device_preferences_security_audit_and_external_copies:separate_review","payment_credentials_raw_responses_internal_notes:excluded"],"account":profile,"requests":requests,"history":history,"reviewed_documents":p.documents,"additional":additional,"notice":"현재 남아 있는 지정 범위 자료입니다. 모든 개인정보의 제공 완료를 의미하지 않습니다. 추가 범위별 안내와 제외 목록을 확인하고 첨부 원본은 별도로 내려받으세요."})).map_err(|e|AppError::Internal(e.into()))?;
    event(
        &mut tx,
        p.request_id,
        Some(id),
        user.user_id,
        "account_prepared",
        None,
        Some(&digest(&data)),
    )
    .await?;
    tx.commit().await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/json; charset=utf-8".to_string(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"personal-account-{id}.json\""),
            ),
        ],
        data,
    )
        .into_response())
}
async fn document(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path((id, did)): Path<(i64, i64)>,
    Json(body): Json<Download>,
) -> AppResult<Response> {
    rate_limit(&state, &format!("user:{}", user.user_id), &headers).await?;
    let mut tx = begin(&state).await?;
    let p = authorize(&mut tx, user.user_id, id, body).await?;
    let reviewed = p
        .documents
        .as_array()
        .and_then(|a| a.iter().find(|d| d["id"].as_i64() == Some(did)))
        .ok_or(AppError::NotFound)?;
    scope_lock(&mut tx).await?;
    let d = doc(&mut tx, user.user_id, did).await?;
    let data = bytes(&state.db, &d).await?;
    let sha = digest(&data);
    if reviewed["sha256"].as_str() != Some(&sha)
        || reviewed["filename"].as_str() != Some(&d.filename)
        || reviewed["mime"].as_str() != Some(&d.mime)
    {
        return Err(conflict());
    }
    event(
        &mut tx,
        p.request_id,
        Some(id),
        user.user_id,
        "document_prepared",
        Some(did),
        Some(&sha),
    )
    .await?;
    tx.commit().await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"personal-document-{did}.{}\"",
                    extension(&d.mime)?
                ),
            ),
        ],
        data,
    )
        .into_response())
}
