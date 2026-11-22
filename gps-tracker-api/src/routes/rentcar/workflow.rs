use super::*;
use crate::routes::rentcar_office::RentalOwner;
use sqlx::{PgConnection, Postgres, Transaction};

#[derive(Serialize, Deserialize, FromRow)]
pub struct Policy {
    buffer_minutes: i32,
    require_license: bool,
    require_contract: bool,
    require_payment: bool,
    late_hourly: Option<i32>,
    notify_return: bool,
}

async fn policy(db: &mut PgConnection, owner: i64) -> AppResult<Policy> {
    let row = sqlx::query_as("SELECT buffer_minutes,require_license,require_contract,require_payment,late_hourly,notify_return
        FROM rental_operating_policies WHERE user_id=$1")
        .bind(owner).fetch_optional(db).await?;
    Ok(row.unwrap_or(Policy { buffer_minutes: 0, require_license: false, require_contract: false,
        require_payment: false, late_hourly: None, notify_return: true }))
}

async fn get_policy(State(s): State<AppState>, u: RentalOwner) -> AppResult<Json<Policy>> {
    Ok(Json(policy(&mut *s.db.acquire().await?, u.user_id).await?))
}

async fn save_policy(State(s): State<AppState>, u: RentalOwner, Json(p): Json<Policy>) -> AppResult<Json<Policy>> {
    if !(0..=1440).contains(&p.buffer_minutes) || p.late_hourly.is_some_and(|v| !(0..=10_000_000).contains(&v)) {
        return Err(AppError::BadRequest("준비 시간 또는 지연 요금 범위를 확인해 주세요.".into()));
    }
    sqlx::query("INSERT INTO rental_operating_policies(user_id,buffer_minutes,require_license,require_contract,require_payment,late_hourly,notify_return)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET buffer_minutes=EXCLUDED.buffer_minutes,
        require_license=EXCLUDED.require_license,require_contract=EXCLUDED.require_contract,require_payment=EXCLUDED.require_payment,
        late_hourly=EXCLUDED.late_hourly,notify_return=EXCLUDED.notify_return")
        .bind(u.user_id).bind(p.buffer_minutes).bind(p.require_license).bind(p.require_contract)
        .bind(p.require_payment).bind(p.late_hourly).bind(p.notify_return).execute(&s.db).await?;
    Ok(Json(p))
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/rentcar/operating-policy", get(get_policy).put(save_policy))
        .route("/rentcar/contracts/:id/review", post(review))
        .route("/rentcar/contracts/:id/checkout", post(checkout))
        .route("/rentcar/contracts/:id/cancel", post(cancel))
        .route("/rentcar/contracts/:id/balance", get(balance))
        .route("/rentcar/contracts/:id/history", get(history))
        .route("/rentcar/contracts/:id/extend", post(pricing::extend))
        .route("/rentcar/contracts/:id/settle", post(pricing::settle))
}

async fn history(
    State(s): State<AppState>, user: AuthUser, Path(id): Path<i64>,
    scope: Option<axum::Extension<crate::auth::fleet::FleetScope>>,
) -> AppResult<Json<Value>> {
    if scope.is_some() { return Err(AppError::Forbidden); }
    let entries = sqlx::query_scalar(include_str!("contract_history.sql"))
        .bind(user.user_id).bind(id).fetch_optional(&s.db).await?.ok_or(AppError::NotFound)?;
    Ok(Json(entries))
}

#[derive(Deserialize)]
struct Cancellation {
    outcome: String,
    reason: String,
    fee_krw: i64,
    request_key: uuid::Uuid,
}

async fn cancel(
    State(s): State<AppState>, u: RentalOwner, Path(id): Path<i64>, Json(input): Json<Cancellation>,
) -> AppResult<Json<Contract>> {
    let reason = input.reason.trim();
    if !matches!(input.outcome.as_str(),"cancelled"|"no_show") || !(1..=500).contains(&reason.chars().count())
        || !(0..=1_000_000_000).contains(&input.fee_krw) {
        return Err(AppError::BadRequest("처리 구분, 사유(1~500자)와 취소 수수료를 확인해 주세요.".into()));
    }
    let mut tx = s.db.begin().await?;
    owner_lock(&mut tx,u.user_id).await?;
    let row = lock_contract(&mut tx,u.user_id,id).await?;
    let request_key = input.request_key.to_string();
    let previous: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM rental_contracts WHERE user_id=$1 AND cancellation_request_key=$2::text::uuid")
        .bind(u.user_id).bind(&request_key).fetch_optional(&mut *tx).await?;
    if let Some(previous) = previous {
        let terms = row.rental_terms.as_ref();
        if previous==id && row.status=="cancelled" &&
            terms.is_some_and(|t|t["cancel_outcome"]==input.outcome && t["cancel_reason"]==reason &&
                t["cancellation_fee_krw"]==input.fee_krw) {
            tx.commit().await?;
            return Ok(Json(row));
        }
        return Err(AppError::Conflict("이미 처리에 사용된 요청 키입니다.".into()));
    }
    if row.status!="draft" {
        return Err(AppError::Conflict("인도 전 예약만 취소 또는 미방문 처리할 수 있습니다.".into()));
    }
    let decision = json!({"cancel_outcome":input.outcome,"cancel_reason":reason,
        "cancellation_fee_krw":input.fee_krw,"cancelled_at":Utc::now()});
    sqlx::query("UPDATE rental_contracts SET status='cancelled', cancellation_request_key=$3::text::uuid,
        rental_terms=COALESCE(rental_terms,'{}'::jsonb) || $4,updated_at=now() WHERE id=$1 AND user_id=$2")
        .bind(id).bind(u.user_id).bind(request_key).bind(decision).execute(&mut *tx).await?;
    let saved = lock_contract(&mut tx,u.user_id,id).await?;
    tx.commit().await?;
    Ok(Json(saved))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BookingTerms {
    pricing: Option<pricing::PriceInput>,
    customer_id: Option<i64>,
    driver_id: Option<i64>,
    requested_model: String,
    driver_name: String,
    channel: String,
}

pub(super) fn require_agreed_booking(req: &ContractPayload) -> AppResult<()> {
    if req.rental_terms.as_ref().and_then(|terms|terms.pricing.as_ref()).is_none() {
        return Err(AppError::Conflict("새 계약은 기본 대여료·옵션·할인을 확인한 약정 방식으로 등록합니다. 화면을 새로고침하고 새 예약 양식을 열어 주세요.".into()));
    }
    Ok(())
}

pub(super) async fn owner_lock(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("rental-owner:{owner}")).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn lock_contract(tx: &mut Transaction<'_, Postgres>, owner: i64, id: i64) -> AppResult<Contract> {
    let sql = format!("{SQL_INVOICE_SELECT} FOR UPDATE OF c");
    sqlx::query_as(&sql).bind(id).bind(owner).fetch_optional(&mut **tx).await?.ok_or(AppError::NotFound)
}

// Reserve an actual inventory slot even when the operator has deferred choosing a plate.
async fn check_capacity(tx: &mut Transaction<'_, Postgres>, owner: i64, id: Option<i64>,
    model: &str, start: DateTime<Utc>, end: DateTime<Utc>, buffer: i32, branch: Option<&str>) -> AppResult<()> {
    let available: i64 = sqlx::query_scalar("SELECT
      (SELECT count(*) FROM rental_asset_directory p WHERE p.owner_id=$1 AND p.enabled AND p.readiness='ready'
        AND COALESCE(NULLIF(trim(p.class_name),''),NULLIF(trim(p.model),''),'차종 미지정')=$2
        AND ($7::text IS NULL OR NULLIF(trim(p.branch),'')=$7 OR NOT EXISTS(SELECT 1 FROM rental_vehicle_profile v WHERE v.owner_id=$1 AND NULLIF(trim(v.branch),'') IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM rental_contracts c WHERE c.vehicle_id=p.vehicle_id
          AND (c.status IN ('active','overdue') OR (c.status='draft' AND c.rental_terms IS NOT NULL))
          AND ($3::bigint IS NULL OR c.id<>$3) AND ((c.status IN ('overdue','active') AND c.ends_at<=now()) OR
          (c.starts_at<$5::timestamptz+make_interval(mins=>$6) AND c.ends_at+make_interval(mins=>$6)>$4::timestamptz)))
        AND NOT EXISTS(SELECT 1 FROM rental_fleet_work w WHERE w.owner_id=$1 AND w.vehicle_id=p.vehicle_id AND
          ((w.kind IN ('accident','breakdown') AND w.inspection_released_at IS NULL) OR
          (w.return_inspection AND w.closed_at IS NULL) OR (w.ends_at IS NOT NULL AND w.closed_at IS NULL AND w.starts_at<$5::timestamptz+make_interval(mins=>$6) AND w.ends_at>$4))))
      - (SELECT count(*) FROM rental_contracts c WHERE c.user_id=$1 AND c.status='draft' AND c.vehicle_id IS NULL
        AND c.rental_terms->>'requested_model'=$2 AND ($7::text IS NULL OR c.pickup_location=$7 OR NOT EXISTS(SELECT 1 FROM rental_vehicle_profile v WHERE v.owner_id=$1 AND NULLIF(trim(v.branch),'') IS NOT NULL)) AND ($3::bigint IS NULL OR c.id<>$3)
        AND c.starts_at<$5::timestamptz+make_interval(mins=>$6) AND c.ends_at+make_interval(mins=>$6)>$4::timestamptz)")
        .bind(owner).bind(model).bind(id).bind(start).bind(end).bind(buffer).bind(branch).fetch_one(&mut **tx).await?;
    if available < 1 { return Err(AppError::Conflict("해당 기간에 예약할 수 있는 차종 재고가 없습니다.".into())); }
    Ok(())
}

pub(super) async fn prepare_booking(tx: &mut Transaction<'_, Postgres>, owner: i64, req: &ContractPayload,
    id: Option<i64>, status: &str) -> AppResult<Option<Value>> {
    prepare_booking_operation(tx,owner,req,id,status,false).await
}

pub(super) async fn prepare_booking_operation(tx: &mut Transaction<'_, Postgres>, owner: i64,
    req: &ContractPayload,id: Option<i64>, status: &str, extension: bool) -> AppResult<Option<Value>> {
    owner_lock(tx, owner).await?;
    let current = if let Some(id) = id { Some(lock_contract(tx, owner, id).await?) } else { None };
    let old_terms = current.as_ref().and_then(|c| c.rental_terms.as_ref());
    let modern = old_terms.is_some() || req.rental_terms.is_some();
    if modern {
        let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND gps_owner_service(users,'rentcar'))").bind(owner).fetch_one(&mut **tx).await?;
        if !allowed {return Err(AppError::Forbidden);}
    }
    if !modern && req.vehicle_id.is_none() { return Err(AppError::BadRequest("차량을 선택해 주세요.".into())); }
    if let Some(current) = &current {
        if pricing::agreed(old_terms) && !extension && current.status=="draft" && req.ends_at!=current.ends_at {
            let extended:bool=sqlx::query_scalar("SELECT EXISTS(SELECT FROM rental_agreement_extensions WHERE contract_id=$1)")
                .bind(current.id).fetch_one(&mut **tx).await?;
            if extended {return Err(AppError::Conflict("연장 기록이 있는 예약의 종료 시각은 기간 연장에서 변경해 주세요.".into()));}
        }
        if pricing::agreed(old_terms) && matches!(current.status.as_str(),"active"|"overdue") && !extension {
            return Err(AppError::Conflict("약정 계약은 기간 연장 메뉴를 사용해 주세요.".into()));
        }
        if modern && (matches!(current.status.as_str(), "cancelled"|"returned")
           || (current.status != status && !(current.status == "draft" && status == "cancelled"))) {
            return Err(AppError::Conflict("현재 계약 단계에서 사용할 수 없는 변경입니다.".into()));
        }
        if modern && matches!(current.status.as_str(), "active"|"overdue") &&
            req.ends_at<=current.ends_at { return Err(AppError::BadRequest("현재 반납 예정 시각보다 늦게 선택해 주세요.".into())); }
        if modern && matches!(current.status.as_str(), "active"|"overdue") &&
            (current.vehicle_id != req.vehicle_id || current.starts_at != req.starts_at ||
             current.rate_amount_krw != req.rate_amount_krw.unwrap_or(0) || current.rate_type != req.rate_type.as_deref().unwrap_or("daily")
             || current.deposit_krw != req.deposit_krw.unwrap_or(0) || current.renter_name != req.renter_name.trim()
             || current.pickup_odometer_km != req.pickup_odometer_km) {
            return Err(AppError::Conflict("출고한 계약은 대여 기간 연장만 가능합니다.".into()));
        }
    } else if modern && status != "draft" { return Err(AppError::BadRequest("예약 접수부터 시작해 주세요.".into())); }

    if modern && id.is_none() && req.renter_phone.is_some() {
        let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM renter_blacklist WHERE user_id=$1 AND renter_phone=$2 AND severity='block')").bind(owner).bind(req.renter_phone.as_deref()).fetch_one(&mut **tx).await?;
        if blocked {return Err(AppError::Conflict("차단 등록된 임차인입니다.".into()));}
    }
    let mut terms = old_terms.cloned().unwrap_or_else(|| json!({}));
    if let Some(fields) = &req.rental_terms {
        for v in [&fields.requested_model, &fields.driver_name, &fields.channel] {
            if v.trim().is_empty() || v.chars().count()>100 { return Err(AppError::BadRequest("차종·운전자·예약 경로를 확인해 주세요.".into())); }
        }
        if old_terms.is_none() || current.as_ref().is_some_and(|c| c.status=="draft") {
            for (key,selected) in [("customer_id",fields.customer_id),("driver_id",fields.driver_id)] {
                if let Some(v)=selected {
                    if terms[key].as_i64()!=Some(v) {
                        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rental_office_catalog WHERE id=$1 AND user_id=$2 AND kind='customers' AND active)")
                            .bind(v).bind(owner).fetch_one(&mut **tx).await?;
                        if !valid {return Err(AppError::BadRequest("선택한 고객을 확인해 주세요.".into()));}
                    }
                }
                terms[key]=json!(selected);
            }
            let driver = fields.driver_name.trim();
            terms["driver_name"] = json!(driver);
            terms["requested_model"] = json!(fields.requested_model.trim());
            terms["channel"] = json!(fields.channel.trim());
        }
    }
    pricing::apply_price(&mut terms,current.as_ref(),req.rental_terms.as_ref().and_then(|t|t.pricing.as_ref()))?;
    if modern && (req.renter_name.trim().is_empty() || req.renter_name.chars().count()>100 ||
       !(0..=1_000_000_000).contains(&req.rate_amount_krw.unwrap_or(0)) || !(0..=1_000_000_000).contains(&req.deposit_krw.unwrap_or(0)) || !(0..=1_000_000).contains(&req.included_km_per_day.unwrap_or(0)) || !(0..=1_000_000).contains(&req.over_km_price_krw.unwrap_or(0)) || (req.ends_at-req.starts_at)>chrono::Duration::days(3650) || req.pickup_odometer_km.is_some_and(|v| v<0)) {
        return Err(AppError::BadRequest("고객명·금액·계기판 값을 확인해 주세요.".into()));
    }
    if modern && status=="draft" {
        let p = policy(tx,owner).await?;
        if old_terms.is_none() { terms["late_hourly"] = json!(p.late_hourly); }
        if let Some(d)=req.vehicle_id {
            let model: Option<String> = sqlx::query_scalar("SELECT COALESCE(NULLIF(trim(p.class_name),''),NULLIF(trim(p.model),''),'차종 미지정')
                FROM rental_asset_directory p WHERE p.owner_id=$1 AND p.vehicle_id=$2 AND p.enabled AND p.readiness='ready'
                AND ($3::text IS NULL OR NULLIF(trim(p.branch),'')=$3 OR NOT EXISTS(SELECT 1 FROM rental_vehicle_profile v WHERE v.owner_id=$1 AND NULLIF(trim(v.branch),'') IS NOT NULL))")
                .bind(owner).bind(d).bind(req.pickup_location.as_deref()).fetch_optional(&mut **tx).await?;
            if model.as_deref() != terms["requested_model"].as_str() { return Err(AppError::BadRequest("선택한 차종의 사용 가능한 차량을 배정해 주세요.".into())); }
        }
        check_capacity(tx,owner,id,terms["requested_model"].as_str().unwrap_or(""),req.starts_at,req.ends_at,p.buffer_minutes,req.pickup_location.as_deref()).await?;
        if let Some(c)=&current {
            let identity_changed = c.renter_name != req.renter_name.trim() || c.renter_phone != req.renter_phone ||
                c.renter_id_last4 != req.renter_id_last4 || ["customer_id","driver_id","driver_name"].iter().any(|key|
                    old_terms.and_then(|t|t.get(*key)).unwrap_or(&Value::Null) != &terms[*key]);
            if identity_changed { terms["license_checked"] = json!(false); }
            if identity_changed || c.starts_at!=req.starts_at || c.ends_at!=req.ends_at || c.vehicle_id!=req.vehicle_id ||
                c.rate_type!=req.rate_type.as_deref().unwrap_or("daily") ||
                c.rate_amount_krw!=req.rate_amount_krw.unwrap_or(0) || c.deposit_krw!=req.deposit_krw.unwrap_or(0)
                || c.pickup_location!=req.pickup_location || c.return_location!=req.return_location ||
                c.included_km_per_day!=req.included_km_per_day || c.over_km_price_krw!=req.over_km_price_krw ||
                old_terms.and_then(|v| v["requested_model"].as_str())!=terms["requested_model"].as_str() {
                terms["confirmed_at"]=Value::Null;
            }
        }
    }
    if modern && matches!(status,"active"|"overdue") {
        if let Some(c)=&current {
            // The additional interval also consumes inventory promised to unassigned reservations.
            let p=policy(tx,owner).await?;
            check_capacity(tx,owner,id,terms["requested_model"].as_str().unwrap_or(""),c.ends_at,
                req.ends_at,p.buffer_minutes,req.pickup_location.as_deref()).await?;
        }
    }
    if let Some(d)=req.vehicle_id {
        if matches!(status,"active"|"overdue") || (modern && status=="draft") {
            lock_device_rental(tx,d).await?;
            check_contract_overlap(tx,owner,d,req.starts_at,req.ends_at,id).await?;
        }
    }
    Ok(modern.then_some(terms))
}

#[derive(Deserialize)]
struct Review { license_checked: bool, contract_confirmed: bool, template_body: Option<String>, template_id: Option<i64> }

async fn review(State(s): State<AppState>, u: RentalOwner, Path(id): Path<i64>, Json(input): Json<Review>) -> AppResult<Json<Value>> {
    let mut tx=s.db.begin().await?;
    let c=lock_contract(&mut tx,u.user_id,id).await?;
    let mut terms=c.rental_terms.ok_or_else(||AppError::BadRequest("기존 계약은 계약 편집에서 확인해 주세요.".into()))?;
    if c.status!="draft" { return Err(AppError::Conflict("출고 전 예약만 확인할 수 있습니다.".into())); }
    if input.template_body.as_ref().is_some_and(|v|v.chars().count()>20000) { return Err(AppError::BadRequest("계약 내용이 너무 깁니다.".into())); }
    let template_id = input.template_id.or(c.template_id);
    if let Some(id) = input.template_id.filter(|id| Some(*id) != c.template_id) {
        let available: Option<i64> = sqlx::query_scalar("SELECT id FROM rental_office_catalog
            WHERE id=$1 AND user_id=$2 AND kind='templates' AND active FOR SHARE")
            .bind(id).bind(u.user_id).fetch_optional(&mut *tx).await?;
        if available.is_none() {
            return Err(AppError::Conflict("사용할 수 없는 계약서 양식입니다. 최신 목록에서 다시 선택해 주세요.".into()));
        }
    }
    terms["license_checked"]=json!(input.license_checked);
    // Keep the contact in its existing retention-managed field. Saved template text uses a reference.
    let snapshot=input.template_body.map(|body|match c.renter_phone.as_deref().filter(|s|!s.is_empty()) {
        Some(phone)=>body.replace(phone,"{{고객연락처}}"),None=>body
    });
    let snapshot = json!(snapshot);
    if !input.contract_confirmed {
        terms["confirmed_at"] = Value::Null;
    } else if terms["confirmed_at"].is_null() || terms["template_body"] != snapshot || template_id != c.template_id {
        terms["confirmed_at"] = json!(Utc::now());
    }
    terms["template_body"]=snapshot;
    sqlx::query("UPDATE rental_contracts SET rental_terms=$1,template_id=$4,updated_at=now() WHERE id=$2 AND user_id=$3")
        .bind(&terms).bind(id).bind(u.user_id).bind(template_id).execute(&mut *tx).await?;
    tx.commit().await?;
    terms["template_id"] = json!(template_id);
    Ok(Json(terms))
}

async fn check_release(tx: &mut Transaction<'_, Postgres>, owner:i64, c:&Contract, odometer:i32) -> AppResult<()> {
    let d=c.vehicle_id.ok_or_else(||AppError::Conflict("실제 차량을 먼저 배정해 주세요.".into()))?;
    if odometer<0 { return Err(AppError::BadRequest("인수 주행거리를 확인해 주세요.".into())); }
    if let Some(t)=&c.rental_terms {
        if c.status!="draft" || Utc::now()>=c.ends_at { return Err(AppError::Conflict("출고할 수 있는 예약 기간과 상태를 확인해 주세요.".into())); }
        let p=policy(tx,owner).await?;
        if p.require_license && t["license_checked"]!=true { return Err(AppError::Conflict("실운전자 면허 확인이 필요합니다.".into())); }
        if p.require_contract && t["confirmed_at"].is_null() { return Err(AppError::Conflict("계약 조건을 먼저 확인해 주세요.".into())); }
        if p.require_payment {
            let paid:i64=sqlx::query_scalar("SELECT COALESCE(SUM(CASE kind WHEN 'payment' THEN amount_krw WHEN 'refund' THEN -amount_krw ELSE 0 END),0)::bigint
              FROM rental_office_ledger WHERE user_id=$1 AND contract_id=$2").bind(owner).bind(c.id).fetch_one(&mut **tx).await?;
            let due=pricing::billed(tx,owner,c.id).await?;
            if paid < due { return Err(AppError::Conflict("대여료 수납을 먼저 완료해 주세요.".into())); }
        }
    }
    lock_device_rental(tx,d).await?;
    let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rental_asset_directory WHERE vehicle_id=$1 AND owner_id=$2 AND enabled AND readiness='ready')")
        .bind(d).bind(owner).fetch_one(&mut **tx).await?;
    if !owned {return Err(AppError::Conflict("현재 배차할 수 없는 차량입니다.".into()));}
    // Early pickup occupies the car from the actual handover. Another active holder also blocks it.
    let occupied:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rental_contracts WHERE vehicle_id=$1 AND id<>$2 AND status IN ('active','overdue') AND (starts_at<=now() OR rental_terms->>'checkout_at' IS NOT NULL))").bind(d).bind(c.id).fetch_one(&mut **tx).await?;
    if occupied {return Err(AppError::Conflict("이 차량의 이전 대여가 아직 반납되지 않았습니다.".into()));}
    check_contract_overlap(tx,owner,d,c.starts_at.min(Utc::now()),c.ends_at,Some(c.id)).await
}

#[derive(Deserialize)]
struct Checkout { odometer_km:i32, fuel_percent: Option<i32>, note: Option<String> }

async fn checkout(State(s): State<AppState>,u: RentalOwner,Path(id): Path<i64>,Json(input):Json<Checkout>)->AppResult<Json<Value>> {
    let mut tx=s.db.begin().await?;
    owner_lock(&mut tx,u.user_id).await?;
    let c=lock_contract(&mut tx,u.user_id,id).await?;
    if c.status!="draft" || c.rental_terms.is_none() {return Err(AppError::Conflict("출고 대기 예약만 처리할 수 있습니다.".into()));}
    if input.fuel_percent.is_some_and(|v|!(0..=100).contains(&v)) || input.note.as_ref().is_some_and(|v|v.chars().count()>1000) {
        return Err(AppError::BadRequest("연료·충전량 또는 점검 메모를 확인해 주세요.".into()));
    }
    check_release(&mut tx,u.user_id,&c,input.odometer_km).await?;
    let device=c.vehicle_id.ok_or_else(||AppError::Conflict("차량을 먼저 배정해 주세요.".into()))?;
    fleet_work::after_checkout(&mut tx,u.user_id,device,input.odometer_km,input.fuel_percent).await?;
    let info=json!({"checkout_at":Utc::now(),"pickup_fuel":input.fuel_percent,"pickup_note":input.note});
    sqlx::query("UPDATE rental_contracts SET rental_terms=rental_terms || $1, status='active',pickup_odometer_km=$2,updated_at=now() WHERE id=$3 AND user_id=$4")
        .bind(info).bind(input.odometer_km).bind(id).bind(u.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

pub(super) async fn guard_handoff(tx: &mut Transaction<'_, Postgres>,owner:i64,id:i64,purpose:&str,odometer:i32)->AppResult<()> {
    owner_lock(tx,owner).await?;
    let c=lock_contract(tx,owner,id).await?;
    if purpose=="pickup" {
        if !matches!(c.status.as_str(),"draft"|"active") {return Err(AppError::Conflict("인수할 수 없는 계약입니다.".into()));}
        check_release(tx,owner,&c,odometer).await?;
    } else if !matches!(c.status.as_str(),"active"|"overdue") || odometer<c.pickup_odometer_km.unwrap_or(0) {
        return Err(AppError::Conflict("차량의 대여 상태와 반납 주행거리를 확인해 주세요.".into()));
    }
    Ok(())
}

pub(super) fn charge_units(start:DateTime<Utc>,end:DateTime<Utc>,rate_type:&str)->i64 {
    let duration=end-start;
    let (whole,divisor)=match rate_type {"hourly"=>(duration.num_minutes(),60),"monthly"=>(duration.num_days(),30),_=>(duration.num_hours(),24)};
    ((whole+divisor-1)/divisor).max(1)
}

pub(super) async fn ledger(db: &mut PgConnection, owner:i64, id:i64)->AppResult<(i64,i64)> {
    Ok(sqlx::query_as("SELECT
        COALESCE(SUM(CASE kind WHEN 'payment' THEN amount_krw WHEN 'refund' THEN -amount_krw ELSE 0 END),0)::bigint,
        COALESCE(SUM(CASE kind WHEN 'deposit_in' THEN amount_krw WHEN 'deposit_out' THEN -amount_krw ELSE 0 END),0)::bigint
        FROM rental_office_ledger WHERE user_id=$1 AND contract_id=$2").bind(owner).bind(id).fetch_one(db).await?)
}

async fn balance(State(s):State<AppState>,u:RentalOwner,Path(id):Path<i64>)->AppResult<Json<Value>> {
    let mut tx=s.db.begin().await?;
    // The contract lock is shared with all ledger writes, extensions, and final settlement.
    lock_contract(&mut tx,u.user_id,id).await?;
    let due=pricing::billed(&mut tx,u.user_id,id).await?;
    let (paid,held)=ledger(&mut tx,u.user_id,id).await?;
    let extensions: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('ends_before',ends_before,'ends_after',ends_after,
        'additional_krw',additional_krw,'reason',reason,'created_at',created_at) FROM rental_agreement_extensions
        WHERE owner_id=$1 AND contract_id=$2 ORDER BY id DESC")
        .bind(u.user_id).bind(id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"billed_krw":due,"paid_krw":paid,"held_krw":held,"extensions":extensions})))
}

pub(super) async fn return_balance(tx:&mut Transaction<'_,Postgres>,owner:i64,id:i64,settlement:&mut Value,subtotal:i64)->AppResult<i64>{
    let (paid,held)=ledger(tx,owner,id).await?;
    let net=paid-subtotal;
    settlement["paid_krw"]=json!(paid);
    settlement["held_krw"]=json!(held);
    settlement["balance"]=json!(net);
    Ok(net)
}
