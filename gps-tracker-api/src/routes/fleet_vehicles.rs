//! Vehicle assets and temporal SIM assignments. Never change an ingest identity here.
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Extension, Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/corporate/vehicles", get(list).post(create))
        .route("/corporate/vehicles/:id", get(detail).put(update))
        .route(
            "/corporate/vehicles/:id/bindings",
            get(history).put(connect),
        )
        .route("/corporate/vehicles/:id/audit", get(audit))
        .route("/corporate/vehicles/:id/trips", get(trips))
        .route(
            "/corporate/vehicles/:id/trips/annotation",
            axum::routing::patch(annotation),
        )
        .route("/corporate/vehicle-stats", get(stats))
}

#[derive(Debug, Serialize, FromRow)]
pub struct Vehicle {
    pub id: i64,
    pub owner_id: i64,
    pub name: String,
    pub license_plate: Option<String>,
    pub car_model: Option<String>,
    pub department: Option<String>,
    pub department_id: Option<i64>,
    pub manager_staff_id: Option<i64>,
    pub enabled: bool,
    pub profile: Value,
    pub legacy_device_id: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[sqlx(skip)]
    pub bindings: Vec<Binding>,
}
#[derive(Debug, Serialize, FromRow)]
pub struct Binding {
    pub id: i64,
    pub vehicle_id: i64,
    pub owner_id: i64,
    pub device_id: Option<i64>,
    pub terminal_name: String,
    pub is_primary: bool,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub reason: String,
    pub end_reason: Option<String>,
}
#[derive(Deserialize)]
struct VehicleInput {
    name: String,
    license_plate: Option<String>,
    car_model: Option<String>,
    department: Option<String>,
    department_id: Option<i64>,
    manager_staff_id: Option<i64>,
    enabled: bool,
    #[serde(default = "empty_profile")]
    profile: Value,
    updated_at: Option<DateTime<Utc>>,
}
fn empty_profile() -> Value {
    json!({})
}

fn clean(s: Option<String>, max: usize) -> AppResult<Option<String>> {
    let s = s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    if s.as_ref().is_some_and(|s| s.chars().count() > max) {
        return Err(AppError::BadRequest("입력 내용이 너무 깁니다.".into()));
    }
    Ok(s)
}
impl VehicleInput {
    fn validate(mut self) -> AppResult<Self> {
        self.name = self.name.trim().to_owned();
        if self.name.is_empty() || self.name.chars().count() > 120 {
            return Err(AppError::BadRequest(
                "차량명을 120자 이내로 입력해 주세요.".into(),
            ));
        }
        self.license_plate = clean(self.license_plate, 32)?;
        self.car_model = clean(self.car_model, 120)?;
        self.department = clean(self.department, 100)?;
        let p = self
            .profile
            .as_object_mut()
            .ok_or_else(|| AppError::BadRequest("잘못된 차량 정보입니다.".into()))?;
        let allowed = [
            "model_year",
            "engine_cc",
            "purchase_price_krw",
            "acquired_at",
            "vehicle_type",
            "fuel_type",
            "fuel_efficiency_kmpl",
            "note",
            "next_service_date",
            "next_service_km",
            "insurance_expiry",
            "inspection_expiry",
            "car_image_url",
            "odometer_km",
        ];
        if p.keys().any(|k| !allowed.contains(&k.as_str())) {
            return Err(AppError::BadRequest(
                "지원하지 않는 차량 항목입니다.".into(),
            ));
        }
        p.retain(|_, v| !v.is_null() && v.as_str() != Some(""));
        for (k, v) in p.iter() {
            let valid = match k.as_str() {
                "acquired_at" | "next_service_date" | "insurance_expiry" | "inspection_expiry" => v
                    .as_str()
                    .is_some_and(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()),
                "model_year" => v.as_i64().is_some_and(|n| (1900..=2200).contains(&n)),
                "engine_cc" => v.as_i64().is_some_and(|n| (0..=100_000).contains(&n)),
                "next_service_km" | "purchase_price_krw" => v
                    .as_i64()
                    .is_some_and(|n| (0..=1_000_000_000_000).contains(&n)),
                "odometer_km" => v
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=10_000_000.0).contains(&n)),
                "fuel_efficiency_kmpl" => v
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 1000.0),
                "vehicle_type" => v
                    .as_str()
                    .is_some_and(|s| ["sedan", "van", "truck", "special", "ev"].contains(&s)),
                "fuel_type" => v
                    .as_str()
                    .is_some_and(|s| ["gasoline", "diesel", "lpg", "ev"].contains(&s)),
                "car_image_url" => v.as_str().is_some_and(|s| {
                    s.len() <= 512 && s.starts_with("/uploads/car-images/") && !s.contains("..")
                }),
                "note" => v.as_str().is_some_and(|s| s.chars().count() <= 2000),
                _ => false,
            };
            if !valid {
                return Err(AppError::BadRequest(format!(
                    "차량 정보의 {k} 값을 확인해 주세요."
                )));
            }
        }
        Ok(self)
    }
}
fn db_error(e: sqlx::Error) -> AppError {
    match e.as_database_error().and_then(|e| e.code()).as_deref() {
        Some("23505") => AppError::Conflict("이미 등록된 차량번호입니다.".into()),
        Some("23P01") => AppError::Conflict(
            "이 시간에 다른 차량과 연결되어 있습니다. 연결 상태를 다시 확인해 주세요.".into(),
        ),
        _ => AppError::Database(e),
    }
}
async fn check_staff(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    id: Option<i64>,
) -> AppResult<()> {
    if let Some(id) = id {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM staff WHERE id=$1 AND user_id=$2 AND active)",
        )
        .bind(id)
        .bind(owner)
        .fetch_one(&mut **tx)
        .await?;
        if !ok {
            return Err(AppError::BadRequest(
                "현재 계정의 활성 사용자를 선택해 주세요.".into(),
            ));
        }
    }
    Ok(())
}
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    owner: i64,
    vehicle: i64,
    action: &str,
    before: Value,
    after: Value,
) -> AppResult<()> {
    sqlx::query("INSERT INTO fleet_vehicle_audit(owner_id,vehicle_id,action,before_value,after_value) VALUES($1,$2,$3,$4,$5)")
        .bind(owner).bind(vehicle).bind(action).bind(before).bind(after).execute(&mut **tx).await?;
    Ok(())
}
async fn read(state: &AppState, owner: i64, id: i64) -> AppResult<Vehicle> {
    let mut v: Vehicle = sqlx::query_as("SELECT * FROM fleet_vehicles WHERE id=$1 AND owner_id=$2")
        .bind(id)
        .bind(owner)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    v.bindings=sqlx::query_as("SELECT * FROM fleet_vehicle_bindings WHERE vehicle_id=$1 AND owner_id=$2 AND ended_at IS NULL ORDER BY is_primary DESC,id").bind(id).bind(owner).fetch_all(&state.db).await?;
    Ok(v)
}
async fn list(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<Vehicle>>> {
    let mut rows: Vec<Vehicle> = sqlx::query_as(
        "SELECT * FROM fleet_vehicles WHERE owner_id=$1 ORDER BY enabled DESC,name,id",
    )
    .bind(user.user_id)
    .fetch_all(&state.db)
    .await?;
    let bindings:Vec<Binding>=sqlx::query_as("SELECT * FROM fleet_vehicle_bindings WHERE owner_id=$1 AND ended_at IS NULL ORDER BY is_primary DESC,id").bind(user.user_id).fetch_all(&state.db).await?;
    for b in bindings {
        if let Some(v) = rows.iter_mut().find(|v| v.id == b.vehicle_id) {
            v.bindings.push(b);
        }
    }
    Ok(Json(rows))
}
async fn detail(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vehicle>> {
    Ok(Json(read(&state, user.user_id, id).await?))
}
async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<VehicleInput>,
) -> AppResult<Json<Vehicle>> {
    let mut p = input.validate()?;
    let mut tx = state.db.begin().await?;
    (p.department_id, p.department) = super::fleet_team::resolve_department(
        &mut tx,
        user.user_id,
        p.department_id,
        p.department,
        None,
    )
    .await?;
    check_staff(&mut tx, user.user_id, p.manager_staff_id).await?;
    if p.profile.get("car_image_url").is_some() {
        return Err(AppError::BadRequest(
            "사진은 차량 사진 업로드에서 등록해 주세요.".into(),
        ));
    }
    let id:i64=sqlx::query_scalar("INSERT INTO fleet_vehicles(owner_id,name,license_plate,car_model,department,manager_staff_id,enabled,profile,department_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id")
        .bind(user.user_id).bind(p.name).bind(p.license_plate).bind(p.car_model).bind(p.department).bind(p.manager_staff_id).bind(p.enabled).bind(p.profile).bind(p.department_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(v) FROM fleet_vehicles v WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    record(&mut tx, user.user_id, id, "create", Value::Null, after).await?;
    tx.commit().await?;
    Ok(Json(read(&state, user.user_id, id).await?))
}
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(input): Json<VehicleInput>,
) -> AppResult<Json<Vehicle>> {
    let mut p = input.validate()?;
    let expected = p
        .updated_at
        .ok_or_else(|| AppError::BadRequest("차량 정보를 새로 불러온 뒤 수정해 주세요.".into()))?;
    let mut tx = state.db.begin().await?;
    let before: Value = sqlx::query_scalar(
        "SELECT to_jsonb(v) FROM fleet_vehicles v WHERE id=$1 AND owner_id=$2 FOR UPDATE",
    )
    .bind(id)
    .bind(user.user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    (p.department_id, p.department) = super::fleet_team::resolve_department(
        &mut tx,
        user.user_id,
        p.department_id,
        p.department,
        before["department_id"].as_i64(),
    )
    .await?;
    if p.profile.get("car_image_url") != before.get("profile").and_then(|p| p.get("car_image_url"))
    {
        return Err(AppError::BadRequest(
            "사진은 차량 사진 업로드에서 변경해 주세요.".into(),
        ));
    }
    if p.manager_staff_id != before["manager_staff_id"].as_i64() {
        check_staff(&mut tx, user.user_id, p.manager_staff_id).await?;
    }
    let count=sqlx::query("UPDATE fleet_vehicles SET name=$3,license_plate=$4,car_model=$5,department=$6,manager_staff_id=$7,enabled=$8,profile=$9,department_id=$11,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND updated_at=$10")
        .bind(id).bind(user.user_id).bind(p.name).bind(p.license_plate).bind(p.car_model).bind(p.department).bind(p.manager_staff_id).bind(p.enabled).bind(p.profile).bind(expected).bind(p.department_id).execute(&mut *tx).await.map_err(db_error)?.rows_affected();
    if count == 0 {
        return Err(AppError::Conflict(
            "다른 곳에서 차량 정보가 변경됐습니다. 새로고침 후 다시 저장해 주세요.".into(),
        ));
    }
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(v) FROM fleet_vehicles v WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    record(&mut tx, user.user_id, id, "update", before, after).await?;
    tx.commit().await?;
    Ok(Json(read(&state, user.user_id, id).await?))
}
async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<Binding>>> {
    read(&state, user.user_id, id).await?;
    Ok(Json(sqlx::query_as("SELECT * FROM fleet_vehicle_bindings WHERE vehicle_id=$1 AND owner_id=$2 ORDER BY started_at DESC,id DESC").bind(id).bind(user.user_id).fetch_all(&state.db).await?))
}
async fn audit(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<Value>>> {
    read(&state, user.user_id, id).await?;
    Ok(Json(sqlx::query_scalar("SELECT to_jsonb(a) FROM fleet_vehicle_audit a WHERE vehicle_id=$1 AND owner_id=$2 ORDER BY id DESC LIMIT 100").bind(id).bind(user.user_id).fetch_all(&state.db).await?))
}
#[derive(Deserialize)]
struct ConnectionInput {
    device_ids: Vec<i64>,
    primary_device_id: Option<i64>,
    updated_at: DateTime<Utc>,
}
async fn connect(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(mut input): Json<ConnectionInput>,
) -> AppResult<Json<Vehicle>> {
    input.device_ids.sort_unstable();
    input.device_ids.dedup();
    if input.device_ids.len() > 20
        || input.device_ids.iter().any(|id| *id <= 0)
        || (!input.device_ids.is_empty()
            && !input
                .primary_device_id
                .is_some_and(|id| input.device_ids.contains(&id)))
        || (input.device_ids.is_empty() && input.primary_device_id.is_some())
    {
        return Err(AppError::BadRequest(
            "연결할 단말기와 대표 단말기 한 대를 선택해 주세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    let mut lock_ids:Vec<i64>=sqlx::query_scalar("SELECT device_id FROM fleet_vehicle_bindings WHERE vehicle_id=$1 AND owner_id=$2 AND ended_at IS NULL AND device_id IS NOT NULL").bind(id).bind(user.user_id).fetch_all(&mut *tx).await?;
    lock_ids.extend(&input.device_ids);
    lock_ids.sort_unstable();
    lock_ids.dedup();
    let _: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM devices WHERE id=ANY($1) ORDER BY id FOR UPDATE")
            .bind(&lock_ids)
            .fetch_all(&mut *tx)
            .await?;
    // Lock SIM rows before the vehicle. Owner-release uses the same SIM row lock.
    let devices:Vec<(i64,String)>=sqlx::query_as("SELECT id,COALESCE(display_name,device_uid) FROM devices WHERE id=ANY($1) AND owner_id=$2 ORDER BY id FOR UPDATE")
        .bind(&input.device_ids).bind(user.user_id).fetch_all(&mut *tx).await?;
    if devices.len() != input.device_ids.len() {
        return Err(AppError::BadRequest(
            "현재 계정에 등록된 단말기만 연결할 수 있습니다.".into(),
        ));
    }
    let v: Vehicle =
        sqlx::query_as("SELECT * FROM fleet_vehicles WHERE id=$1 AND owner_id=$2 FOR UPDATE")
            .bind(id)
            .bind(user.user_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    if v.updated_at != input.updated_at {
        return Err(AppError::Conflict(
            "차량 연결이 변경됐습니다. 새로고침 후 다시 시도해 주세요.".into(),
        ));
    }
    let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_vehicle_bindings WHERE device_id=ANY($1) AND vehicle_id<>$2 AND ended_at IS NULL)").bind(&input.device_ids).bind(id).fetch_one(&mut *tx).await?;
    if used {
        return Err(AppError::Conflict(
            "다른 차량에 연결된 단말기가 있습니다. 기존 차량에서 연결을 해제해 주세요.".into(),
        ));
    }
    let old:Vec<Binding>=sqlx::query_as("SELECT * FROM fleet_vehicle_bindings WHERE vehicle_id=$1 AND ended_at IS NULL ORDER BY id FOR UPDATE").bind(id).fetch_all(&mut *tx).await?;
    let at:DateTime<Utc>=sqlx::query_scalar("SELECT GREATEST(clock_timestamp(),COALESCE(max(started_at)+interval '1 microsecond',clock_timestamp())) FROM fleet_vehicle_bindings WHERE vehicle_id=$1").bind(id).fetch_one(&mut *tx).await?;
    for b in &old {
        if !b.device_id.is_some_and(|d| input.device_ids.contains(&d))
            || b.is_primary != (b.device_id == input.primary_device_id)
        {
            sqlx::query("UPDATE fleet_vehicle_bindings SET ended_at=$2 WHERE id=$1")
                .bind(b.id)
                .bind(at)
                .execute(&mut *tx)
                .await?;
        }
    }
    for (device, name) in devices {
        let primary = Some(device) == input.primary_device_id;
        if old
            .iter()
            .any(|b| b.device_id == Some(device) && b.is_primary == primary)
        {
            continue;
        }
        sqlx::query("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(id).bind(user.user_id).bind(device).bind(name).bind(primary).bind(at).execute(&mut *tx).await.map_err(db_error)?;
    }
    sqlx::query("UPDATE fleet_vehicles SET updated_at=$2 WHERE id=$1")
        .bind(id)
        .bind(at)
        .execute(&mut *tx)
        .await?;
    record(&mut tx,user.user_id,id,"connections",json!(old),json!({"device_ids":input.device_ids,"primary_device_id":input.primary_device_id,"effective_at":at})).await?;
    tx.commit().await?;
    Ok(Json(read(&state, user.user_id, id).await?))
}

async fn trips(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<super::corporate::TripQuery>,
) -> AppResult<Json<Vec<Value>>> {
    read(&state, user.user_id, id).await?;
    let (from, to) = super::corporate::parse_range(&q)?;
    if to - from > chrono::Duration::days(366) {
        return Err(AppError::BadRequest(
            "최대 1년까지 조회할 수 있습니다.".into(),
        ));
    }
    Ok(Json(
        allocated_trips(&state, user.user_id, id, from, to).await?,
    ))
}

pub(super) async fn allocated_trips(
    state: &AppState,
    owner: i64,
    vehicle: i64,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> AppResult<Vec<Value>> {
    let periods:Vec<Binding>=sqlx::query_as("SELECT * FROM fleet_vehicle_bindings WHERE vehicle_id=$1 AND owner_id=$2 AND is_primary AND device_id IS NOT NULL AND started_at<=$4 AND (ended_at IS NULL OR ended_at>$3) ORDER BY started_at,id")
        .bind(vehicle).bind(owner).bind(from).bind(to).fetch_all(&state.db).await?;
    let mut per_sim = std::collections::BTreeMap::new();
    for b in &periods {
        let sim = b.device_id.unwrap();
        if let std::collections::btree_map::Entry::Vacant(entry) = per_sim.entry(sim) {
            let rows = super::corporate::compute_trips_inner(state, owner, sim, from, to).await?;
            entry.insert(
                rows.into_iter()
                    .map(|t| serde_json::to_value(t).expect("serializable trip"))
                    .collect::<Vec<_>>(),
            );
        }
    }
    let mut result = Vec::new();
    for b in periods {
        let sim = b.device_id.unwrap();
        for original in &per_sim[&sim] {
            let start = DateTime::parse_from_rfc3339(original["started_at"].as_str().unwrap())
                .unwrap()
                .with_timezone(&Utc);
            let end = original["ended_at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc));
            let interval_end = b.ended_at.unwrap_or(to + chrono::Duration::microseconds(1));
            if start >= interval_end || end.unwrap_or(to) <= b.started_at && start < b.started_at {
                continue;
            }
            let mut row = original.clone();
            row["source_device_id"] = json!(sim);
            row["vehicle_id"] = json!(vehicle);
            row["source_started_at"] = json!(start);
            row["binding_id"] = json!(b.id);
            let crossing =
                start < b.started_at || b.ended_at.is_some_and(|at| end.is_none_or(|end| end > at));
            if crossing {
                // Keep the SIM record untouched. A trip spanning a reassignment
                // must be reviewed instead of counted in both vehicles.
                row["started_at"] = json!(start.max(b.started_at));
                row["ended_at"] = json!(end.map(|end| end.min(interval_end)));
                row["distance_m"] = Value::Null;
                row["duration_min"] = Value::Null;
                if let Some(ann) = row["annotation"].as_object_mut() {
                    ann.insert("fuel_cost".into(), Value::Null);
                    ann.insert("fuel_liters".into(), Value::Null);
                }
                row["allocation_status"] = json!("boundary_review");
                row["allocation_note"] = json!("단말기 연결 변경 구간 · 거리 합계 제외");
                row["start_address"] = Value::Null;
                row["end_address"] = Value::Null;
                for k in ["start_lat", "start_lng", "end_lat", "end_lng"] {
                    row[k] = Value::Null;
                }
            } else {
                row["allocation_status"] = json!("assigned");
            }
            result.push(row);
        }
    }
    result.sort_by(|a, b| a["started_at"].as_str().cmp(&b["started_at"].as_str()));
    crate::services::fleet_sites::attach_trip_sites(&state.db, owner, &mut result).await?;
    Ok(result)
}

#[derive(Deserialize)]
struct VehicleAnnotation {
    binding_id: i64,
    source_device_id: i64,
    #[serde(flatten)]
    annotation: super::corporate::AnnotationPayload,
}
async fn annotation(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    scope: Option<Extension<crate::auth::fleet::FleetScope>>,
    Json(p): Json<VehicleAnnotation>,
) -> AppResult<Json<super::corporate::TripAnnotation>> {
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_vehicle_bindings WHERE id=$1 AND owner_id=$2 AND vehicle_id=$3 AND device_id=$4 AND is_primary AND started_at<=$5 AND (ended_at IS NULL OR ended_at>$5))")
        .bind(p.binding_id).bind(user.user_id).bind(id).bind(p.source_device_id).bind(p.annotation.trip_started_at).fetch_one(&state.db).await?;
    if !allowed {
        return Err(AppError::NotFound);
    }
    let mut tx = state.db.begin().await?;
    // Retaining a historical driver is different from assigning a new one.
    // Deactivation or vehicle reassignment must not prevent correcting its note.
    let retained: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM trip_annotations WHERE user_id=$1 AND device_id=$2 AND trip_started_at=$3 AND driver_staff_id=$4)")
        .bind(user.user_id).bind(p.source_device_id).bind(p.annotation.trip_started_at)
        .bind(p.annotation.driver_staff_id).fetch_one(&mut *tx).await?;
    if !retained {
        super::fleet_team::driver_allowed(&mut tx, user.user_id, p.annotation.driver_staff_id, id)
            .await?;
    }
    tx.commit().await?;
    super::corporate::save_annotation(
        &state,
        user,
        p.source_device_id,
        p.annotation,
        scope
            .as_ref()
            .and_then(|s| if s.manager() { None } else { s.staff }),
        scope.map(|s| s.actor),
    )
    .await
}
async fn stats(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    // Daily aggregates are only attributable when one primary binding covers
    // the entire day. A reassignment day stays unaggregated, never copied twice.
    let rows:Vec<Value>=sqlx::query_scalar(r#"WITH assigned AS (
      SELECT b.vehicle_id,ds.* FROM fleet_vehicle_bindings b JOIN daily_stats ds
       ON ds.device_id=b.device_id AND ds.user_id=b.owner_id
       AND (ds.date::timestamp AT TIME ZONE 'Asia/Seoul')>=b.started_at
       AND (b.ended_at IS NULL OR ((ds.date+1)::timestamp AT TIME ZONE 'Asia/Seoul')<=b.ended_at)
       WHERE b.owner_id=$1 AND b.is_primary AND ds.date>=date_trunc('month',now() AT TIME ZONE 'Asia/Seoul')::date
    ) SELECT jsonb_build_object('vehicle_id',v.id,'device_id',v.id,
       'total_distance_m',COALESCE(sum(a.distance_m),0),
       'today_distance_m',sum(a.distance_m) FILTER(WHERE a.date=(now() AT TIME ZONE 'Asia/Seoul')::date),
       'today_fix_count',COALESCE(sum(a.fix_count) FILTER(WHERE a.date=(now() AT TIME ZONE 'Asia/Seoul')::date),0),
       'today_last_fix_at',max(a.last_fix_at) FILTER(WHERE a.date=(now() AT TIME ZONE 'Asia/Seoul')::date),
       'today_updated_at',max(a.updated_at) FILTER(WHERE a.date=(now() AT TIME ZONE 'Asia/Seoul')::date))
     FROM fleet_vehicles v LEFT JOIN assigned a ON a.vehicle_id=v.id
     WHERE v.owner_id=$1 GROUP BY v.id ORDER BY v.id"#).bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(
        json!({"per_device":rows,"basis":"full_primary_binding_days"}),
    ))
}

pub(super) async fn verify_owner(state: &AppState, owner: i64, id: i64) -> AppResult<()> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM fleet_vehicles WHERE id=$1 AND owner_id=$2)",
    )
    .bind(id)
    .bind(owner)
    .fetch_one(&state.db)
    .await?;
    if ok {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}
