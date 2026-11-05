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
        .route("/privacy/requests", get(list).post(create))
        .route("/privacy/impact", get(impact))
        .route("/privacy/requests/:id/cancel", post(cancel))
        .route("/admin/privacy/requests", get(admin_list))
        .route("/admin/privacy/requests/:id", get(detail).patch(review))
        .route("/admin/privacy/requests/:id/impact", get(admin_impact))
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
    // Evidence reference is internal, never returned through the personal API.
    let evidence: String =
        sqlx::query_scalar("SELECT evidence_reference FROM privacy_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(
        json!({"request":row,"events":events,"evidence_reference":evidence}),
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
    privacy::validate_review(
        &old.kind,
        &old.status,
        &req.status,
        &req.message,
        &req.evidence_reference,
        req.due_at,
    )?;
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
