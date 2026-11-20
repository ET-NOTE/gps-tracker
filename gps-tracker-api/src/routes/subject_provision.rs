use crate::{
    auth::{fleet::FleetScope, AuthUser},
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/corporate/subject-mappings",
            get(company_list).post(propose),
        )
        .route("/corporate/subject-mappings/:id/locations", get(locations))
        .route("/corporate/subject-bindings", get(binding_list))
        .route("/privacy/subject-mappings", get(personal_list))
        .route("/privacy/subject-mappings/:id/decision", post(decide))
        .route("/privacy/provision-notices", get(notices))
        .route("/privacy/provision-notices/:id/read", post(mark_read))
        .route("/privacy/provision-notices/:id/retry", post(retry))
        .layer(axum::middleware::from_fn(super::privacy_delivery::no_store))
}

fn pilot() -> AppResult<()> {
    if crate::services::subject_provision::enabled() {
        Ok(())
    } else {
        Err(AppError::Conflict(
            "정보주체 연결 기능은 아직 활성화되지 않았습니다.".into(),
        ))
    }
}
fn self_session(headers: &HeaderMap, state: &AppState, uid: i64) -> AppResult<()> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let claims = crate::auth::jwt::verify(token, &state.config.jwt_secret, "access")
        .map_err(|_| AppError::Unauthorized)?;
    if claims.act.is_some()
        || claims.sub != uid.to_string()
        || headers.contains_key("x-fleet-owner")
    {
        return Err(AppError::Forbidden);
    }
    Ok(())
}
async fn fence(tx: &mut Transaction<'_, Postgres>) -> AppResult<()> {
    let ok: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
        .bind(crate::services::privacy_lifecycle::LOCK)
        .fetch_one(&mut **tx)
        .await?;
    if !ok {
        return Err(AppError::Conflict(
            "조회 처리 중입니다. 잠시 후 다시 시도해 주세요.".into(),
        ));
    }
    Ok(())
}
async fn personal_list(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> AppResult<Json<Value>> {
    self_session(&headers, &state, user.user_id)?;
    let limit = page.validate(true)?;
    let mut read = crate::services::location_read_budget::ReadQuery::start(&state.db).await?;
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(m)||jsonb_build_object('effective',EXISTS(SELECT 1 FROM location_subject_effective e WHERE e.id=m.id),'has_successor',EXISTS(SELECT 1 FROM location_subject_mappings n WHERE n.replaces_id=m.id),'owner_name',COALESCE(NULLIF(c.company_name,''),u.display_name),'vehicle_name',v.name) FROM location_subject_mappings m LEFT JOIN corporate_info c ON c.user_id=m.owner_id LEFT JOIN users u ON u.id=m.owner_id LEFT JOIN fleet_vehicles v ON v.id=m.vehicle_id AND v.owner_id=m.owner_id WHERE m.subject_id=$1 AND ($2::bigint IS NULL OR m.id<$2) AND ($3::text IS NULL OR m.status=$3) ORDER BY m.id DESC LIMIT $4").bind(user.user_id).bind(page.before).bind(page.status).bind(limit+1).fetch_all(read.connection()).await.map_err(crate::services::location_read_budget::query_error)?;
    read.finish().await?;
    let next = page_cursor(&mut rows, limit);
    Ok(Json(
        json!({"enabled":crate::services::subject_provision::enabled(),"items":rows,"next_before":next,"consent_text":"지정된 차량·SIM의 해당 기간 운전자임을 확인하고, 차량 운영 목적으로 이 회사의 권한 있는 사용자에게 위치·운행 기록을 제공하는 데 동의합니다. 예약·SIM 소유만으로 운전자로 확정하지 않습니다. 철회하면 이후 제공을 중지하며 이미 제공된 자료는 회수되지 않습니다.","consent_version":"fleet-subject-v1"}),
    ))
}
async fn company_list(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Query(page): Query<CompanyPage>,
) -> AppResult<Json<Value>> {
    let scope = company_scope(&state, user, scope).await?;
    if !scope.admin() {
        return Err(AppError::Forbidden);
    }
    let limit = page.validate()?;
    let mut read = crate::services::location_read_budget::ReadQuery::start(&state.db).await?;
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(m)||jsonb_build_object('effective',EXISTS(SELECT 1 FROM location_subject_effective e WHERE e.id=m.id),'has_successor',EXISTS(SELECT 1 FROM location_subject_mappings n WHERE n.replaces_id=m.id)) FROM location_subject_mappings m WHERE owner_id=$1 AND ($2::bigint IS NULL OR m.id<$2) AND ($3::text IS NULL OR m.status=$3) ORDER BY m.id DESC LIMIT $4")
        .bind(scope.owner).bind(page.before).bind(page.status).bind(limit+1).fetch_all(read.connection()).await.map_err(crate::services::location_read_budget::query_error)?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last().map(|r| r["id"].clone())
    } else {
        None
    };
    let binding_ids: Vec<i64> = rows
        .iter()
        .filter_map(|r| r["binding_id"].as_i64())
        .collect();
    let people:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('staff_id',s.id,'subject_id',a.account_id,'name',s.name) FROM staff s JOIN fleet_staff_accounts a ON a.staff_id=s.id AND a.owner_id=s.user_id WHERE s.user_id=$1 AND s.active ORDER BY s.id").bind(scope.owner).fetch_all(read.connection()).await.map_err(crate::services::location_read_budget::query_error)?;
    // Old mapping revisions must retain their owned binding option even when
    // that binding is outside the recent200 used for creating new requests.
    let bindings:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',b.id,'vehicle_id',b.vehicle_id,'device_id',b.device_id,'starts_at',b.started_at,'ends_at',b.ended_at) FROM fleet_vehicle_bindings b WHERE b.owner_id=$1 AND b.device_id IS NOT NULL AND (b.id IN (SELECT id FROM fleet_vehicle_bindings WHERE owner_id=$1 AND device_id IS NOT NULL ORDER BY id DESC LIMIT 200) OR b.id=ANY($2::bigint[])) ORDER BY b.id DESC").bind(scope.owner).bind(binding_ids).fetch_all(read.connection()).await.map_err(crate::services::location_read_budget::query_error)?;
    read.finish().await?;
    Ok(Json(
        json!({"enabled":crate::services::subject_provision::enabled(),"items":rows,"people":people,"bindings":bindings,"next_before":next}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompanyPage {
    before: Option<i64>,
    status: Option<String>,
    limit: Option<i64>,
}
impl CompanyPage {
    fn validate(&self) -> AppResult<i64> {
        let limit = self.limit.unwrap_or(200);
        if !(1..=200).contains(&limit)
            || self.before.is_some_and(|v| v <= 0)
            || self.status.as_deref().is_some_and(|v| {
                !matches!(
                    v,
                    "pending" | "confirmed" | "rejected" | "revoked" | "superseded"
                )
            })
        {
            return Err(AppError::BadRequest(
                "연결 목록 조회 조건이 올바르지 않습니다.".into(),
            ));
        }
        Ok(limit)
    }
}
#[cfg(test)]
mod company_page_tests {
    use super::*;
    #[test]
    fn bounded_company_filters_preserve_legacy_default_and_reject_owner_override() {
        assert_eq!(
            serde_json::from_value::<CompanyPage>(json!({}))
                .unwrap()
                .validate()
                .unwrap(),
            200
        );
        assert_eq!(
            serde_json::from_value::<CompanyPage>(
                json!({"before":300,"status":"revoked","limit":50})
            )
            .unwrap()
            .validate()
            .unwrap(),
            50
        );
        for value in [
            json!({"before":0}),
            json!({"limit":201}),
            json!({"limit":0}),
            json!({"status":"all"}),
        ] {
            assert!(serde_json::from_value::<CompanyPage>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_value::<CompanyPage>(json!({"owner_id":1})).is_err());
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BindingPage {
    before: Option<i64>,
    q: Option<String>,
    limit: Option<i64>,
}
impl BindingPage {
    fn validate(&self) -> AppResult<(i64, &str)> {
        let limit = self.limit.unwrap_or(50);
        let query = self.q.as_deref().unwrap_or("").trim();
        if !(1..=100).contains(&limit)
            || self.before.is_some_and(|v| v <= 0)
            || self
                .q
                .as_deref()
                .is_some_and(|v| v.chars().count() > 80 || v.chars().any(char::is_control))
        {
            return Err(AppError::BadRequest(
                "차량·SIM 연결 검색 조건을 확인하세요.".into(),
            ));
        }
        Ok((limit, query))
    }
}
async fn binding_list(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Query(page): Query<BindingPage>,
) -> AppResult<Json<Value>> {
    let scope = company_scope(&state, user, scope).await?;
    if !scope.admin() {
        return Err(AppError::Forbidden);
    }
    let (limit, query) = page.validate()?;
    let mut read = crate::services::location_read_budget::ReadQuery::start(&state.db).await?;
    // Search owned binding metadata only. Choosing a result grants no location
    // access; proposal and subject consent still validate the current authority.
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',b.id,'vehicle_id',b.vehicle_id,'device_id',b.device_id,'starts_at',b.started_at,'ends_at',b.ended_at,'vehicle_name',v.name,'terminal_name',b.terminal_name) FROM fleet_vehicle_bindings b JOIN fleet_vehicles v ON v.id=b.vehicle_id AND v.owner_id=b.owner_id WHERE b.owner_id=$1 AND b.device_id IS NOT NULL AND ($2::bigint IS NULL OR b.id<$2) AND ($3::text='' OR strpos(lower(v.name),lower($3))>0 OR strpos(lower(coalesce(b.terminal_name,'')),lower($3))>0 OR b.device_id::text=$3) ORDER BY b.id DESC LIMIT $4")
        .bind(scope.owner).bind(page.before).bind(query).bind(limit+1).fetch_all(read.connection()).await.map_err(crate::services::location_read_budget::query_error)?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items.last().map(|r| r["id"].clone())
    } else {
        None
    };
    read.finish().await?;
    Ok(Json(
        json!({"items":items,"next_before":next,"enabled":crate::services::subject_provision::enabled()}),
    ))
}
#[cfg(test)]
mod binding_page_tests {
    use super::*;
    #[test]
    fn bounded_literal_search_and_owner_override_rejection() {
        let value = serde_json::from_value::<BindingPage>(json!({"q":"  차량_%  "})).unwrap();
        assert_eq!(value.validate().unwrap(), (50, "차량_%"));
        for value in [
            json!({"q":"한".repeat(81)}),
            json!({"q":"line\nbreak"}),
            json!({"before":0}),
            json!({"limit":101}),
            json!({"limit":0}),
        ] {
            assert!(serde_json::from_value::<BindingPage>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_value::<BindingPage>(json!({"owner_id":1})).is_err());
    }
}
#[derive(Deserialize)]
struct Proposal {
    request_key: uuid::Uuid,
    staff_id: i64,
    binding_id: i64,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    replaces_id: Option<i64>,
    replaces_revision: Option<i64>,
    change_kind: Option<String>,
}
async fn propose(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(req): Json<Proposal>,
) -> AppResult<Json<Value>> {
    let scope = company_scope(&state, user, scope).await?;
    pilot()?;
    if !scope.admin() {
        return Err(AppError::Forbidden);
    }
    if req.starts_at >= req.ends_at
        || req.ends_at - req.starts_at > chrono::Duration::days(31)
        || req.starts_at > Utc::now()
    {
        return Err(AppError::BadRequest(
            "시작은 현재 이전, 기간은 31일 이내로 입력하세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    fence(&mut tx).await?;
    type ExistingProposal = (
        i64,
        i64,
        i64,
        DateTime<Utc>,
        DateTime<Utc>,
        Option<i64>,
        Option<i64>,
        Option<String>,
    );
    let old:Option<ExistingProposal>=sqlx::query_as("SELECT id,staff_id,binding_id,starts_at,ends_at,replaces_id,replaces_revision,change_kind FROM location_subject_mappings WHERE owner_id=$1 AND request_key=$2::text::uuid").bind(scope.owner).bind(req.request_key.to_string()).fetch_optional(&mut *tx).await?;
    if let Some((id, s, b, f, t, parent, rev, kind)) = old {
        if (s, b, f, t, parent, rev, kind.as_deref())
            != (
                req.staff_id,
                req.binding_id,
                req.starts_at,
                req.ends_at,
                req.replaces_id,
                req.replaces_revision,
                req.change_kind.as_deref(),
            )
        {
            return Err(AppError::Conflict(
                "같은 요청 번호의 내용이 변경됐습니다.".into(),
            ));
        }
        return Ok(Json(json!({"id":id})));
    }
    let binding:Option<(i64,i64)>=sqlx::query_as("SELECT vehicle_id,device_id FROM fleet_vehicle_bindings WHERE id=$1 AND owner_id=$2 AND device_id IS NOT NULL AND started_at<=$3 AND (ended_at IS NULL OR ended_at>=$4)").bind(req.binding_id).bind(scope.owner).bind(req.starts_at).bind(req.ends_at).fetch_optional(&mut *tx).await?;
    let (vehicle, device) = binding.ok_or(AppError::NotFound)?;
    scope.vehicle(vehicle)?;
    let subject:Option<i64>=sqlx::query_scalar("SELECT a.account_id FROM fleet_staff_accounts a JOIN staff s ON s.id=a.staff_id AND s.user_id=a.owner_id JOIN privacy_account_controls c ON c.user_id=a.account_id WHERE a.owner_id=$1 AND a.staff_id=$2 AND s.active AND NOT c.restricted").bind(scope.owner).bind(req.staff_id).fetch_optional(&mut *tx).await?;
    let subject = subject.ok_or(AppError::NotFound)?;
    match (
        req.replaces_id,
        req.replaces_revision,
        req.change_kind.as_deref(),
    ) {
        (None, None, None) => {}
        (Some(parent), Some(expected), Some(kind @ ("correction" | "reconsent"))) => {
            type Prior = (i64, i64, i64, DateTime<Utc>, DateTime<Utc>, String, i64);
            let prior:Option<Prior>=sqlx::query_as("SELECT subject_id,device_id,binding_id,starts_at,ends_at,status,revision FROM location_subject_mappings WHERE id=$1 AND owner_id=$2 FOR UPDATE")
                .bind(parent).bind(scope.owner).fetch_optional(&mut *tx).await?;
            let (who, did, bid, from, until, status, revision) = prior.ok_or(AppError::NotFound)?;
            let has_child: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM location_subject_mappings WHERE replaces_id=$1)",
            )
            .bind(parent)
            .fetch_one(&mut *tx)
            .await?;
            if expected != revision || did != device || has_child {
                return Err(AppError::Conflict(
                    "원래 연결이 변경됐거나 이미 정정 요청이 있습니다. 새로고침해 주세요.".into(),
                ));
            }
            if kind == "reconsent" {
                if status != "revoked"
                    || (who, bid, from, until)
                        != (subject, req.binding_id, req.starts_at, req.ends_at)
                {
                    return Err(AppError::BadRequest(
                        "재동의는 철회한 본인·차량·기간 그대로 요청해야 합니다.".into(),
                    ));
                }
            } else {
                if !matches!(
                    status.as_str(),
                    "pending" | "confirmed" | "rejected" | "superseded"
                ) {
                    return Err(AppError::Conflict(
                        "철회된 연결은 정정으로 되살릴 수 없습니다. 재동의를 요청하세요.".into(),
                    ));
                }
                sqlx::query("UPDATE location_subject_mappings SET status='superseded',revision=revision+1,decided_at=clock_timestamp() WHERE id=$1").bind(parent).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO location_subject_actions(mapping_id,actor_id,action,revision) VALUES($1,$2,'superseded',$3)").bind(parent).bind(scope.actor).bind(revision+1).execute(&mut *tx).await?;
            }
        }
        _ => {
            return Err(AppError::BadRequest(
                "정정할 연결과 변경 종류를 함께 지정하세요.".into(),
            ))
        }
    }
    let id:i64=sqlx::query_scalar("INSERT INTO location_subject_mappings(request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,starts_at,ends_at,replaces_id,replaces_revision,change_kind) VALUES($1::text::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id")
        .bind(req.request_key.to_string()).bind(scope.owner).bind(subject).bind(scope.actor).bind(req.staff_id).bind(vehicle).bind(req.binding_id).bind(device).bind(req.starts_at).bind(req.ends_at).bind(req.replaces_id).bind(req.replaces_revision).bind(&req.change_kind).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO location_subject_actions(mapping_id,actor_id,action,revision) VALUES($1,$2,'proposed',0)").bind(id).bind(scope.actor).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
#[derive(Deserialize)]
struct Decision {
    revision: i64,
    action: String,
    consent_version: String,
}
async fn decide(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<Decision>,
) -> AppResult<Json<Value>> {
    self_session(&headers, &state, user.user_id)?;
    // Revocation remains available when pilot is disabled.
    if req.action != "revoked" {
        pilot()?;
    }
    let mut tx = state.db.begin().await?;
    fence(&mut tx).await?;
    let row:Option<(String,i64)>=sqlx::query_as("SELECT status,revision FROM location_subject_mappings WHERE id=$1 AND subject_id=$2 FOR UPDATE").bind(id).bind(user.user_id).fetch_optional(&mut *tx).await?;
    let (status, revision) = row.ok_or(AppError::NotFound)?;
    if req.revision != revision {
        return Err(AppError::Conflict(
            "변경된 요청입니다. 새로고침해 주세요.".into(),
        ));
    }
    if req.consent_version != "fleet-subject-v1"
        || !matches!(
            (status.as_str(), req.action.as_str()),
            ("pending", "confirmed" | "rejected") | ("confirmed", "revoked")
        )
    {
        return Err(AppError::BadRequest("허용되지 않는 변경입니다.".into()));
    }
    if req.action == "confirmed" {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM location_subject_mappings m JOIN fleet_vehicle_bindings b ON b.id=m.binding_id AND b.owner_id=m.owner_id AND b.vehicle_id=m.vehicle_id AND b.device_id=m.device_id JOIN fleet_staff_accounts a ON a.owner_id=m.owner_id AND a.staff_id=m.staff_id AND a.account_id=m.subject_id JOIN staff s ON s.id=a.staff_id AND s.active JOIN privacy_account_controls c ON c.user_id=m.owner_id AND NOT c.restricted WHERE m.id=$1 AND b.started_at<=m.starts_at AND (b.ended_at IS NULL OR b.ended_at>=m.ends_at))").bind(id).fetch_one(&mut *tx).await?;
        if !valid {
            return Err(AppError::Conflict(
                "차량 연결 또는 회사 소속이 변경됐습니다. 새 요청이 필요합니다.".into(),
            ));
        }
    }
    let updated=sqlx::query("UPDATE location_subject_mappings SET status=$2,revision=revision+1,decided_at=clock_timestamp() WHERE id=$1").bind(id).bind(&req.action).execute(&mut *tx).await;
    if let Err(e) = updated {
        if e.as_database_error()
            .is_some_and(|e| e.code().as_deref() == Some("23P01"))
        {
            return Err(AppError::Conflict(
                "같은 SIM의 기간이 다른 운전자와 겹칩니다.".into(),
            ));
        }
        return Err(e.into());
    }
    if req.action == "confirmed" {
        let effective: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM location_subject_effective WHERE id=$1)",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if !effective {
            return Err(AppError::Conflict("철회된 기간과 겹치거나 회사 연결이 변경됐습니다. 기존 철회 건의 재동의 요청이 필요합니다.".into()));
        }
    }
    sqlx::query("INSERT INTO location_subject_actions(mapping_id,actor_id,action,revision) VALUES($1,$2,$3,$4)").bind(id).bind(user.user_id).bind(&req.action).bind(revision+1).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"status":req.action,"revision":revision+1})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    before: Option<i64>,
    limit: Option<i64>,
    status: Option<String>,
    read_state: Option<String>,
}
impl Page {
    fn validate(&self, mappings: bool) -> AppResult<i64> {
        // Preserve the old default page sizes for installed/older clients.
        let maximum = if mappings { 200 } else { 100 };
        let limit = self.limit.unwrap_or(maximum);
        if !(1..=maximum).contains(&limit)
            || self.before.is_some_and(|v| v <= 0)
            || self.status.as_deref().is_some_and(|v| {
                !mappings
                    || !matches!(
                        v,
                        "pending" | "confirmed" | "rejected" | "revoked" | "superseded"
                    )
            })
            || self
                .read_state
                .as_deref()
                .is_some_and(|v| mappings || !matches!(v, "unread" | "read"))
        {
            return Err(AppError::BadRequest(
                "본인 내역 조회 조건이 올바르지 않습니다.".into(),
            ));
        }
        Ok(limit)
    }
}
fn page_cursor(rows: &mut Vec<Value>, limit: i64) -> Option<Value> {
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    if more {
        rows.last().map(|row| row["id"].clone())
    } else {
        None
    }
}
#[cfg(test)]
mod personal_page_tests {
    use super::*;
    #[test]
    fn bounded_and_distinct_filters_with_legacy_defaults() {
        let page: Page = serde_json::from_value(json!({})).unwrap();
        assert_eq!(page.validate(true).unwrap(), 200);
        assert_eq!(page.validate(false).unwrap(), 100);
        for (value, mappings) in [
            (json!({"limit":0}), true),
            (json!({"limit":201}), true),
            (json!({"limit":101}), false),
            (json!({"before":0}), true),
            (json!({"before":-1}), false),
            (json!({"status":"invalid"}), true),
            (json!({"status":"confirmed"}), false),
            (json!({"read_state":"all"}), false),
            (json!({"read_state":"unread"}), true),
        ] {
            assert!(serde_json::from_value::<Page>(value)
                .unwrap()
                .validate(mappings)
                .is_err());
        }
        assert!(serde_json::from_value::<Page>(json!({"subject_id":42})).is_err());
        for value in ["pending", "confirmed", "rejected", "revoked", "superseded"] {
            assert_eq!(
                serde_json::from_value::<Page>(json!({"status":value,"limit":50}))
                    .unwrap()
                    .validate(true)
                    .unwrap(),
                50
            );
        }
        for value in ["unread", "read"] {
            assert_eq!(
                serde_json::from_value::<Page>(json!({"read_state":value,"limit":50}))
                    .unwrap()
                    .validate(false)
                    .unwrap(),
                50
            );
        }
    }
    #[test]
    fn next_cursor_requires_a_real_following_row() {
        let mut rows: Vec<Value> = (1..=51).rev().map(|id| json!({"id":id})).collect();
        assert_eq!(page_cursor(&mut rows, 50), Some(json!(2)));
        assert_eq!(rows.len(), 50);
        assert_eq!(page_cursor(&mut rows, 50), None);
        assert_eq!(page_cursor(&mut vec![], 50), None);
    }
}
async fn notices(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> AppResult<Json<Value>> {
    self_session(&headers, &state, user.user_id)?;
    let limit = page.validate(false)?;
    let mut read = crate::services::location_read_budget::ReadQuery::start(&state.db).await?;
    let mut items:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(n)-'lease_id'-'lease_until')||jsonb_build_object('owner_name',COALESCE(NULLIF(c.company_name,''),u.display_name),'vehicle_name',v.name) FROM location_provision_notices n LEFT JOIN corporate_info c ON c.user_id=n.owner_id LEFT JOIN users u ON u.id=n.owner_id LEFT JOIN fleet_vehicles v ON v.id=n.vehicle_id AND v.owner_id=n.owner_id WHERE n.subject_id=$1 AND n.delivery NOT IN ('waiting','not_provided') AND ($2::bigint IS NULL OR n.id<$2) AND ($3::text IS NULL OR ($3='unread' AND n.read_at IS NULL) OR ($3='read' AND n.read_at IS NOT NULL)) ORDER BY n.id DESC LIMIT $4").bind(user.user_id).bind(page.before).bind(page.read_state).bind(limit+1).fetch_all(read.connection()).await.map_err(crate::services::location_read_budget::query_error)?;
    read.finish().await?;
    let next = page_cursor(&mut items, limit);
    Ok(Json(
        json!({"items":items,"next_before":next,"delivery_note":"앱 내 기록, 푸시 서버 접수, 본인 열람은 서로 다른 상태입니다."}),
    ))
}
async fn mark_read(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    self_session(&headers, &state, user.user_id)?;
    let n=sqlx::query("UPDATE location_provision_notices SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1 AND subject_id=$2 AND delivery NOT IN ('waiting','not_provided')").bind(id).bind(user.user_id).execute(&state.db).await?.rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({"ok":true})))
}
async fn retry(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    self_session(&headers, &state, user.user_id)?;
    let mut tx = state.db.begin().await?;
    let n=sqlx::query("UPDATE location_provision_notices SET delivery='pending',attempts=0,available_at=clock_timestamp(),lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND subject_id=$2 AND delivery='review' RETURNING id").bind(id).bind(user.user_id).fetch_optional(&mut *tx).await?;
    if n.is_none() {
        return Err(AppError::Conflict("재시도 대기 상태가 아닙니다.".into()));
    }
    sqlx::query("INSERT INTO location_notice_attempts(notice_id,lease_id,attempt,result) VALUES($1,gen_random_uuid(),0,'subject_retry_requested')").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

async fn company_scope(
    state: &AppState,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<FleetScope> {
    if let Some(Extension(s)) = scope {
        Ok(s)
    } else {
        crate::auth::fleet::load(state, user.user_id, user.user_id).await
    }
}

// Explicitly bounded provision: caller-supplied range cannot widen a confirmed interval.
async fn locations(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    pilot()?;
    let scope = company_scope(&state, user, scope).await?;
    let row:Option<(i64,i64,DateTime<Utc>,DateTime<Utc>)>=sqlx::query_as("SELECT device_id,vehicle_id,starts_at,ends_at FROM location_subject_effective WHERE id=$1 AND owner_id=$2").bind(id).bind(scope.owner).fetch_optional(&state.db).await?;
    let (device, vehicle, from, until) = row.ok_or(AppError::NotFound)?;
    scope.vehicle(vehicle)?;
    use crate::services::access_ledger::{self, Access, Recipient, Target};
    let ticket = match access_ledger::begin(Access {
        at: Utc::now(),
        target: Target::ScopedDevice {
            account: scope.owner,
            device,
        },
        recipient: Recipient::Company(scope.actor),
        path: "api",
        method: "track",
        route: "/corporate/subject-mappings/:id/locations",
        range: Some((from, until)),
    })
    .await
    {
        Ok(ticket) => ticket,
        Err(error) => return Ok(provision_unavailable(error)),
    };
    let result=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(p) FROM location_history_points_between($1,$2,$3,$4) p WHERE p.recorded_at>=$3 AND p.recorded_at<$4 ORDER BY p.recorded_at LIMIT 501").bind(device).bind(scope.owner).bind(from).bind(until).fetch_all(&state.db).await;
    if let Err(error) = ticket
        .finish(if result.as_ref().is_ok_and(|rows| !rows.is_empty()) {
            "response_ready"
        } else {
            "denied"
        })
        .await
    {
        return Ok(provision_unavailable(error));
    }
    let mut rows = result?;
    let more = rows.len() > 500;
    rows.truncate(500);
    Ok(Json(json!({"items":rows,"more":more,"from":from,"until":until})).into_response())
}

fn provision_unavailable(error: anyhow::Error) -> Response {
    let (status, message) = if error.to_string() == "location processing paused" {
        (
            StatusCode::LOCKED,
            "위치정보 이용 또는 제공이 중지되어 있습니다.",
        )
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "연결 동의·차량 배정 또는 처리 기록을 확인할 수 없어 조회를 중단했습니다. 연결 상태를 확인한 후 다시 시도하세요.")
    };
    (status, Json(json!({"error":message}))).into_response()
}
