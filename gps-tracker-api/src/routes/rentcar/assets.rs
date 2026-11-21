use super::*;
use crate::routes::rentcar_office::RentalOwner;
use sqlx::{Postgres, Transaction};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/rentcar/assets", get(list).post(create))
        .route("/rentcar/assets/:id", patch(edit))
        .route("/rentcar/assets/:id/device", axum::routing::put(link))
}

pub(in crate::routes) async fn lock_owner(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
) -> AppResult<()> {
    workflow::owner_lock(tx, owner).await
}
async fn import_devices(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    sqlx::query("SELECT rental_import_new_devices($1)")
        .bind(owner)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(in crate::routes) async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    vehicle_id: Option<i64>,
    device_id: Option<i64>,
) -> AppResult<Option<(i64, Option<i64>)>> {
    lock_owner(tx, owner).await?;
    import_devices(tx, owner).await?;
    if vehicle_id.is_none() && device_id.is_none() {
        return Ok(None);
    }
    let selected=sqlx::query_as::<_,(i64,Option<i64>)>("SELECT vehicle_id,device_id FROM rental_vehicle_profile
        WHERE owner_id=$1 AND ($2::bigint IS NULL OR vehicle_id=$2) AND ($3::bigint IS NULL OR device_id=$3) FOR UPDATE")
        .bind(owner).bind(vehicle_id).bind(device_id).fetch_optional(&mut **tx).await?.ok_or(AppError::NotFound)?;
    Ok(Some(selected))
}

#[derive(Serialize, FromRow)]
struct Asset {
    id: i64,
    device_id: Option<i64>,
    plate: String,
    model: String,
    display_name: String,
    branch: String,
    class_name: String,
    readiness: String,
    odometer_km: Option<i32>,
    fuel_level: Option<i32>,
    revision: i64,
    enabled: bool,
}
const FIELDS:&str="SELECT vehicle_id AS id,device_id,plate,model,display_name,branch,class_name,readiness,odometer_km,fuel_level,revision,enabled FROM rental_asset_directory";
async fn read(tx: &mut Transaction<'_, Postgres>, owner: i64, id: i64) -> AppResult<Asset> {
    Ok(
        sqlx::query_as(&format!("{FIELDS} WHERE owner_id=$1 AND vehicle_id=$2"))
            .bind(owner)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(AppError::NotFound)?,
    )
}
async fn list(State(s): State<AppState>, u: RentalOwner) -> AppResult<Json<Vec<Asset>>> {
    let mut tx = s.db.begin().await?;
    lock_owner(&mut tx, u.user_id).await?;
    import_devices(&mut tx, u.user_id).await?;
    let items = sqlx::query_as(&format!(
        "{FIELDS} WHERE owner_id=$1 ORDER BY plate,vehicle_id"
    ))
    .bind(u.user_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(items))
}

#[derive(Deserialize)]
struct Form {
    plate: String,
    model: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    class_name: String,
    readiness: Option<String>,
    odometer_km: Option<i32>,
    fuel_level: Option<i32>,
    revision: Option<i64>,
}
async fn save(s: AppState, user: i64, id: Option<i64>, f: Form) -> AppResult<Json<Asset>> {
    let plate = f.plate.trim();
    let model = f.model.trim();
    let readiness = f.readiness.as_deref().unwrap_or("ready");
    if plate.is_empty()
        || model.is_empty()
        || plate.chars().count() > 40
        || model.chars().count() > 100
        || f.display_name.trim().chars().count() > 100
        || f.branch.trim().chars().count() > 80
        || f.class_name.trim().chars().count() > 80
        || !matches!(readiness, "ready" | "hold")
        || f.odometer_km.is_some_and(|n| n < 0)
        || f.fuel_level.is_some_and(|n| !(0..=100).contains(&n))
    {
        return Err(AppError::BadRequest(
            "차량번호·모델·계기판 정보를 확인해 주세요.".into(),
        ));
    }
    let mut tx = s.db.begin().await?;
    lock_owner(&mut tx, user).await?;
    import_devices(&mut tx, user).await?;
    let duplicate:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rental_asset_directory WHERE owner_id=$1 AND vehicle_id IS DISTINCT FROM $2 AND lower(regexp_replace(plate,'[[:space:]]','','g'))=lower(regexp_replace($3,'[[:space:]]','','g')))")
        .bind(user).bind(id).bind(plate).fetch_one(&mut *tx).await?;
    if duplicate {
        return Err(AppError::Conflict("이미 등록한 차량번호입니다.".into()));
    }
    let vehicle = if let Some(vehicle) = id {
        let existing = read(&mut tx, user, vehicle).await?;
        if f.revision != Some(existing.revision) {
            return Err(AppError::Conflict(
                "차량 정보가 바뀌었습니다. 새로고침 후 다시 확인해 주세요.".into(),
            ));
        }
        if f.odometer_km
            .zip(existing.odometer_km)
            .is_some_and(|(new, old)| new < old)
        {
            return Err(AppError::BadRequest(
                "기존 누적 주행거리 이상을 입력해 주세요.".into(),
            ));
        }
        sqlx::query("UPDATE rental_vehicle_profile SET identity_explicit=true,plate=$3,model=$4,display_name=$5,branch=$6,class_name=$7,readiness=$8,
            odometer_km=coalesce($9,odometer_km),fuel_level=coalesce($10,fuel_level), revision=revision+1 WHERE owner_id=$1 AND vehicle_id=$2")
            .bind(user).bind(vehicle).bind(plate).bind(model).bind(f.display_name.trim()).bind(f.branch.trim()).bind(f.class_name.trim()).bind(readiness)
            .bind(f.odometer_km).bind(f.fuel_level).execute(&mut *tx).await?;
        vehicle
    } else {
        sqlx::query_scalar("INSERT INTO rental_vehicle_profile(owner_id,plate,model,display_name,branch,class_name,readiness,odometer_km,fuel_level,identity_explicit)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING vehicle_id")
            .bind(user).bind(plate).bind(model).bind(f.display_name.trim()).bind(f.branch.trim()).bind(f.class_name.trim()).bind(readiness)
            .bind(f.odometer_km).bind(f.fuel_level).fetch_one(&mut *tx).await?
    };
    let saved = read(&mut tx, user, vehicle).await?;
    tx.commit().await?;
    Ok(Json(saved))
}
async fn create(
    State(s): State<AppState>,
    u: RentalOwner,
    Json(f): Json<Form>,
) -> AppResult<Json<Asset>> {
    save(s, u.user_id, None, f).await
}
async fn edit(
    State(s): State<AppState>,
    u: RentalOwner,
    Path(id): Path<i64>,
    Json(f): Json<Form>,
) -> AppResult<Json<Asset>> {
    save(s, u.user_id, Some(id), f).await
}

#[derive(Deserialize)]
struct Binding {
    device_id: Option<i64>,
    revision: Option<i64>,
}
async fn link(
    State(s): State<AppState>,
    u: RentalOwner,
    Path(id): Path<i64>,
    Json(req): Json<Binding>,
) -> AppResult<Json<Asset>> {
    let owner = u.user_id;
    let mut tx = s.db.begin().await?;
    lock_owner(&mut tx, owner).await?;
    let existing = read(&mut tx, owner, id).await?;
    if existing.device_id != req.device_id {
        if req.revision.is_some_and(|r| r != existing.revision) {
            return Err(AppError::Conflict(
                "다른 작업자가 차량 정보를 변경했습니다.".into(),
            ));
        }
        if let Some(device) = req.device_id {
            let available: Option<i64> =
                sqlx::query_scalar("SELECT id FROM devices WHERE id=$1 AND owner_id=$2 FOR SHARE")
                    .bind(device)
                    .bind(owner)
                    .fetch_optional(&mut *tx)
                    .await?;
            if available.is_none() {
                return Err(AppError::NotFound);
            }
            let already:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rental_vehicle_profile WHERE device_id=$1 AND vehicle_id<>$2)")
                .bind(device).bind(id).fetch_one(&mut *tx).await?;
            if already {
                return Err(AppError::Conflict(
                    "다른 차량에 연결되어 있습니다. 해당 차량에서 먼저 연결을 해제해 주세요."
                        .into(),
                ));
            }
            sqlx::query("INSERT INTO rental_imported_devices VALUES($1,$2) ON CONFLICT DO NOTHING")
                .bind(owner)
                .bind(device)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE rental_vehicle_profile SET device_id=$3,plate=$4,model=$5,display_name=$6,revision=revision+1 WHERE owner_id=$1 AND vehicle_id=$2")
            .bind(owner).bind(id).bind(req.device_id).bind(&existing.plate).bind(&existing.model).bind(&existing.display_name).execute(&mut *tx).await?;
        sqlx::query("UPDATE rental_contracts SET device_id=$3 WHERE user_id=$1 AND vehicle_id=$2 AND status IN ('draft','active','overdue')")
            .bind(owner).bind(id).bind(req.device_id).execute(&mut *tx).await?;
    }
    let saved = read(&mut tx, owner, id).await?;
    tx.commit().await?;
    Ok(Json(saved))
}
