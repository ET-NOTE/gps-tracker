use super::{lock_device_rental, verify_device_owner};
use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};
use axum::{extract::{Path, State}, routing::{get, post, put}, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/rentcar/vehicle-profiles", get(profiles))
        .route("/rentcar/vehicle-profiles/:id", put(save_profile))
        .route("/rentcar/fleet-work", get(list).post(create))
        .route("/rentcar/fleet-work/:id", put(edit))
        .route("/rentcar/fleet-work/:id/complete", post(complete))
}

#[derive(Serialize, FromRow)]
struct Work {
    id: i64,
    device_id: i64,
    contract_id: Option<i64>,
    kind: String,
    starts_at: DateTime<Utc>,
    ends_at: Option<DateTime<Utc>>,
    note: String,
    closed_at: Option<DateTime<Utc>>,
    resolution: Option<String>,
    inspection_released_at: Option<DateTime<Utc>>,
    return_inspection: bool,
}

#[derive(Deserialize)]
struct Details {
    device_id: i64,
    contract_id: Option<i64>,
    kind: String,
    starts_at: DateTime<Utc>,
    ends_at: Option<DateTime<Utc>>,
    #[serde(default)]
    note: String,
}

fn incident(kind: &str) -> bool {
    matches!(kind, "accident" | "breakdown")
}

fn validate(d: &Details, now: DateTime<Utc>) -> AppResult<()> {
    if !matches!(d.kind.as_str(), "cleaning" | "inspection" | "maintenance" | "accident" | "breakdown") {
        return Err(AppError::BadRequest("작업 구분을 확인해 주세요.".into()));
    }
    if d.note.chars().count() > 1000 {
        return Err(AppError::BadRequest("작업 내용은 1,000자까지 입력할 수 있습니다.".into()));
    }
    if incident(&d.kind) {
        if d.starts_at > now || d.ends_at.is_some() || d.note.trim().is_empty() {
            return Err(AppError::BadRequest("사고·고장의 발생 시각과 접수 내용을 확인해 주세요.".into()));
        }
    } else if !d.ends_at.is_some_and(|end| end > d.starts_at) || d.contract_id.is_some() {
        return Err(AppError::BadRequest("종료 시간은 시작 시간 이후여야 합니다.".into()));
    }
    Ok(())
}

pub(super) async fn require_rentcar(state: &AppState, owner: i64) -> AppResult<()> {
    let enabled: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id=$1 AND gps_owner_service(users,'rentcar'))")
        .bind(owner).fetch_one(&state.db).await?;
    if !enabled { return Err(AppError::Forbidden); }
    Ok(())
}

// Called while holding the same device advisory lock as booking/dispatch.
pub(super) async fn assert_available(tx: &mut Transaction<'_, Postgres>, owner: i64, device: i64, start: DateTime<Utc>, end: DateTime<Utc>) -> AppResult<()> {
    let blocked: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM rental_vehicle_profile WHERE owner_id=$1 AND device_id=$2 AND readiness='hold')
         OR EXISTS (SELECT 1 FROM rental_fleet_work WHERE owner_id=$1 AND device_id=$2 AND (
            (kind IN ('accident','breakdown') AND inspection_released_at IS NULL) OR (return_inspection AND closed_at IS NULL) OR
            (ends_at IS NOT NULL AND closed_at IS NULL AND starts_at < $4 AND ends_at > $3)))"
    ).bind(owner).bind(device).bind(start).bind(end).fetch_one(&mut **tx).await?;
    if blocked { return Err(AppError::Conflict("차량의 정비 일정 또는 사고·고장 조치 상태를 확인해 주세요.".into())); }
    Ok(())
}

#[derive(Serialize, FromRow)]
struct Profile {
    device_id: i64,
    branch: String,
    class_name: String,
    readiness: String,
    odometer_km: Option<i32>,
    fuel_level: Option<i32>,
    revision: i64,
}

#[derive(Deserialize)]
struct ProfileInput {
    branch: String,
    class_name: String,
    readiness: String,
    odometer_km: Option<i32>,
    fuel_level: Option<i32>,
    revision: i64,
}

async fn profiles(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<Profile>>> {
    require_rentcar(&state, user.user_id).await?;
    let items = sqlx::query_as::<_, Profile>("SELECT * FROM rental_vehicle_profile WHERE owner_id=$1 ORDER BY device_id")
        .bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(items))
}

async fn save_profile(State(state): State<AppState>, user: AuthUser, Path(id): Path<i64>, Json(input): Json<ProfileInput>) -> AppResult<Json<Profile>> {
    let owner = user.user_id;
    require_rentcar(&state, owner).await?;
    verify_device_owner(&state, owner, id).await?;
    if input.branch.trim().chars().count() > 80 || input.class_name.trim().chars().count() > 80 || !matches!(input.readiness.as_str(),"ready"|"hold")
        || input.odometer_km.is_some_and(|km| km < 0) || input.fuel_level.is_some_and(|fuel| !(0..=100).contains(&fuel)) {
        return Err(AppError::BadRequest("차종·지점, 거리와 잔량을 확인해 주세요.".into()));
    }
    let mut tx = state.db.begin().await?;
    super::workflow::owner_lock(&mut tx, owner).await?;
    lock_device_rental(&mut tx, id).await?;
    let old = sqlx::query_as::<_, Profile>("SELECT * FROM rental_vehicle_profile WHERE owner_id=$1 AND device_id=$2")
        .bind(owner).bind(id).fetch_optional(&mut *tx).await?;
    if old.as_ref().map_or(0, |p| p.revision) != input.revision {
        return Err(AppError::Conflict("다른 창에서 차량 정보를 변경했습니다. 창을 닫고 다시 확인해 주세요.".into()));
    }
    if let Some(km) = old.and_then(|p| p.odometer_km) {
        if !input.odometer_km.is_some_and(|v| v>=km) {
            return Err(AppError::BadRequest("누적 거리는 기존 기록보다 작을 수 없습니다.".into()));
        }
    }
    let row = sqlx::query_as::<_, Profile>("INSERT INTO rental_vehicle_profile (owner_id,device_id,branch,class_name,readiness,odometer_km,fuel_level)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (owner_id,device_id) DO UPDATE SET branch=EXCLUDED.branch,class_name=EXCLUDED.class_name,
        readiness=EXCLUDED.readiness,odometer_km=EXCLUDED.odometer_km,fuel_level=EXCLUDED.fuel_level,revision=rental_vehicle_profile.revision+1 RETURNING *")
        .bind(owner).bind(id).bind(input.branch.trim()).bind(input.class_name.trim()).bind(input.readiness).bind(input.odometer_km).bind(input.fuel_level)
        .fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row))
}

async fn list(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<Work>>> {
    require_rentcar(&state, user.user_id).await?;
    let rows = sqlx::query_as::<_, Work>("SELECT * FROM rental_fleet_work WHERE owner_id=$1 ORDER BY starts_at DESC,id DESC")
        .bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

async fn create(State(state): State<AppState>, user: AuthUser, Json(d): Json<Details>) -> AppResult<Json<Work>> {
    save(&state, user.user_id, None, d).await
}

async fn edit(State(state): State<AppState>, user: AuthUser, Path(id): Path<i64>, Json(d): Json<Details>) -> AppResult<Json<Work>> {
    save(&state, user.user_id, Some(id), d).await
}

async fn save(state: &AppState, owner: i64, id: Option<i64>, d: Details) -> AppResult<Json<Work>> {
    require_rentcar(state, owner).await?;
    validate(&d, Utc::now())?;
    verify_device_owner(state, owner, d.device_id).await?;
    let mut tx = state.db.begin().await?;
    super::workflow::owner_lock(&mut tx, owner).await?;
    if let Some(id) = id {
        let previous = sqlx::query_as::<_, Work>("SELECT * FROM rental_fleet_work WHERE owner_id=$1 AND id=$2 FOR UPDATE")
            .bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
        if previous.closed_at.is_some() || previous.return_inspection || previous.device_id != d.device_id || incident(&previous.kind) || incident(&d.kind) {
            return Err(AppError::Conflict("진행 예정인 차량의 세차·정비 일정만 수정할 수 있습니다.".into()));
        }
    }
    lock_device_rental(&mut tx, d.device_id).await?;
    if let Some(contract) = d.contract_id {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM rental_contracts WHERE user_id=$1 AND id=$2 AND device_id=$3 AND status!='cancelled')")
            .bind(owner).bind(contract).bind(d.device_id).fetch_one(&mut *tx).await?;
        if !valid { return Err(AppError::BadRequest("이 차량에 연결된 계약을 선택해 주세요.".into())); }
    }
    if let Some(end) = d.ends_at {
        let overlap: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM rental_contracts WHERE user_id=$1 AND device_id=$2
                AND (status IN ('active','overdue') OR (status='draft' AND rental_terms IS NOT NULL))
                AND LEAST(starts_at,(rental_terms->>'checkout_at')::timestamptz)<$4 AND (ends_at + make_interval(mins=>COALESCE((SELECT buffer_minutes FROM rental_operating_policies WHERE user_id=$1),0))>$3
                    OR (status IN ('active','overdue') AND ends_at<=now() AND $3<=now())))
            OR EXISTS (SELECT 1 FROM rental_fleet_work WHERE owner_id=$1 AND device_id=$2 AND closed_at IS NULL
                AND ends_at IS NOT NULL AND starts_at<$4 AND ends_at>$3 AND id IS DISTINCT FROM $5)"
        ).bind(owner).bind(d.device_id).bind(d.starts_at).bind(end).bind(id).fetch_one(&mut *tx).await?;
        if overlap { return Err(AppError::Conflict("같은 차량의 대여 기간 또는 다른 작업 일정과 겹칩니다.".into())); }
    }
    let row = if let Some(id) = id {
        sqlx::query_as::<_, Work>("UPDATE rental_fleet_work SET kind=$3,starts_at=$4,ends_at=$5,note=$6 WHERE owner_id=$1 AND id=$2 RETURNING *")
            .bind(owner).bind(id).bind(d.kind).bind(d.starts_at).bind(d.ends_at).bind(d.note.trim()).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_as::<_, Work>("INSERT INTO rental_fleet_work (owner_id,device_id,contract_id,kind,starts_at,ends_at,note)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *")
            .bind(owner).bind(d.device_id).bind(d.contract_id).bind(d.kind).bind(d.starts_at).bind(d.ends_at).bind(d.note.trim()).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    Ok(Json(row))
}

#[derive(Deserialize)]
struct Completion { resolution: Option<String>, #[serde(default)] release: bool }

async fn complete(State(state): State<AppState>, user: AuthUser, Path(id): Path<i64>, Json(form): Json<Completion>) -> AppResult<Json<Work>> {
    let owner = user.user_id;
    require_rentcar(&state, owner).await?;
    let mut tx = state.db.begin().await?;
    super::workflow::owner_lock(&mut tx, owner).await?;
    let previous = sqlx::query_as::<_, Work>("SELECT * FROM rental_fleet_work WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    let owned: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM gps_read_devices WHERE owner_id=$1 AND id=$2)")
        .bind(owner).bind(previous.device_id).fetch_one(&mut *tx).await?;
    if !owned { return Err(AppError::NotFound); }
    lock_device_rental(&mut tx, previous.device_id).await?;
    let row = if form.release {
        if !incident(&previous.kind) || previous.closed_at.is_none() {
            return Err(AppError::Conflict("사고·고장 처리를 완료한 후 점검 완료를 기록해 주세요.".into()));
        }
        sqlx::query_as::<_, Work>("UPDATE rental_fleet_work SET inspection_released_at=COALESCE(inspection_released_at,now()) WHERE id=$1 AND owner_id=$2 RETURNING *")
            .bind(id).bind(owner).fetch_one(&mut *tx).await?
    } else if previous.closed_at.is_some() {
        previous
    } else {
        if previous.starts_at > Utc::now() { return Err(AppError::Conflict("아직 시작 전인 작업입니다.".into())); }
        let note = form.resolution.as_deref().unwrap_or("").trim();
        if (incident(&previous.kind) && note.is_empty()) || note.chars().count() > 800 {
            return Err(AppError::BadRequest("처리 내용을 800자 이내로 입력해 주세요.".into()));
        }
        sqlx::query_as::<_, Work>("UPDATE rental_fleet_work SET closed_at=now(),resolution=$3 WHERE id=$1 AND owner_id=$2 RETURNING *")
            .bind(id).bind(owner).bind(if note.is_empty() { None } else { Some(note) }).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    Ok(Json(row))
}

pub(super) async fn after_checkout(tx: &mut Transaction<'_, Postgres>, owner: i64, device: i64, km: i32, fuel: Option<i32>) -> AppResult<()> {
    let prior: Option<i32> = sqlx::query_scalar("SELECT odometer_km FROM rental_vehicle_profile WHERE owner_id=$1 AND device_id=$2")
        .bind(owner).bind(device).fetch_optional(&mut **tx).await?.flatten();
    if prior.is_some_and(|old| old > km) {
        return Err(AppError::BadRequest("인수 거리는 차량의 누적 거리 이상이어야 합니다.".into()));
    }
    write_readings(tx, owner, device, Some(km), fuel, None).await
}

async fn write_readings(tx: &mut Transaction<'_, Postgres>, owner: i64, device: i64, km: Option<i32>, fuel: Option<i32>, branch: Option<&str>) -> AppResult<()> {
    sqlx::query("INSERT INTO rental_vehicle_profile(owner_id,device_id,odometer_km,fuel_level,branch)
        VALUES($1,$2,$3,$4,COALESCE($5,'')) ON CONFLICT(owner_id,device_id) DO UPDATE SET
        odometer_km=GREATEST(rental_vehicle_profile.odometer_km,EXCLUDED.odometer_km),
        fuel_level=COALESCE(EXCLUDED.fuel_level,rental_vehicle_profile.fuel_level),
        branch=COALESCE($5,rental_vehicle_profile.branch),revision=rental_vehicle_profile.revision+1")
        .bind(owner).bind(device).bind(km).bind(fuel).bind(branch).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn after_return(tx: &mut Transaction<'_, Postgres>, owner: i64, device: i64, returned_at: DateTime<Utc>, km: Option<i32>, fuel: Option<i32>, branch: Option<&str>, contract_id: i64) -> AppResult<()> {
    // Older rentals may have an address in return_location. Only the managed branch
    // catalog can reassign a vehicle to a different branch and its staff.
    let registered: Option<String> = sqlx::query_scalar("SELECT name FROM rental_branches WHERE owner_id=$1 AND name=$2")
        .bind(owner).bind(branch.map(str::trim)).fetch_optional(&mut **tx).await?;
    write_readings(tx, owner, device, km, fuel, registered.as_deref()).await?;
    sqlx::query("INSERT INTO rental_fleet_work (owner_id,device_id,contract_id,kind,starts_at,note,return_inspection)
        VALUES ($1,$2,$3,'inspection',$4,'반납 차량 점검',true) ON CONFLICT (owner_id,contract_id) WHERE return_inspection DO NOTHING")
        .bind(owner).bind(device).bind(contract_id).bind(returned_at).execute(&mut **tx).await?;
    Ok(())
}
