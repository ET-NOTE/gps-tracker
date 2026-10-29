//! Explicit company scope. Personal/SIM APIs never accept delegated ownership.
use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    body::{to_bytes, Body},
    extract::{FromRequestParts, Request, State},
    http::{header, Method},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct FleetScope {
    pub owner: i64,
    pub actor: i64,
    pub staff: Option<i64>,
    pub role: String,
    pub department: Option<i64>,
    pub vehicles: Vec<i64>,
    pub staff_ids: Vec<i64>,
}
impl FleetScope {
    pub fn admin(&self) -> bool {
        self.role == "owner" || self.role == "admin"
    }
    pub fn manager(&self) -> bool {
        self.admin() || self.role == "department_manager"
    }
    pub fn vehicle(&self, id: i64) -> AppResult<()> {
        if self.vehicles.contains(&id) {
            Ok(())
        } else {
            Err(AppError::NotFound)
        }
    }
}
pub async fn load(state: &AppState, actor: i64, owner: i64) -> AppResult<FleetScope> {
    let (staff, role, department) = if owner == actor {
        (None, "owner".to_string(), None)
    } else {
        let (id,role,dep):(i64,String,Option<i64>)=sqlx::query_as("SELECT s.id,s.access_role,s.department_id FROM fleet_staff_accounts a JOIN staff s ON s.id=a.staff_id AND s.user_id=a.owner_id WHERE a.owner_id=$1 AND a.account_id=$2 AND s.active")
   .bind(owner).bind(actor).fetch_optional(&state.db).await?.ok_or(AppError::Forbidden)?;
        (Some(id), role, dep)
    };
    let admin = role == "owner" || role == "admin";
    let vehicles=sqlx::query_scalar("SELECT v.id FROM fleet_vehicles v WHERE v.owner_id=$1 AND ($2 OR ($3='department_manager' AND v.department_id=$4) OR ($3='member' AND EXISTS(SELECT 1 FROM staff s WHERE s.id=$5 AND s.user_id=$1 AND (s.all_vehicles OR v.manager_staff_id=s.id OR EXISTS(SELECT 1 FROM fleet_staff_vehicles x WHERE x.owner_id=$1 AND x.staff_id=s.id AND x.vehicle_id=v.id))))) ORDER BY v.id")
  .bind(owner).bind(admin).bind(&role).bind(department).bind(staff).fetch_all(&state.db).await?;
    let staff_ids=sqlx::query_scalar("SELECT id FROM staff WHERE user_id=$1 AND ($2 OR ($3='department_manager' AND department_id=$4) OR id=$5)")
  .bind(owner).bind(admin).bind(&role).bind(department).bind(staff).fetch_all(&state.db).await?;
    Ok(FleetScope {
        owner,
        actor,
        staff,
        role,
        department,
        vehicles,
        staff_ids,
    })
}
pub async fn middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    match scoped(state, req, next).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}
async fn scoped(state: AppState, req: Request, next: Next) -> AppResult<Response> {
    let Some(value) = req.headers().get("x-fleet-owner") else {
        return Ok(next.run(req).await);
    };
    let owner = value
        .to_str()
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .ok_or(AppError::Forbidden)?;
    let (mut parts, body) = req.into_parts();
    let actor = AuthUser::from_request_parts(&mut parts, &state)
        .await?
        .user_id;
    let scope = load(&state, actor, owner).await?;
    let path = parts.uri.path().to_string();
    let path = path
        .strip_prefix("/gps-tracker/api/v1")
        .unwrap_or(&path)
        .to_string();
    // This allowlist is deliberately independent from ownership checks in handlers.
    // A new API is inaccessible to delegated accounts until its scoping is reviewed.
    if !path.starts_with("/corporate/") && !path.starts_with("/documents/") {
        return Err(AppError::Forbidden);
    }
    if path == "/corporate/workspaces" || path == "/corporate/join" {
        return Err(AppError::Forbidden);
    }
    if scope.actor == scope.owner {
        parts.extensions.insert(scope);
        return Ok(next.run(Request::from_parts(parts, body)).await);
    }
    let method = parts.method.clone();
    let read = method == Method::GET;
    let admin = scope.admin();
    let manager = scope.manager();
    let pieces: Vec<&str> = path.trim_matches('/').split('/').collect();
    let id = pieces.get(2).and_then(|s| s.parse::<i64>().ok());
    let mut booking_id = None;
    let allowed = match pieces.as_slice() {
        ["corporate", "access"] | ["corporate", "organization"] => read,
        ["corporate", "organization", ..] => admin,
        ["corporate", "team-audit"] => read && admin,
        ["corporate", "sites"] | ["corporate", "site-groups"] => read || admin,
        ["corporate", "sites", _] | ["corporate", "site-groups", _] => admin,
        ["corporate", "site-visits"] => read,
        ["corporate", "expense-categories", ..] => read || admin,
        // Every expense/receipt handler enforces row-level staff, department,
        // vehicle and review permissions; no generic owner substitution alone.
        ["corporate", "expenses", ..] => true,
        ["corporate", "staff"] => read || admin,
        ["corporate", "staff", _, ..] => admin,
        ["corporate", "invites", ..] => admin,
        ["corporate", "info"] => read || admin,
        ["corporate", "subscription"] | ["corporate", "fuel-prices"] => read,
        ["corporate", "vehicles"] => read || admin,
        ["corporate", "terminals"]
        | ["corporate", "vehicle-stats"]
        | ["corporate", "report.xlsx"] => read,
        ["corporate", "vehicles", _, rest @ ..] => {
            scope.vehicle(id.ok_or(AppError::NotFound)?)?;
            match rest {
                [] => read || admin,
                ["bindings"] | ["audit"] => admin,
                ["trips"] => read,
                ["trip-rules", ..] => read || admin,
                ["trips", "assign"] => method == Method::POST,
                ["trips", "assignment-history"] => read && manager,
                ["trips", "annotation"] => method == Method::PATCH,
                ["photo"] => read || admin,
                ["documents"] => manager,
                _ => false,
            }
        }
        ["corporate", "vehicle-reservations"] => read || method == Method::POST,
        ["corporate", "vehicle-reservations", _] => {
            let rid = id.ok_or(AppError::NotFound)?;
            let (v,driver):(i64,Option<i64>)=sqlx::query_as("SELECT fleet_vehicle_id,driver_staff_id FROM vehicle_reservations WHERE id=$1 AND user_id=$2 AND fleet_vehicle_id IS NOT NULL")
    .bind(rid).bind(owner).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
            scope.vehicle(v)?;
            if !manager && driver != scope.staff {
                return Err(AppError::Forbidden);
            }
            booking_id = Some(rid);
            method == Method::PUT || method == Method::DELETE
        }
        ["documents", doc, rest @ ..] => {
            let doc = doc.parse::<i64>().map_err(|_| AppError::NotFound)?;
            let vehicle: Option<i64> = sqlx::query_scalar(
                "SELECT fleet_vehicle_id FROM device_documents WHERE id=$1 AND user_id=$2",
            )
            .bind(doc)
            .bind(owner)
            .fetch_optional(&state.db)
            .await?
            .flatten();
            scope.vehicle(vehicle.ok_or(AppError::NotFound)?)?;
            manager
                && matches!(
                    (read, rest),
                    (true, ["download"] | ["preview"]) | (false, [])
                )
        }
        _ => false,
    };
    if !allowed {
        return Err(AppError::Forbidden);
    }
    let json_write = !read
        && (path.contains("vehicle-reservations") || path.ends_with("trips/annotation"))
        && method != Method::DELETE;
    let body = if json_write {
        let bytes = to_bytes(body, 1024 * 1024)
            .await
            .map_err(|_| AppError::BadRequest("요청이 너무 큽니다.".into()))?;
        let data: Value = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::BadRequest("입력 내용을 확인해 주세요.".into()))?;
        if path.contains("vehicle-reservations") {
            scope.vehicle(data["vehicle_id"].as_i64().ok_or(AppError::NotFound)?)?;
        }
        let driver = data["driver_staff_id"].as_i64();
        if !manager && driver != scope.staff {
            return Err(AppError::Forbidden);
        }
        if driver.is_some_and(|id| !scope.staff_ids.contains(&id)) {
            return Err(AppError::Forbidden);
        }
        if !manager && path.ends_with("trips/annotation") {
            let other:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM trip_annotations WHERE user_id=$1 AND device_id=$2 AND trip_started_at=$3::text::timestamptz AND driver_staff_id IS NOT NULL AND driver_staff_id<>$4)")
    .bind(owner).bind(data["source_device_id"].as_i64()).bind(data["trip_started_at"].as_str()).bind(scope.staff).fetch_one(&state.db).await?;
            if other {
                return Err(AppError::Forbidden);
            }
        }
        Body::from(bytes)
    } else {
        body
    };
    if path == "/corporate/report.xlsx" {
        let mut url = reqwest::Url::parse(&format!("http://scope{}", parts.uri))
            .map_err(|_| AppError::BadRequest("잘못된 조회입니다.".into()))?;
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let requested = pairs
            .iter()
            .filter(|(k, _)| k == "vehicle_ids")
            .flat_map(|(_, v)| v.split(','))
            .map(str::parse::<i64>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AppError::BadRequest("차량 선택을 확인해 주세요.".into()))?;
        for id in &requested {
            scope.vehicle(*id)?;
        }
        let ids = if requested.is_empty() {
            scope.vehicles.clone()
        } else {
            requested
        };
        // Empty list must never turn into the report handler's 'all vehicles' default.
        if ids.is_empty() {
            return Err(AppError::NotFound);
        }
        url.set_query(None);
        {
            let mut q = url.query_pairs_mut();
            for (k, v) in pairs {
                if !["scope", "vehicle_ids", "device_ids"].contains(&k.as_str()) {
                    q.append_pair(&k, &v);
                }
            }
            q.append_pair("scope", "vehicles").append_pair(
                "vehicle_ids",
                &ids.iter().map(i64::to_string).collect::<Vec<_>>().join(","),
            );
        }
        parts.uri = format!("{}?{}", url.path(), url.query().unwrap_or(""))
            .parse()
            .map_err(|_| AppError::BadRequest("잘못된 조회입니다.".into()))?;
    }
    parts.extensions.insert(scope.clone());
    let audit = if !read {
        Some(sqlx::query_scalar::<_,i64>("INSERT INTO fleet_team_audit(owner_id,actor_id,action,target_id,after_value) VALUES($1,$2,$3,$4,$5) RETURNING id")
  .bind(owner).bind(actor).bind("delegated_request").bind(booking_id.or(id)).bind(json!({"method":method.as_str(),"path":path,"status":"started"})).fetch_one(&state.db).await?)
    } else {
        None
    };
    let response = next.run(Request::from_parts(parts, body)).await;
    if let Some(id) = audit {
        sqlx::query("UPDATE fleet_team_audit SET after_value=after_value||jsonb_build_object('status',$2::integer) WHERE id=$1").bind(id).bind(i32::from(response.status().as_u16())).execute(&state.db).await?;
    }
    if !response.status().is_success() {
        return Ok(response);
    }
    let filter = matches!(
        path.as_str(),
        "/corporate/vehicles"
            | "/corporate/staff"
            | "/corporate/vehicle-reservations"
            | "/corporate/vehicle-stats"
            | "/corporate/terminals"
    );
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    if !filter {
        return Ok(Response::from_parts(parts, body));
    }
    let bytes = to_bytes(body, 32 * 1024 * 1024)
        .await
        .map_err(|_| AppError::Internal(anyhow::anyhow!("Scoped response too large")))?;
    let mut data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("Invalid scoped JSON")))?;
    match path.as_str() {
        "/corporate/vehicles" => {
            if let Some(rows) = data.as_array_mut() {
                rows.retain(|r| {
                    r["id"]
                        .as_i64()
                        .is_some_and(|id| scope.vehicles.contains(&id))
                });
            }
        }
        "/corporate/staff" => {
            if let Some(rows) = data.as_array_mut() {
                rows.retain(|r| {
                    r["id"]
                        .as_i64()
                        .is_some_and(|id| scope.staff_ids.contains(&id))
                });
            }
        }
        "/corporate/vehicle-reservations" => {
            if let Some(rows) = data.as_array_mut() {
                rows.retain(|r| {
                    r["vehicle_id"]
                        .as_i64()
                        .is_some_and(|id| scope.vehicles.contains(&id))
                        && (manager || r["driver_staff_id"].as_i64() == scope.staff)
                });
            }
        }
        "/corporate/vehicle-stats" => {
            if let Some(rows) = data["per_device"].as_array_mut() {
                rows.retain(|r| {
                    r["vehicle_id"]
                        .as_i64()
                        .is_some_and(|id| scope.vehicles.contains(&id))
                });
            }
        }
        "/corporate/terminals" => {
            let sims:Vec<i64>=sqlx::query_scalar("SELECT DISTINCT device_id FROM fleet_vehicle_bindings WHERE owner_id=$1 AND vehicle_id=ANY($2) AND ended_at IS NULL AND device_id IS NOT NULL").bind(owner).bind(&scope.vehicles).fetch_all(&state.db).await?;
            if let Some(rows) = data.as_array_mut() {
                rows.retain(|r| admin || r["id"].as_i64().is_some_and(|id| sims.contains(&id)));
                for r in rows {
                    if let Some(obj) = r.as_object_mut() {
                        for key in ["iccid", "imei", "imsi", "last_stationary", "note"] {
                            obj.remove(key);
                        }
                    }
                }
            }
        }
        _ => {}
    }
    parts.headers.remove(header::CONTENT_LENGTH);
    Ok(Response::from_parts(
        parts,
        Body::from(serde_json::to_vec(&data).map_err(|e| AppError::Internal(e.into()))?),
    ))
}
