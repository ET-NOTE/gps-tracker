use axum::{
    extract::{DefaultBodyLimit, FromRequestParts, Path, State},
    http::{header, request::Parts},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

mod validation;

pub(super) struct CargoOwner {
    pub(super) user_id: i64,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for CargoOwner {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        if parts
            .extensions
            .get::<crate::auth::fleet::FleetScope>()
            .is_some()
            || parts.headers.contains_key("x-fleet-owner")
        {
            return Err(AppError::Forbidden);
        }
        let auth = AuthUser::from_request_parts(parts, state).await?;
        let enabled: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT FROM users WHERE id=$1 AND gps_owner_service(users,'delivery'))",
        )
        .bind(auth.user_id)
        .fetch_one(&state.db)
        .await?;
        if !enabled {
            return Err(AppError::Forbidden);
        }
        Ok(Self {
            user_id: auth.user_id,
        })
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/cargo/workspace", get(workspace).put(save_workspace))
        .route(
            "/cargo/proof-images",
            post(upload_proof).layer(DefaultBodyLimit::max(704_000)),
        )
        .route("/cargo/proof-images/:id", get(proof_image))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}

pub(super) fn empty_workspace() -> Value {
    let mut data = json!({
        "codes": {"vehicleTypes":["카고","탑차","윙바디","냉장·냉동"],"units":["팔레트","박스","개","톤"],"chargeTypes":["대기료","경유료","상하차 작업비","취소비","기타"]},
        "policies": {"bufferMinutes":60,"ownAutoConfirm":true,"requireDriverCheck":true,"requireProofForBilling":true,"offlineMinutes":10,"acceptTimeoutMinutes":30},
        "integrations": {"dispatchNotice":true,"delayNotice":true,"proofNotice":true,"connectionNotice":true,"channel":"앱 알림"}
    });
    for key in validation::COLLECTIONS {
        data[*key] = json!([]);
    }
    data["activity"] = json!([]);
    data
}

async fn workspace(State(s): State<AppState>, owner: CargoOwner) -> AppResult<Json<Value>> {
    let (revision, data): (i64, Value) =
        sqlx::query_as("SELECT revision,data FROM cargo_workspaces WHERE owner_id=$1")
            .bind(owner.user_id)
            .fetch_optional(&s.db)
            .await?
            .unwrap_or_else(|| (0, empty_workspace()));
    Ok(Json(json!({"revision":revision,"data":data})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    revision: i64,
    data: Value,
}

async fn lock_owner(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM users WHERE id=$1 AND gps_owner_service(users,'delivery') FOR UPDATE",
    )
    .bind(owner)
    .fetch_optional(&mut **tx)
    .await?;
    found.map(|_| ()).ok_or(AppError::Forbidden)
}

async fn save_workspace(
    State(s): State<AppState>,
    owner: CargoOwner,
    Json(edit): Json<Save>,
) -> AppResult<Json<Value>> {
    let mut tx = s.db.begin().await?;
    lock_owner(&mut tx, owner.user_id).await?;
    let (revision, old): (i64, Value) =
        sqlx::query_as("SELECT revision,data FROM cargo_workspaces WHERE owner_id=$1 FOR UPDATE")
            .bind(owner.user_id)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_else(|| (0, empty_workspace()));
    if edit.revision != revision {
        if edit.revision.checked_add(1) == Some(revision) && old == edit.data {
            return Ok(Json(json!({"revision":revision})));
        }
        return Err(AppError::Conflict(
            "다른 화면에서 화물 업무가 변경되었습니다. 새로고침 후 다시 확인해 주세요.".into(),
        ));
    }
    let refs = validation::validate(&old, &edit.data)?;
    if !refs.new_staff.is_empty() {
        let expected = refs.new_staff.len();
        let (staff, branches): (Vec<i64>, Vec<String>) = refs.new_staff.into_iter().unzip();
        let found:Vec<i64>=sqlx::query_scalar("SELECT t.id FROM cargo_staff t
            JOIN unnest($2::bigint[], $3::text[]) AS a(id,branch) ON (a.id,a.branch)=(t.id,t.branch_id)
            WHERE t.owner_id=$1 AND t.active FOR SHARE OF t")
            .bind(owner.user_id).bind(staff).bind(branches).fetch_all(&mut *tx).await?;
        if found.len() != expected {
            return Err(bad("해당 지점에서 사용 중인 배차 담당자를 선택해 주세요."));
        }
    }
    if !refs.new_devices.is_empty() {
        let found: Vec<i64> =
            sqlx::query_scalar("SELECT id FROM devices WHERE owner_id=$1 AND id=ANY($2) FOR SHARE")
                .bind(owner.user_id)
                .bind(&refs.new_devices)
                .fetch_all(&mut *tx)
                .await?;
        if found.len() != refs.new_devices.len() {
            return Err(bad("이 계정에 연결된 단말기를 선택해 주세요."));
        }
    }
    if !refs.images.is_empty() {
        let attached = sqlx::query(
            "UPDATE cargo_proof_images SET attached=true WHERE owner_id=$1 AND id=ANY($2)",
        )
        .bind(owner.user_id)
        .bind(&refs.images)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if attached != refs.images.len() as u64 {
            return Err(bad("이 계정에서 등록한 인수증 사진을 선택해 주세요."));
        }
    }
    // Keep replaced documents staged briefly for a retry, then expire them on the next upload.
    sqlx::query("UPDATE cargo_proof_images SET attached=false, created_at=now() WHERE owner_id=$1 AND attached AND NOT(id=ANY($2))")
        .bind(owner.user_id).bind(&refs.images).execute(&mut *tx).await?;
    let next = revision + 1;
    sqlx::query("INSERT INTO cargo_workspaces(owner_id,revision,data) VALUES($1,$2,$3)
        ON CONFLICT(owner_id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,updated_at=now()")
        .bind(owner.user_id).bind(next).bind(&edit.data).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"revision":next})))
}

#[derive(Deserialize)]
struct ImageUpload {
    data: String,
}

async fn upload_proof(
    State(s): State<AppState>,
    owner: CargoOwner,
    Json(body): Json<ImageUpload>,
) -> AppResult<Json<Value>> {
    let invalid = || bad("500KB 이하의 PNG, JPEG 또는 WebP 사진을 선택해 주세요.");
    let (header, encoded) = body.data.split_once(',').ok_or_else(invalid)?;
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
    if bytes.is_empty() || bytes.len() > 512000 {
        return Err(invalid());
    }
    let mime = match header {
        "data:image/jpeg;base64"
            if bytes.starts_with(&[255, 216, 255]) && bytes.ends_with(&[255, 217]) =>
        {
            "image/jpeg"
        }
        "data:image/png;base64"
            if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") =>
        {
            "image/png"
        }
        "data:image/webp;base64"
            if bytes.starts_with(b"RIFF")
                && bytes.get(8..12) == Some(b"WEBP")
                && matches!(
                    bytes.get(12..16),
                    Some(b"VP8 ") | Some(b"VP8L") | Some(b"VP8X")
                ) =>
        {
            "image/webp"
        }
        _ => return Err(invalid()),
    };
    let digest = Sha256::digest(&bytes).to_vec();
    let mut tx = s.db.begin().await?;
    lock_owner(&mut tx, owner.user_id).await?;
    sqlx::query("DELETE FROM cargo_proof_images WHERE owner_id=$1 AND NOT attached AND created_at<now()-interval '24 hours'")
        .bind(owner.user_id).execute(&mut *tx).await?;
    let existing:Option<String> = sqlx::query_scalar("UPDATE cargo_proof_images SET created_at=now() WHERE owner_id=$1 AND digest=$2 RETURNING id")
        .bind(owner.user_id).bind(&digest).fetch_optional(&mut *tx).await?;
    let id = if let Some(id) = existing {
        id
    } else {
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM cargo_proof_images WHERE owner_id=$1 AND NOT attached",
        )
        .bind(owner.user_id)
        .fetch_one(&mut *tx)
        .await?;
        if pending >= 100 {
            return Err(bad(
                "저장 대기 중인 인수증이 많습니다. 먼저 작성 중인 인수증을 저장해 주세요.",
            ));
        }
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cargo_proof_images(id,owner_id,digest,content_type,content) VALUES($1,$2,$3,$4,$5)")
            .bind(&id).bind(owner.user_id).bind(digest).bind(mime).bind(bytes).execute(&mut *tx).await?;
        id
    };
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}

async fn proof_image(
    State(s): State<AppState>,
    owner: CargoOwner,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let (mime, bytes): (String, Vec<u8>) = sqlx::query_as(
        "SELECT content_type,content FROM cargo_proof_images WHERE id=$1 AND owner_id=$2",
    )
    .bind(&id)
    .bind(owner.user_id)
    .fetch_optional(&s.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        bytes,
    ))
}
