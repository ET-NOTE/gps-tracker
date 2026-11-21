use super::*;
use crate::routes::rentcar_office::RentalOwner;
use sqlx::PgConnection;

const MAX_AMOUNT: i64 = 1_000_000_000;

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct PriceInput {
    mode: String,
    base_krw: i64,
    option_krw: i64,
    discount_krw: i64,
}

pub(super) fn agreed(terms: Option<&Value>) -> bool {
    terms.is_some_and(|terms| terms["pricing"]["mode"]=="agreed")
}

pub(super) fn apply_price(terms: &mut Value, current: Option<&Contract>, input: Option<&PriceInput>) -> AppResult<()> {
    let Some(price) = input else { return Ok(()); };
    if price.mode!="agreed" || [price.base_krw,price.option_krw,price.discount_krw].iter()
        .any(|v|!(0..=MAX_AMOUNT).contains(v)) || price.discount_krw>price.base_krw+price.option_krw {
        return Err(AppError::BadRequest("약정 금액과 할인 범위를 확인해 주세요.".into()));
    }
    if current.is_some_and(|c|!agreed(c.rental_terms.as_ref())) {
        return Err(AppError::Conflict("기존 계약은 등록할 때의 요금 방식을 사용합니다.".into()));
    }
    let old = &terms["pricing"];
    let value=json!({"mode":"agreed","base_krw":price.base_krw,"option_krw":price.option_krw,
        "discount_krw":price.discount_krw,"extension_krw":old["extension_krw"].as_i64().unwrap_or(0),
        "return_extra_krw":old["return_extra_krw"].as_i64().unwrap_or(0)});
    if current.is_some_and(|c|c.status!="draft") && old!=&value {
        return Err(AppError::Conflict("출고 후 원래 약정 금액을 바꿀 수 없습니다.".into()));
    }
    if current.is_some() && old!=&value {terms["confirmed_at"]=Value::Null;}
    terms["pricing"]=value;
    Ok(())
}

pub(super) async fn billed(db: &mut PgConnection, owner: i64, id: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT rental_office_contract_fee(c)::bigint FROM rental_contracts c
        WHERE user_id=$1 AND id=$2")
        .bind(owner).bind(id).fetch_optional(db).await?.ok_or(AppError::NotFound)
}

pub(super) fn return_items(terms: &Value, extra: i64, label: Option<&str>) -> (Value,i64,i64) {
    let p = &terms["pricing"];
    let n = |key:&str| p[key].as_i64().unwrap_or(0);
    let base = n("base_krw");
    let amounts = [("base","합의 기본 대여료",base),("option","자차·옵션",n("option_krw")),
        ("discount","합의 할인",-n("discount_krw")),("extension","합의 연장 요금",n("extension_krw")),
        ("extra",label.filter(|s|!s.trim().is_empty()).unwrap_or("반납 추가 요금"),extra)];
    let total = amounts.iter().map(|(_,_,v)|*v).sum();
    let lines:Vec<Value> = amounts.into_iter().filter(|(kind,_,amount)|*kind=="base"||*amount!=0)
        .map(|(kind,label,amount)|json!({"kind":kind,"label":label,"amount":amount})).collect();
    (json!({"mode":"agreed","lines":lines,"subtotal":total}),total,base)
}

#[derive(Deserialize)]
pub(super) struct Extend {
    ends_at: DateTime<Utc>,
    expected_ends_at: DateTime<Utc>,
    additional_krw: i64,
    #[serde(default)]
    reason: String,
    request_key: uuid::Uuid,
}

pub(super) async fn extend(
    State(s):State<AppState>,u:RentalOwner,Path(id):Path<i64>,Json(input):Json<Extend>
) -> AppResult<Json<Contract>> {
    let reason = input.reason.trim();
    if input.ends_at<=input.expected_ends_at || !(0..=MAX_AMOUNT).contains(&input.additional_krw) || reason.chars().count()>500 {
        return Err(AppError::BadRequest("새 반납 예정 시각, 추가 요금과 연장 사유를 확인해 주세요.".into()));
    }
    let mut tx=s.db.begin().await?;
    workflow::owner_lock(&mut tx,u.user_id).await?;
    let c=workflow::lock_contract(&mut tx,u.user_id,id).await?;
    let key=input.request_key.to_string();
    let replay:Option<bool>=sqlx::query_scalar("SELECT (contract_id,ends_before,ends_after,additional_krw,reason)=($3,$4,$5,$6,$7)
        FROM rental_agreement_extensions WHERE owner_id=$1 AND request_key=$2::text::uuid")
        .bind(u.user_id).bind(&key).bind(id).bind(input.expected_ends_at).bind(input.ends_at)
        .bind(input.additional_krw).bind(reason).fetch_optional(&mut *tx).await?;
    if let Some(same)=replay {
        if !same{return Err(AppError::Conflict("다른 연장에 사용된 요청 키입니다.".into()));}
        tx.commit().await?;return Ok(Json(c));
    }
    if !agreed(c.rental_terms.as_ref()) || !matches!(c.status.as_str(),"draft"|"active"|"overdue") ||
        c.ends_at.timestamp_micros()!=input.expected_ends_at.timestamp_micros() {
        return Err(AppError::Conflict("계약 단계와 최신 반납 예정 시각을 다시 확인해 주세요.".into()));
    }
    let req=ContractPayload {
        device_id:c.device_id,vehicle_id:c.vehicle_id,rental_terms:None,renter_name:c.renter_name.clone(),
        renter_phone:c.renter_phone.clone(),renter_id_last4:c.renter_id_last4.clone(),starts_at:c.starts_at,ends_at:input.ends_at,
        rate_type:Some(c.rate_type.clone()),rate_amount_krw:Some(c.rate_amount_krw),
        included_km_per_day:c.included_km_per_day,over_km_price_krw:c.over_km_price_krw,
        deposit_krw:Some(c.deposit_krw),pickup_odometer_km:c.pickup_odometer_km,pickup_location:c.pickup_location.clone(),
        return_location:c.return_location.clone(),status:Some(c.status.clone()),note:c.note.clone(),
    };
    let mut terms=workflow::prepare_booking_operation(&mut tx,u.user_id,&req,Some(id),&c.status,true).await?
        .ok_or_else(||AppError::Conflict("약정 계약을 다시 확인해 주세요.".into()))?;
    let total=terms["pricing"]["extension_krw"].as_i64().unwrap_or(0)+input.additional_krw;
    if total>MAX_AMOUNT {return Err(AppError::BadRequest("누적 연장 요금은 10억 원까지 기록할 수 있습니다.".into()));}
    terms["pricing"]["extension_krw"]=json!(total);
    sqlx::query("INSERT INTO rental_agreement_extensions(owner_id,contract_id,ends_before,ends_after,additional_krw,reason,request_key)
        VALUES($1,$2,$3,$4,$5,$6,$7::text::uuid)")
        .bind(u.user_id).bind(id).bind(c.ends_at).bind(input.ends_at).bind(input.additional_krw).bind(reason).bind(key).execute(&mut *tx).await?;
    sqlx::query("SET LOCAL seriallink.rental_contract_edit = 'on'").execute(&mut *tx).await?;
    sqlx::query("UPDATE rental_contracts SET ends_at=$3,rental_terms=$4,updated_at=now(),
        status=CASE WHEN status='overdue' AND $3>now() THEN 'active' ELSE status END,ending_alerted_at=NULL,overdue_alerted_at=NULL
        WHERE id=$1 AND user_id=$2").bind(id).bind(u.user_id).bind(input.ends_at).bind(terms).execute(&mut *tx).await?;
    let result=workflow::lock_contract(&mut tx,u.user_id,id).await?;
    tx.commit().await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub(super) struct Settle {request_key:uuid::Uuid}

pub(super) async fn settle(
    State(s):State<AppState>,u:RentalOwner,Path(id):Path<i64>,Json(input):Json<Settle>
) -> AppResult<Json<Contract>> {
    let mut tx=s.db.begin().await?;
    workflow::owner_lock(&mut tx,u.user_id).await?;
    let c=workflow::lock_contract(&mut tx,u.user_id,id).await?;
    let key=input.request_key.to_string();
    let previous:Option<i64>=sqlx::query_scalar("SELECT id FROM rental_contracts WHERE user_id=$1 AND settlement_request_key=$2::text::uuid")
        .bind(u.user_id).bind(&key).fetch_optional(&mut *tx).await?;
    if previous==Some(id) {tx.commit().await?;return Ok(Json(c));}
    if previous.is_some() || c.status!="returned" || c.settled_at.is_some() || !agreed(c.rental_terms.as_ref()) {
        return Err(AppError::Conflict("정산 대기 중인 반납 계약을 선택해 주세요.".into()));
    }
    let due=billed(&mut tx,u.user_id,id).await?;
    let (paid,held)=workflow::ledger(&mut tx,u.user_id,id).await?;
    if paid!=due {return Err(AppError::Conflict("대여료 미수 또는 초과 수납을 먼저 처리해 주세요.".into()));}
    sqlx::query("UPDATE rental_contracts SET settled_at=now(),settled_amount_krw=$3,refund_krw=0,
        settlement_request_key=$4::text::uuid,settlement_json=settlement_json || jsonb_build_object('paid_krw',$3::bigint,'held_krw',$5::bigint,'balance',0),
        updated_at=now() WHERE id=$1 AND user_id=$2").bind(id).bind(u.user_id).bind(due).bind(key).bind(held).execute(&mut *tx).await?;
    let saved=workflow::lock_contract(&mut tx,u.user_id,id).await?;
    tx.commit().await?;
    Ok(Json(saved))
}
