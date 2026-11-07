use crate::{
    auth::{AdminUser, AuthUser},
    error::{AppError, AppResult},
    services::privacy::{self, RequestRow},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/privacy/processing",
            get(processing_get).post(processing_set),
        )
        .route("/privacy/collection", get(collection_list))
        .route("/privacy/collection/:id", post(collection_set))
        .route("/privacy/requests", get(list).post(create))
        .route("/privacy/impact", get(impact))
        .route("/privacy/requests/:id/cancel", post(cancel))
        .route("/admin/privacy/requests", get(admin_list))
        .route("/admin/privacy/requests/:id", get(detail).patch(review))
        .route("/admin/privacy/requests/:id/impact", get(admin_impact))
        .route(
            "/admin/privacy/requests/:id/close-account",
            post(start_closure),
        )
        .layer(axum::middleware::from_fn(super::privacy_delivery::no_store))
}

async fn collection_list(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let items:Vec<Value>=sqlx::query_scalar(
        "SELECT jsonb_build_object('device_id',d.id,'name',COALESCE(NULLIF(d.display_name,''),d.device_uid),
        'paused',c.collection_paused,'enforced',c.collection_enforced,'epoch',c.collection_epoch,
        'restricted',c.blocked,'changed_at',c.collection_changed_at,'ack_at',c.collection_ack_at,
        'device_applied',COALESCE(c.collection_ack_epoch=c.collection_epoch AND c.collection_ack_uid=d.active_auth_uid AND c.collection_ack_at>=c.collection_changed_at,false))
        FROM gps_read_devices d JOIN device_data_controls c ON c.device_id=d.id
        WHERE d.owner_id=$1 AND d.device_kind IS DISTINCT FROM 'phone' ORDER BY d.id")
        .bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(json!({"items":items})))
}

#[derive(Deserialize)]
struct CollectionSet {
    paused: bool,
    epoch: uuid::Uuid,
}
async fn collection_set(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<CollectionSet>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let owned:Option<i64>=sqlx::query_scalar("SELECT id FROM gps_read_devices WHERE id=$1 AND owner_id=$2 AND device_kind IS DISTINCT FROM 'phone' FOR UPDATE")
        .bind(id).bind(user.user_id).fetch_optional(&mut *tx).await?;
    if owned.is_none() {
        return Err(AppError::NotFound);
    }
    let (blocked,paused,epoch):(bool,bool,String)=sqlx::query_as("SELECT blocked,collection_paused,collection_epoch::text FROM device_data_controls WHERE device_id=$1 FOR UPDATE")
        .bind(id).fetch_one(&mut *tx).await?;
    if blocked {
        return Err(AppError::Conflict(
            "삭제 처리로 수집이 차단된 장치입니다. 관리자 확인이 필요합니다.".into(),
        ));
    }
    if epoch != req.epoch.to_string() {
        return Err(AppError::Conflict(
            "설정이 변경되었습니다. 새로고침 후 다시 시도해 주세요.".into(),
        ));
    }
    if paused != req.paused {
        let next = uuid::Uuid::new_v4();
        sqlx::query("UPDATE device_data_controls SET collection_paused=$2,collection_enforced=true,collection_epoch=$3::text::uuid,collection_changed_at=clock_timestamp(),collection_ack_epoch=NULL,collection_ack_at=NULL,collection_ack_uid=NULL WHERE device_id=$1")
            .bind(id).bind(req.paused).bind(next.to_string()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO collection_control_events(device_id,actor_id,paused,epoch) VALUES($1,$2,$3,$4::text::uuid)")
            .bind(id).bind(user.user_id).bind(req.paused).bind(next.to_string()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
pub struct Create {
    pub request_key: uuid::Uuid,
    pub kind: String,
    pub scope: String,
    pub password: String,
}
async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<Create>,
) -> AppResult<(StatusCode, Json<RequestRow>)> {
    let row = privacy::create(
        &state.db,
        user.user_id,
        req.request_key,
        &req.kind,
        &req.scope,
        &req.password,
    )
    .await?;
    Ok((StatusCode::ACCEPTED, Json(row)))
}
async fn list(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<RequestRow>>> {
    Ok(Json(
        sqlx::query_as(
            "SELECT * FROM privacy_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 100",
        )
        .bind(user.user_id)
        .fetch_all(&state.db)
        .await?,
    ))
}
async fn impact(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    Ok(Json(privacy::impact(&state.db, user.user_id).await?))
}
#[derive(Deserialize)]
struct Revision {
    revision: i32,
}
async fn cancel(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<Revision>,
) -> AppResult<Json<RequestRow>> {
    let mut tx = state.db.begin().await?;
    let row: RequestRow =
        sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 AND user_id=$2 FOR UPDATE")
            .bind(id)
            .bind(user.user_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    if row.revision != req.revision || !privacy::open(&row.status) {
        return Err(AppError::Conflict(
            "요청 상태가 변경됐습니다. 새로고침 후 확인해 주세요.".into(),
        ));
    }
    reject_started_closure(&mut tx, id).await?;
    let row: RequestRow = sqlx::query_as("UPDATE privacy_requests SET status='cancelled',revision=revision+1,updated_at=now(),result_message='요청자가 취소했습니다.' WHERE id=$1 RETURNING *")
        .bind(id).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message) VALUES($1,$2,$3,'cancelled','요청자가 취소했습니다.')")
        .bind(id).bind(user.user_id).bind(row.revision).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize)]
struct Page {
    before: Option<i64>,
    status: Option<String>,
}
async fn admin_list(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<Page>,
) -> AppResult<Json<Value>> {
    if q.status.as_deref().is_some_and(|s| {
        !matches!(
            s,
            "received" | "in_review" | "needs_information" | "fulfilled" | "rejected" | "cancelled"
        )
    }) {
        return Err(AppError::BadRequest("잘못된 상태 필터입니다.".into()));
    }
    let mut rows: Vec<RequestRow> = sqlx::query_as("SELECT * FROM privacy_requests WHERE ($1::bigint IS NULL OR id<$1) AND ($2::text IS NULL OR status=$2) ORDER BY id DESC LIMIT 51")
        .bind(q.before).bind(q.status).fetch_all(&state.db).await?;
    let more = rows.len() > 50;
    rows.truncate(50);
    let next = if more {
        rows.last().map(|r| r.id)
    } else {
        None
    };
    Ok(Json(json!({"items":rows,"next":next})))
}
async fn detail(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let row: RequestRow = sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let events: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('revision',revision,'actor_id',actor_id,'status',status,'message',message,'evidence_reference',evidence_reference,'due_at',due_at,'created_at',created_at) FROM privacy_request_events WHERE request_id=$1 ORDER BY revision")
        .bind(id).fetch_all(&state.db).await?;
    let closure: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(j) FROM privacy_account_closures j WHERE request_id=$1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    // Evidence reference is internal, never returned through the personal API.
    let evidence: String =
        sqlx::query_scalar("SELECT evidence_reference FROM privacy_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(
        json!({"request":row,"events":events,"evidence_reference":evidence,"closure":closure}),
    ))
}
async fn admin_impact(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let user: i64 = sqlx::query_scalar("SELECT user_id FROM privacy_requests WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(privacy::impact(&state.db, user).await?))
}
#[derive(Deserialize)]
struct Review {
    revision: i32,
    status: String,
    message: String,
    #[serde(default)]
    evidence_reference: String,
    due_at: Option<DateTime<Utc>>,
}
async fn review(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(req): Json<Review>,
) -> AppResult<Json<RequestRow>> {
    let mut tx = state.db.begin().await?;
    let old: RequestRow = sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    if old.revision != req.revision {
        return Err(AppError::Conflict(
            "다른 담당자가 처리했습니다. 새로고침 후 확인해 주세요.".into(),
        ));
    }
    reject_started_closure(&mut tx, id).await?;
    privacy::validate_review(
        &old.kind,
        &old.status,
        &req.status,
        &req.message,
        &req.evidence_reference,
        req.due_at,
    )?;
    if matches!(req.status.as_str(), "fulfilled" | "rejected") {
        let unresolved:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_company_reviews WHERE request_id=$1 AND status NOT IN ('verified','excluded') AND ($2='fulfilled' OR status<>'restricted'))")
            .bind(id).bind(&req.status).fetch_one(&mut *tx).await?;
        if unresolved {
            return Err(AppError::Conflict(
                "회사 자료의 미확인·보류 항목을 먼저 검토해 주세요.".into(),
            ));
        }
    }
    if req.due_at.is_some_and(|d| d < old.created_at) {
        return Err(AppError::BadRequest(
            "처리 기한은 접수 시각 이후여야 합니다.".into(),
        ));
    }
    let row: RequestRow = sqlx::query_as("UPDATE privacy_requests SET status=$2,revision=revision+1,assigned_to=$3,due_at=$4,result_message=$5,evidence_reference=$6,updated_at=now() WHERE id=$1 RETURNING *")
        .bind(id).bind(&req.status).bind(admin.user_id).bind(req.due_at).bind(req.message.trim()).bind(req.evidence_reference.trim()).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message,evidence_reference,due_at) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(id).bind(admin.user_id).bind(row.revision).bind(&row.status).bind(&row.result_message)
        .bind(req.evidence_reference.trim()).bind(row.due_at).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row))
}

async fn reject_started_closure(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: i64,
) -> AppResult<()> {
    let started: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM privacy_account_closures WHERE request_id=$1)",
    )
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if started {
        return Err(AppError::Conflict(
            "계정 종료 처리가 시작됐습니다. 취소·완료 표시는 자료 처리 검증 절차에서 관리합니다."
                .into(),
        ));
    }
    Ok(())
}

async fn start_closure(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    Json(req): Json<Revision>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let row: RequestRow = sqlx::query_as("SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    let started: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM privacy_account_closures WHERE request_id=$1)",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if !started
        && (row.kind != "account_closure"
            || row.revision != req.revision
            || !privacy::open(&row.status)
            || row.user_id == admin.user_id)
    {
        return Err(AppError::Conflict(
            "요청 종류·상태·버전을 확인해 주세요. 본인 계정은 다른 관리자가 처리해야 합니다."
                .into(),
        ));
    }
    sqlx::query("SELECT privacy_start_account_closure($1,$2,$3)")
        .bind(id)
        .bind(req.revision)
        .bind(admin.user_id)
        .execute(&mut *tx)
        .await?;
    let result: Value = sqlx::query_scalar(
        "SELECT to_jsonb(j) FROM privacy_account_closures j WHERE request_id=$1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(result))
}

async fn processing_get(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM privacy_processing_controls c WHERE user_id=$1",
    )
    .bind(user.user_id)
    .fetch_optional(&state.db)
    .await?;
    let retention: Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('months',months,'contract_until',contract_until,'consent_at',consent_at) FROM privacy_retention_consents WHERE user_id=$1").bind(user.user_id).fetch_optional(&state.db).await?;
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM privacy_retention_policy WHERE singleton")
            .fetch_one(&state.db)
            .await?;
    Ok(Json(
        json!({"control":row.unwrap_or(json!({"use_paused":false,"provision_paused":false,"revision":0})),"retention":retention,"retention_enabled":enabled}),
    ))
}
#[derive(Deserialize)]
struct ProcessingSet {
    revision: i64,
    use_paused: bool,
    provision_paused: bool,
}
async fn processing_set(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ProcessingSet>,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let ready: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
        .bind(crate::services::privacy_lifecycle::LOCK)
        .fetch_one(&mut *tx)
        .await?;
    if !ready {
        return Err(AppError::Conflict("진행 중인 위치 처리가 있습니다. 잠시 후 다시 시도해 주세요. 아직 설정은 변경되지 않았습니다.".into()));
    }
    sqlx::query(
        "INSERT INTO privacy_processing_controls(user_id) VALUES($1) ON CONFLICT DO NOTHING",
    )
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?;
    let revision: i64 = sqlx::query_scalar(
        "SELECT revision FROM privacy_processing_controls WHERE user_id=$1 FOR UPDATE",
    )
    .bind(user.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if revision != req.revision {
        return Err(AppError::Conflict(
            "설정이 변경되었습니다. 새로고침 후 다시 시도해 주세요.".into(),
        ));
    }
    if req.use_paused || req.provision_paused {
        sqlx::query("UPDATE fcm_outbox SET status='cancelled',finished_at=clock_timestamp(),lease_until=NULL WHERE user_id=$1 AND event_id IS NOT NULL AND status='pending'").bind(user.user_id).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE privacy_processing_controls SET use_paused=$2,provision_paused=$3,revision=revision+1,changed_at=clock_timestamp() WHERE user_id=$1").bind(user.user_id).bind(req.use_paused).bind(req.provision_paused).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO privacy_processing_events(user_id,actor_id,use_paused,provision_paused,revision) VALUES($1,$1,$2,$3,$4)").bind(user.user_id).bind(req.use_paused).bind(req.provision_paused).bind(revision+1).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true,"revision":revision+1})))
}
