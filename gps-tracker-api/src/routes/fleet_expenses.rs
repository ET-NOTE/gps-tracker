//! Company expense ledger: snapshots, scoped review, private receipts and one fuel source.
use crate::{
    auth::{
        fleet::{self, FleetScope},
        AuthUser,
    },
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/corporate/expense-categories",
            get(categories).post(create_category),
        )
        .route("/corporate/expense-categories/:id", put(update_category))
        .route("/corporate/expenses", get(list).post(create))
        .route("/corporate/expenses/:id", get(detail).put(update))
        .route("/corporate/expenses/:id/review", post(review))
        .route(
            "/corporate/expenses/:id/receipts",
            post(upload)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
        .route(
            "/corporate/expenses/:id/receipts/:receipt",
            get(download).delete(remove_receipt),
        )
}
async fn principal(
    state: &AppState,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<FleetScope> {
    match scope {
        Some(Extension(s)) => Ok(s),
        None => fleet::load(state, user.user_id, user.user_id).await,
    }
}
pub(super) async fn lock(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-expenses:{owner}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
fn text(v: &str, max: usize, required: bool) -> AppResult<String> {
    let v = v.trim();
    if v.chars().count() > max || (required && v.is_empty()) {
        return Err(AppError::BadRequest(
            "항목·메모의 길이를 확인해 주세요.".into(),
        ));
    }
    Ok(v.to_owned())
}
fn visible(s: &FleetScope, r: &Value) -> bool {
    s.admin()
        || ((r["vehicle_id"].is_null()
            || r["vehicle_id"]
                .as_i64()
                .is_some_and(|id| s.vehicles.contains(&id)))
            && ((s.role == "department_manager"
                && s.department.is_some()
                && r["department_id"].as_i64() == s.department)
                || s.staff.is_some() && r["staff_id"].as_i64() == s.staff))
}
fn editable(s: &FleetScope, r: &Value) -> bool {
    visible(s, r)
        && matches!(r["status"].as_str(), Some("pending" | "rejected"))
        && (s.admin()
            || r["created_by"].as_i64() == Some(s.actor)
            || r["staff_id"].as_i64() == s.staff && s.staff.is_some())
}
fn reviewer(s: &FleetScope, r: &Value) -> bool {
    visible(s, r)
        && s.manager()
        && (s.role == "owner"
            || (r["created_by"].as_i64() != Some(s.actor)
                && (s.staff.is_none() || r["staff_id"].as_i64() != s.staff)))
}
fn view(s: &FleetScope, mut r: Value) -> Value {
    r["can_edit"] = json!(editable(s, &r));
    r["can_review"] = json!(reviewer(s, &r));
    r["can_cancel"] = json!(r["status"] != "cancelled" && (editable(s, &r) || reviewer(s, &r)));
    if let Some(o) = r.as_object_mut() {
        o.remove("request_value");
        o.remove("request_id");
    }
    r
}
async fn row(tx: &mut Transaction<'_, Postgres>, s: &FleetScope, id: i64) -> AppResult<Value> {
    let r: Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM fleet_expenses e WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(s.owner)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if !visible(s, &r) {
        return Err(AppError::NotFound);
    }
    Ok(r)
}
fn version(r: &Value, at: Option<DateTime<Utc>>) -> AppResult<()> {
    if r["updated_at"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        != at
    {
        return Err(AppError::Conflict(
            "내역이 변경되었습니다. 다시 열어 확인해 주세요.".into(),
        ));
    }
    Ok(())
}
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    s: &FleetScope,
    id: i64,
    action: &str,
    before: Value,
    after: Value,
) -> AppResult<()> {
    sqlx::query("INSERT INTO fleet_expense_audit(owner_id,expense_id,actor_id,action,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6)").bind(s.owner).bind(id).bind(s.actor).bind(action).bind(before).bind(after).execute(&mut **tx).await?;
    Ok(())
}

async fn categories(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = principal(&state, user, scope).await?;
    Ok(Json(sqlx::query_scalar("SELECT to_jsonb(c) FROM fleet_expense_categories c WHERE owner_id=$1 ORDER BY parent_id NULLS FIRST,id").bind(s.owner).fetch_all(&state.db).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CategoryInput {
    name: String,
    parent_id: Option<i64>,
    kind: String,
    active: bool,
    updated_at: Option<DateTime<Utc>>,
}
async fn create_category(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<CategoryInput>,
) -> AppResult<Json<Value>> {
    save_category(&state, principal(&state, user, scope).await?, None, p).await
}
async fn update_category(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(p): Json<CategoryInput>,
) -> AppResult<Json<Value>> {
    save_category(&state, principal(&state, user, scope).await?, Some(id), p).await
}
async fn save_category(
    state: &AppState,
    s: FleetScope,
    id: Option<i64>,
    p: CategoryInput,
) -> AppResult<Json<Value>> {
    if !s.admin() {
        return Err(AppError::Forbidden);
    }
    let name = text(&p.name, 80, true)?;
    if !["group", "expense", "fuel"].contains(&p.kind.as_str())
        || (p.kind == "group") != p.parent_id.is_none()
    {
        return Err(AppError::BadRequest(
            "분류와 세부 항목을 확인해 주세요.".into(),
        ));
    }
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let before: Value = if let Some(id) = id {
        sqlx::query_scalar("SELECT to_jsonb(c) FROM fleet_expense_categories c WHERE owner_id=$1 AND id=$2 FOR UPDATE").bind(s.owner).bind(id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?
    } else {
        Value::Null
    };
    if id.is_some() {
        version(&before, p.updated_at)?;
        if before["kind"] != p.kind || before["parent_id"].as_i64() != p.parent_id {
            return Err(AppError::BadRequest(
                "종류와 대분류는 변경할 수 없습니다. 새 항목을 추가해 주세요.".into(),
            ));
        }
    }
    if let Some(parent) = p.parent_id {
        let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_expense_categories WHERE owner_id=$1 AND id=$2 AND kind='group' AND (active OR $3))").bind(s.owner).bind(parent).bind(id.is_some()).fetch_one(&mut *tx).await?;
        if !ok {
            return Err(AppError::BadRequest(
                "사용 중인 대분류를 선택해 주세요.".into(),
            ));
        }
    }
    let duplicate:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_expense_categories WHERE owner_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND ($4::bigint IS NULL OR id<>$4))").bind(s.owner).bind(p.parent_id).bind(&name).bind(id).fetch_one(&mut *tx).await?;
    if duplicate {
        return Err(AppError::Conflict("같은 이름의 항목이 있습니다.".into()));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM fleet_expense_categories WHERE owner_id=$1")
            .bind(s.owner)
            .fetch_one(&mut *tx)
            .await?;
    if id.is_none() && count >= 200 {
        return Err(AppError::BadRequest("항목은 최대 200개입니다.".into()));
    }
    let after: Value = if let Some(id) = id {
        sqlx::query_scalar("UPDATE fleet_expense_categories c SET name=$3,active=$4,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING to_jsonb(c)").bind(s.owner).bind(id).bind(name).bind(p.active).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar("INSERT INTO fleet_expense_categories AS c(owner_id,parent_id,name,kind,active) VALUES($1,$2,$3,$4,$5) RETURNING to_jsonb(c)").bind(s.owner).bind(p.parent_id).bind(name).bind(p.kind).bind(p.active).fetch_one(&mut *tx).await?
    };
    sqlx::query("INSERT INTO fleet_team_audit(owner_id,actor_id,action,target_id,before_value,after_value) VALUES($1,$2,'expense_category',$3,$4,$5)").bind(s.owner).bind(s.actor).bind(after["id"].as_i64()).bind(before).bind(&after).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(after))
}

#[derive(Deserialize, Default)]
struct ListQuery {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    vehicle_id: Option<i64>,
    staff_id: Option<i64>,
    department_id: Option<i64>,
    category_id: Option<i64>,
    status: Option<String>,
}
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let s = principal(&state, user, scope).await?;
    let today = (Utc::now() + Duration::hours(9)).date_naive();
    let from = q.from.unwrap_or(today - Duration::days(30));
    let to = q.to.unwrap_or(today);
    if from > to
        || to - from > Duration::days(366)
        || q.status.as_ref().is_some_and(|v| {
            !["pending", "approved", "rejected", "cancelled"].contains(&v.as_str())
        })
    {
        return Err(AppError::BadRequest(
            "기간(최대 1년)과 상태를 확인해 주세요.".into(),
        ));
    }
    if let Some(v) = q.vehicle_id {
        s.vehicle(v)?;
    }
    if !s.admin() && q.department_id.is_some() && q.department_id != s.department {
        return Err(AppError::NotFound);
    }
    if q.staff_id.is_some_and(|id| !s.staff_ids.contains(&id)) {
        return Err(AppError::NotFound);
    }
    let rows:Vec<Value>=sqlx::query_scalar(r#"SELECT to_jsonb(e)-'request_value'-'request_id'||jsonb_build_object('receipt_count',(SELECT count(*) FROM fleet_expense_receipts r WHERE r.expense_id=e.id AND r.removed_at IS NULL)) FROM fleet_expenses e
 WHERE e.owner_id=$1 AND ($2 OR ((e.vehicle_id IS NULL OR e.vehicle_id=ANY($6)) AND (($3='department_manager' AND e.department_id=$5) OR e.staff_id=$4)))
 AND e.spent_on BETWEEN $7 AND $8 AND ($9::bigint IS NULL OR e.vehicle_id=$9) AND ($10::bigint IS NULL OR e.staff_id=$10)
 AND ($11::bigint IS NULL OR e.department_id=$11) AND ($12::bigint IS NULL OR e.category_id=$12) AND ($13::text IS NULL OR e.status=$13)
 ORDER BY e.spent_on DESC,e.id DESC LIMIT 1001"#).bind(s.owner).bind(s.admin()).bind(&s.role).bind(s.staff).bind(s.department).bind(&s.vehicles).bind(from).bind(to).bind(q.vehicle_id).bind(q.staff_id).bind(q.department_id).bind(q.category_id).bind(q.status).fetch_all(&state.db).await?;
    if rows.len() > 1000 {
        return Err(AppError::BadRequest(
            "조회 결과가 1,000건을 넘습니다. 기간이나 필터를 좁혀 주세요.".into(),
        ));
    }
    Ok(Json(
        json!({"items":rows.into_iter().map(|r|view(&s,r)).collect::<Vec<_>>(),"from":from,"to":to}),
    ))
}
async fn detail(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let s = principal(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    let r = row(&mut tx, &s, id).await?;
    let receipts:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'filename',filename,'mime',mime,'size_bytes',octet_length(content),'created_at',created_at) FROM fleet_expense_receipts WHERE owner_id=$1 AND expense_id=$2 AND removed_at IS NULL ORDER BY id").bind(s.owner).bind(id).fetch_all(&mut *tx).await?;
    let history:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(a) FROM fleet_expense_audit a WHERE owner_id=$1 AND expense_id=$2 ORDER BY id DESC LIMIT 100").bind(s.owner).bind(id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"expense":view(&s,r),"receipts":receipts,"history":history}),
    ))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpenseInput {
    request_id: Option<String>,
    spent_on: NaiveDate,
    category_id: i64,
    staff_id: Option<i64>,
    vehicle_id: Option<i64>,
    amount_krw: i32,
    payment_method: String,
    note: String,
    source_device_id: Option<i64>,
    binding_id: Option<i64>,
    trip_started_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}
async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(p): Json<ExpenseInput>,
) -> AppResult<Json<Value>> {
    save(&state, principal(&state, user, scope).await?, None, p).await
}
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(p): Json<ExpenseInput>,
) -> AppResult<Json<Value>> {
    save(&state, principal(&state, user, scope).await?, Some(id), p).await
}
async fn save(
    state: &AppState,
    s: FleetScope,
    id: Option<i64>,
    p: ExpenseInput,
) -> AppResult<Json<Value>> {
    let note = text(&p.note, 2000, false)?;
    let today = (Utc::now() + Duration::hours(9)).date_naive();
    if !(1..=1_000_000_000).contains(&p.amount_krw)
        || p.spent_on < NaiveDate::from_ymd_opt(2000, 1, 1).unwrap()
        || p.spent_on > today + Duration::days(366)
        || !["company_card", "personal_card", "cash", "transfer", "other"]
            .contains(&p.payment_method.as_str())
    {
        return Err(AppError::BadRequest(
            "지출일·금액·결제수단을 확인해 주세요.".into(),
        ));
    }
    if p.trip_started_at.is_some()
        != (p.source_device_id.is_some() && p.binding_id.is_some() && p.vehicle_id.is_some())
        || p.trip_started_at.is_none() && (p.source_device_id.is_some() || p.binding_id.is_some())
    {
        return Err(AppError::BadRequest(
            "연결할 운행을 다시 선택해 주세요.".into(),
        ));
    }
    let request = serde_json::to_value(&p).map_err(|e| AppError::Internal(e.into()))?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let before = if let Some(id) = id {
        let r = row(&mut tx, &s, id).await?;
        if !editable(&s, &r) {
            return Err(AppError::Forbidden);
        }
        version(&r, p.updated_at)?;
        if r["source_device_id"].as_i64() != p.source_device_id
            || r["binding_id"].as_i64() != p.binding_id
            || r["trip_started_at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc))
                != p.trip_started_at
            || p.trip_started_at.is_some() && r["vehicle_id"].as_i64() != p.vehicle_id
        {
            return Err(AppError::BadRequest(
                "연결 운행 변경은 기존 지출을 취소한 뒤 등록해 주세요.".into(),
            ));
        }
        r
    } else {
        let key = p
            .request_id
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("등록 번호가 필요합니다.".into()))?;
        if key.len() != 36
            || !key.chars().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == '-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        {
            return Err(AppError::BadRequest("잘못된 등록 번호입니다.".into()));
        }
        let prior:Option<Value>=sqlx::query_scalar("SELECT to_jsonb(e) FROM fleet_expenses e WHERE owner_id=$1 AND created_by=$2 AND request_id=$3::text::uuid").bind(s.owner).bind(s.actor).bind(key).fetch_optional(&mut *tx).await?;
        if let Some(r) = prior {
            if !visible(&s, &r) {
                return Err(AppError::NotFound);
            }
            if r["request_value"] != request {
                return Err(AppError::Conflict(
                    "이미 사용한 등록 번호입니다. 새로 열어 주세요.".into(),
                ));
            }
            return Ok(Json(view(&s, r)));
        }
        Value::Null
    };
    let retained = id.is_some() && before["category_id"].as_i64() == Some(p.category_id);
    let cat:Value=sqlx::query_scalar("SELECT to_jsonb(c)||jsonb_build_object('group_name',g.name,'group_active',g.active) FROM fleet_expense_categories c JOIN fleet_expense_categories g ON g.id=c.parent_id AND g.owner_id=c.owner_id WHERE c.owner_id=$1 AND c.id=$2 AND c.kind<>'group'").bind(s.owner).bind(p.category_id).fetch_optional(&mut *tx).await?.ok_or_else(||AppError::BadRequest("지출 항목을 선택해 주세요.".into()))?;
    if !retained && (cat["active"] != true || cat["group_active"] != true) {
        return Err(AppError::BadRequest("사용 중지된 항목입니다.".into()));
    }
    let category_name = if retained {
        before["category_name"].as_str().unwrap()
    } else {
        cat["name"].as_str().unwrap()
    };
    let group_name = if retained {
        before["group_name"].as_str().unwrap()
    } else {
        cat["group_name"].as_str().unwrap()
    };
    let kind = cat["kind"].as_str().unwrap();
    if !s.manager() && (p.staff_id.is_none() || p.staff_id != s.staff) {
        return Err(AppError::Forbidden);
    }
    if p.staff_id.is_some_and(|id| !s.staff_ids.contains(&id)) {
        return Err(AppError::Forbidden);
    }
    let staff_retained = id.is_some() && p.staff_id == before["staff_id"].as_i64();
    let staff: Value = if let Some(staff) = p.staff_id {
        sqlx::query_scalar("SELECT jsonb_build_object('name',s.name,'department_id',s.department_id,'department_name',COALESCE(d.name,'')) FROM staff s LEFT JOIN fleet_org_items d ON d.id=s.department_id WHERE s.user_id=$1 AND s.id=$2 AND (s.active OR $3)").bind(s.owner).bind(staff).bind(staff_retained).fetch_optional(&mut *tx).await?.ok_or_else(||AppError::BadRequest("사용자를 확인해 주세요.".into()))?
    } else {
        if !s.admin() {
            return Err(AppError::Forbidden);
        }
        json!({"name":"미지정","department_name":"","department_id":null})
    };
    let staff_name = if staff_retained {
        before["staff_name"].as_str().unwrap()
    } else {
        staff["name"].as_str().unwrap()
    };
    let department = if staff_retained {
        &before["department_id"]
    } else {
        &staff["department_id"]
    };
    let department_name = if staff_retained {
        before["department_name"].as_str().unwrap()
    } else {
        staff["department_name"].as_str().unwrap()
    };
    let vehicle_retained = id.is_some() && p.vehicle_id == before["vehicle_id"].as_i64();
    let vehicle_name = if let Some(v) = p.vehicle_id {
        s.vehicle(v)?;
        let n:String=sqlx::query_scalar("SELECT concat_ws(' · ',nullif(name,''),nullif(license_plate,'')) FROM fleet_vehicles WHERE owner_id=$1 AND id=$2 AND (enabled OR $3)").bind(s.owner).bind(v).bind(vehicle_retained).fetch_optional(&mut *tx).await?.ok_or_else(||AppError::BadRequest("사용 가능한 차량을 선택해 주세요.".into()))?;
        if vehicle_retained {
            before["vehicle_name"].as_str().unwrap().to_owned()
        } else {
            n
        }
    } else {
        "일반 지출".into()
    };
    if let Some(start) = p.trip_started_at {
        if kind != "fuel" {
            return Err(AppError::BadRequest(
                "운행 주유비는 유류비 항목으로 연결해 주세요.".into(),
            ));
        }
        if id.is_none() {
            let trips = super::fleet_vehicles::allocated_trips(
                state,
                s.owner,
                p.vehicle_id.unwrap(),
                start - Duration::hours(1),
                start + Duration::days(2),
            )
            .await?;
            let found = trips.iter().find(|t| {
                t["source_device_id"].as_i64() == p.source_device_id
                    && t["binding_id"].as_i64() == p.binding_id
                    && t["source_started_at"]
                        .as_str()
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.with_timezone(&Utc))
                        == Some(start)
                    && t["allocation_status"] == "assigned"
                    && !t["ended_at"].is_null()
            });
            if found.is_none() {
                return Err(AppError::BadRequest(
                    "종료된 운행과 차량 배정 구간을 확인해 주세요.".into(),
                ));
            }
            let existing:Option<Value>=sqlx::query_scalar("SELECT to_jsonb(a) FROM trip_annotations a WHERE user_id=$1 AND device_id=$2 AND trip_started_at=$3 FOR UPDATE").bind(s.owner).bind(p.source_device_id).bind(start).fetch_optional(&mut *tx).await?;
            if let Some(a) = existing {
                if !s.manager()
                    && a["driver_staff_id"]
                        .as_i64()
                        .is_some_and(|driver| Some(driver) != s.staff)
                {
                    return Err(AppError::Forbidden);
                }
                if !a["fuel_expense_id"].is_null() {
                    return Err(AppError::Conflict(
                        "이미 지출에 연결된 주유비입니다.".into(),
                    ));
                }
                if a["fuel_cost"]
                    .as_i64()
                    .is_some_and(|v| v != i64::from(p.amount_krw))
                {
                    return Err(AppError::Conflict(
                        "기존 운행 주유비와 같은 금액으로 연결한 뒤 지출에서 수정해 주세요.".into(),
                    ));
                }
            }
        }
    }
    let after: Value = if let Some(id) = id {
        sqlx::query_scalar("UPDATE fleet_expenses e SET spent_on=$3,category_id=$4,category_name=$5,group_name=$6,category_kind=$7,staff_id=$8,staff_name=$9,department_id=$10,department_name=$11,vehicle_id=$12,vehicle_name=$13,amount_krw=$14,payment_method=$15,note=$16,status='pending',reviewed_by=NULL,reviewed_at=NULL,review_note='',updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING to_jsonb(e)").bind(s.owner).bind(id).bind(p.spent_on).bind(p.category_id).bind(category_name).bind(group_name).bind(kind).bind(p.staff_id).bind(staff_name).bind(department.as_i64()).bind(department_name).bind(p.vehicle_id).bind(vehicle_name).bind(p.amount_krw).bind(p.payment_method).bind(note).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar("INSERT INTO fleet_expenses AS e(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_id,department_name,vehicle_id,vehicle_name,amount_krw,payment_method,note,source_device_id,binding_id,trip_started_at) VALUES($1,$2,$3::text::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING to_jsonb(e)").bind(s.owner).bind(s.actor).bind(&p.request_id).bind(request).bind(p.spent_on).bind(p.category_id).bind(category_name).bind(group_name).bind(kind).bind(p.staff_id).bind(staff_name).bind(department.as_i64()).bind(department_name).bind(p.vehicle_id).bind(vehicle_name).bind(p.amount_krw).bind(p.payment_method).bind(note).bind(p.source_device_id).bind(p.binding_id).bind(p.trip_started_at).fetch_one(&mut *tx).await?
    };
    let eid = after["id"].as_i64().unwrap();
    if let Some(start) = p.trip_started_at {
        sqlx::query("INSERT INTO trip_annotations(device_id,user_id,trip_started_at,purpose,fuel_expense_id) VALUES($1,$2,$3,'unspecified',$4) ON CONFLICT(device_id,user_id,trip_started_at) DO UPDATE SET fuel_cost=NULL,fuel_expense_id=$4,updated_at=clock_timestamp()").bind(p.source_device_id).bind(s.owner).bind(start).bind(eid).execute(&mut *tx).await?;
    }
    audit(
        &mut tx,
        &s,
        eid,
        if id.is_some() { "updated" } else { "created" },
        view(&s, before),
        view(&s, after.clone()),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(view(&s, after)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewInput {
    status: String,
    note: String,
    updated_at: DateTime<Utc>,
}
async fn review(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    Json(p): Json<ReviewInput>,
) -> AppResult<Json<Value>> {
    let s = principal(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let before = row(&mut tx, &s, id).await?;
    version(&before, Some(p.updated_at))?;
    if !["approved", "rejected", "cancelled"].contains(&p.status.as_str()) {
        return Err(AppError::BadRequest("처리 상태를 확인해 주세요.".into()));
    }
    let allowed = if p.status == "cancelled" {
        before["status"] != "cancelled" && (editable(&s, &before) || reviewer(&s, &before))
    } else {
        before["status"] == "pending" && reviewer(&s, &before)
    };
    if !allowed {
        return Err(AppError::Forbidden);
    }
    let note = text(&p.note, 500, p.status != "approved")?;
    let after:Value=sqlx::query_scalar("UPDATE fleet_expenses e SET status=$3,review_note=$4,reviewed_by=$5,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 RETURNING to_jsonb(e)").bind(s.owner).bind(id).bind(&p.status).bind(note).bind(s.actor).fetch_one(&mut *tx).await?;
    if p.status == "cancelled" {
        sqlx::query("UPDATE trip_annotations SET fuel_expense_id=NULL,fuel_cost=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND fuel_expense_id=$2").bind(s.owner).bind(id).execute(&mut *tx).await?;
    }
    audit(
        &mut tx,
        &s,
        id,
        &p.status,
        view(&s, before),
        view(&s, after.clone()),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(view(&s, after)))
}

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
async fn upload(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path(id): Path<i64>,
    mut mp: Multipart,
) -> AppResult<Json<Value>> {
    let s = principal(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let r = row(&mut tx, &s, id).await?;
    if !editable(&s, &r) {
        return Err(AppError::Forbidden);
    }
    let f = mp
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest("파일을 읽지 못했습니다.".into()))?
        .ok_or_else(|| AppError::BadRequest("영수증을 선택해 주세요.".into()))?;
    if f.name() != Some("file") {
        return Err(AppError::BadRequest("파일 항목을 확인해 주세요.".into()));
    }
    let name = f
        .file_name()
        .unwrap_or("receipt")
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\')
        .take(120)
        .collect::<String>();
    let data = f
        .bytes()
        .await
        .map_err(|_| AppError::BadRequest("영수증은 5MB 이하로 올려 주세요.".into()))?;
    if data.is_empty()
        || data.len() > 5 * 1024 * 1024
        || mp
            .next_field()
            .await
            .map_err(|_| AppError::BadRequest("파일을 확인해 주세요.".into()))?
            .is_some()
    {
        return Err(AppError::BadRequest(
            "영수증 한 개씩, 5MB 이하로 올려 주세요.".into(),
        ));
    }
    let mime = mime(&data)
        .ok_or_else(|| AppError::BadRequest("PDF·JPG·PNG·WebP 파일만 가능합니다.".into()))?;
    let digest = format!("{:x}", Sha256::digest(&data));
    let duplicate:Option<i64>=sqlx::query_scalar("SELECT id FROM fleet_expense_receipts WHERE expense_id=$1 AND digest=$2 AND removed_at IS NULL").bind(id).bind(&digest).fetch_optional(&mut *tx).await?;
    if let Some(id) = duplicate {
        return Ok(Json(json!({"id":id})));
    }
    let (active,total):(i64,i64)=sqlx::query_as("SELECT count(*) FILTER(WHERE removed_at IS NULL),count(*) FROM fleet_expense_receipts WHERE expense_id=$1").bind(id).fetch_one(&mut *tx).await?;
    if active >= 5 || total >= 20 {
        return Err(AppError::BadRequest(
            "영수증은 5개까지, 교체 이력은 20개까지 보관합니다.".into(),
        ));
    }
    let rid:i64=sqlx::query_scalar("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES($1,$2,$3,$4,$5,$6) RETURNING id").bind(s.owner).bind(id).bind(&name).bind(mime).bind(data.as_ref()).bind(digest).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE fleet_expenses SET updated_at=clock_timestamp() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        &s,
        id,
        "receipt_added",
        Value::Null,
        json!({"id":rid,"filename":name}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":rid})))
}
async fn download(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path((id, rid)): Path<(i64, i64)>,
) -> AppResult<Response> {
    let s = principal(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    row(&mut tx, &s, id).await?;
    let (data,mime):(Vec<u8>,String)=sqlx::query_as("SELECT content,mime FROM fleet_expense_receipts WHERE owner_id=$1 AND expense_id=$2 AND id=$3 AND removed_at IS NULL").bind(s.owner).bind(id).bind(rid).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    tx.commit().await?;
    let ext = match mime.as_str() {
        "application/pdf" => "pdf",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        _ => "webp",
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"receipt-{rid}.{ext}\""),
            ),
            (header::CACHE_CONTROL, "private, no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
            (
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'".into(),
            ),
        ],
        data,
    )
        .into_response())
}
async fn remove_receipt(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Path((id, rid)): Path<(i64, i64)>,
) -> AppResult<Json<Value>> {
    let s = principal(&state, user, scope).await?;
    let mut tx = state.db.begin().await?;
    lock(&mut tx, s.owner).await?;
    let r = row(&mut tx, &s, id).await?;
    if !editable(&s, &r) {
        return Err(AppError::Forbidden);
    }
    let n=sqlx::query("UPDATE fleet_expense_receipts SET removed_at=clock_timestamp() WHERE owner_id=$1 AND expense_id=$2 AND id=$3 AND removed_at IS NULL").bind(s.owner).bind(id).bind(rid).execute(&mut *tx).await?.rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    sqlx::query("UPDATE fleet_expenses SET updated_at=clock_timestamp() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        &s,
        id,
        "receipt_removed",
        json!({"id":rid}),
        Value::Null,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_type_from_bytes_not_extension() {
        assert_eq!(mime(b"<html>fake.pdf"), None);
        assert_eq!(mime(b"%PDF-1.7"), Some("application/pdf"));
        assert_eq!(mime(b"RIFF1234WEBP"), Some("image/webp"));
    }
    #[test]
    fn review_does_not_allow_self_approval_except_owner() {
        let mut s = FleetScope {
            owner: 1,
            actor: 2,
            staff: Some(8),
            role: "admin".into(),
            department: Some(3),
            vehicles: vec![5],
            staff_ids: vec![8],
        };
        let r = json!({"created_by":2,"staff_id":8,"vehicle_id":5,"status":"pending"});
        assert!(!reviewer(&s, &r));
        assert!(editable(&s, &r));
        s.role = "owner".into();
        assert!(reviewer(&s, &r));
        s.role = "member".into();
        s.vehicles.clear();
        assert!(!visible(&s, &r));
    }
}
