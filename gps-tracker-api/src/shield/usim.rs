use super::*;
use axum::extract::{Path, Query};
use serde::Deserialize;
use sqlx::{Postgres, Transaction};

pub fn price() -> i64 {
    env::var("SHIELD_TOPUP_COST")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0 && *v <= 10_000_000)
        .unwrap_or(143_000)
}
async fn allowed(app: &App, h: &HeaderMap, id: i64) -> Result<i64> {
    let user = auth::user(app, h).await?;
    if devices::own(app, user, id).await.is_err() {
        admin::require(app, h).await?;
    }
    Ok(user)
}
pub async fn get(State(app): State<App>, h: HeaderMap, Path(id): Path<i64>) -> Result<Json<Value>> {
    allowed(&app, &h, id).await?;
    let data:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('last4',right(sim_iccid,4),'usage',sim_info,'updated_at',sim_updated_at,'attempted_at',sim_attempted_at,'error',sim_error,'linked',sim_iccid IS NOT NULL) FROM devices WHERE id=$1").bind(id).fetch_optional(&app.db).await?;
    Ok(Json(
        json!({"sim":data.ok_or_else(missing)?,"provider":app.nce.status(),"topup_mb":500,"cost_credits":price()}),
    ))
}
pub async fn refresh(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    let actor = allowed(&app, &h, id).await?;
    auth::rate(&app, format!("sim-refresh:{actor}"), 20).await?;
    if !app.nce.configured() {
        return Err(bad("통신사 연동 설정을 확인해 주세요."));
    }
    tokio::spawn(async move {
        let _ = refresh_one(&app, id).await;
    });
    Ok(Json(json!({"ok":true,"queued":true})))
}
async fn refresh_one(app: &App, id: i64) -> Result<()> {
    let sim:Option<String>=sqlx::query_scalar("UPDATE devices SET sim_attempted_at=now() WHERE id=$1 AND sim_iccid IS NOT NULL AND (sim_attempted_at IS NULL OR sim_attempted_at<now()-interval '5 minutes') RETURNING sim_iccid").bind(id).fetch_optional(&app.db).await?;
    let Some(sim) = sim else { return Ok(()) };
    match app.nce.usage(&sim).await {
        Ok(value) => {
            sqlx::query("UPDATE devices SET sim_info=$2,sim_updated_at=now(),sim_error=NULL WHERE id=$1 AND sim_iccid=$3").bind(id).bind(value).bind(&sim).execute(&app.db).await?;
        }
        Err(_) => {
            sqlx::query("UPDATE devices SET sim_error='통신사 조회에 실패했습니다. 마지막 확인값을 표시합니다.' WHERE id=$1 AND sim_iccid=$2").bind(id).bind(&sim).execute(&app.db).await?;
        }
    }
    Ok(())
}
pub fn worker(app: App) {
    if !app.nce.configured() {
        return;
    }
    tokio::spawn(async move {
        loop {
            let ids:std::result::Result<Vec<i64>,_>=sqlx::query_scalar("SELECT id FROM devices WHERE sim_iccid IS NOT NULL AND owner_id IS NOT NULL AND (sim_updated_at IS NULL OR sim_updated_at<now()-interval '30 minutes') ORDER BY sim_attempted_at NULLS FIRST LIMIT 100").fetch_all(&app.db).await;
            if let Ok(ids) = ids {
                for id in ids {
                    if refresh_one(&app, id).await.is_err() {
                        tracing::warn!(device = id, "Shield SIM cache update failed");
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
}
async fn credit(
    tx: &mut Transaction<'_, Postgres>,
    user: i64,
    actor: i64,
    amount: i64,
    request: Option<i64>,
    entry: (&str, &str, &str),
) -> Result<i64> {
    let (kind, reference, note) = entry;
    let balance:Option<i64>=sqlx::query_scalar("UPDATE users SET credit_balance=credit_balance+$2 WHERE id=$1 AND credit_balance+$2>=0 RETURNING credit_balance").bind(user).bind(amount).fetch_optional(&mut **tx).await?;
    let balance =
        balance.ok_or_else(|| bad("포인트가 부족합니다. 관리자에게 충전을 요청해 주세요."))?;
    sqlx::query("INSERT INTO credit_entries(user_id,actor_id,amount,balance_after,request_id,kind,reference,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(user).bind(actor).bind(amount).bind(balance).bind(request).bind(kind).bind(reference).bind(note).execute(&mut **tx).await?;
    Ok(balance)
}
async fn ledger(
    tx: &mut Transaction<'_, Postgres>,
    id: i64,
    actor: i64,
    event: &str,
    detail: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO sim_ledger(request_id,actor_id,event,detail) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(actor)
        .bind(event)
        .bind(&detail)
        .execute(&mut **tx)
        .await?;
    admin::audit(
        tx,
        Some(actor),
        event,
        "sim_request",
        &id.to_string(),
        detail,
    )
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    device_id: i64,
    idempotency_key: String,
    #[serde(default)]
    note: String,
}
fn request_key(key: &str) -> bool {
    Uuid::parse_str(key).is_ok()
}
pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Create>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    devices::own(&app, user, v.device_id).await?;
    if !request_key(&v.idempotency_key) || v.note.chars().count() > 300 {
        return Err(bad("요청 내용을 확인해 주세요."));
    }
    let mut tx = app.db.begin().await?;
    // User lock serializes idempotency checks and balances across devices.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(user)
        .execute(&mut *tx)
        .await?;
    if let Some((id, device)) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT id,device_id FROM sim_requests WHERE user_id=$1 AND idempotency_key=$2",
    )
    .bind(user)
    .bind(&v.idempotency_key)
    .fetch_optional(&mut *tx)
    .await?
    {
        if device != v.device_id {
            return Err(bad("이미 다른 요청에서 사용한 요청 번호입니다."));
        }
        return Ok(Json(json!({"id":id,"duplicate":true})));
    }
    let sim: Option<Option<String>> =
        sqlx::query_scalar("SELECT sim_iccid FROM devices WHERE id=$1 AND owner_id=$2 FOR UPDATE")
            .bind(v.device_id)
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    let sim = nce::normalize_iccid(
        &sim.flatten()
            .ok_or_else(|| bad("등록된 USIM이 없습니다."))?,
    )?;
    let open:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sim_requests WHERE iccid=$1 AND status IN ('pending','approved','submitting','submitted','unknown'))").bind(&sim).fetch_one(&mut *tx).await?;
    if open {
        return Err(bad("이미 진행 중인 충전 요청이 있습니다."));
    }
    let cost = price();
    let id:i64=sqlx::query_scalar("INSERT INTO sim_requests(reference,device_id,user_id,iccid,idempotency_key,note,cost_credits) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id")
        .bind(format!("shield-{}",Uuid::new_v4())).bind(v.device_id).bind(user).bind(sim).bind(v.idempotency_key).bind(v.note.trim()).bind(cost).fetch_one(&mut *tx).await?;
    let balance = credit(
        &mut tx,
        user,
        user,
        -cost,
        Some(id),
        ("charge", &format!("sim:{id}:charge"), "USIM 500MB 요청"),
    )
    .await?;
    ledger(
        &mut tx,
        id,
        user,
        "sim.request",
        json!({"cost_credits":cost,"device_id":v.device_id}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"balance":balance,"duplicate":false})))
}
pub async fn requests(
    State(app): State<App>,
    h: HeaderMap,
    Query(p): Query<admin::Page>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    let is_admin = admin::require(&app, &h).await.is_ok();
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',r.id,'reference',reference,'device_id',r.device_id,'device_name',d.display_name,'user_email',u.email,'last4',right(r.iccid,4),'requested_mb',requested_mb,'cost_credits',cost_credits,'status',r.status,'note',note,'admin_note',admin_note,'provider_order_id',provider_order_id,'created_at',r.created_at,'updated_at',r.updated_at) FROM sim_requests r JOIN devices d ON d.id=r.device_id JOIN users u ON u.id=r.user_id WHERE ($1 OR r.user_id=$2) AND r.id<$3 ORDER BY r.id DESC LIMIT 100").bind(is_admin).bind(user).bind(p.before.unwrap_or(i64::MAX)).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn history(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    let own: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sim_requests WHERE id=$1 AND user_id=$2)")
            .bind(id)
            .bind(user)
            .fetch_one(&app.db)
            .await?;
    if !own {
        admin::require(&app, &h).await?;
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('event',event,'detail',detail,'created_at',created_at) FROM sim_ledger WHERE request_id=$1 ORDER BY id").bind(id).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    action: String,
    #[serde(default)]
    note: String,
    confirm_reference: Option<String>,
    order_id: Option<String>,
}
pub async fn action(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Json(v): Json<Action>,
) -> Result<Json<Value>> {
    let actor = auth::user(&app, &h).await?;
    let is_admin = admin::require(&app, &h).await.is_ok();
    if v.note.chars().count() > 500 {
        return Err(bad("메모는 500자 이내입니다."));
    }
    let mut tx = app.db.begin().await?;
    let row:Option<(i64,i64,String,String,String,i64)>=sqlx::query_as("SELECT user_id,device_id,iccid,status,reference,cost_credits FROM sim_requests WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let (user, device, sim, status, reference, cost) = row.ok_or_else(missing)?;
    if !(is_admin || actor == user && v.action == "cancel") {
        return Err(Error(StatusCode::FORBIDDEN, "처리 권한이 없습니다.".into()));
    }
    let next = match v.action.as_str() {
        "approve" if is_admin && status == "pending" => "approved",
        "cancel" if status == "pending" || (is_admin && status == "approved") => "cancelled",
        "reject" if is_admin && ["pending", "approved"].contains(&status.as_str()) => "rejected",
        "execute" if is_admin && status == "approved" => {
            if v.confirm_reference.as_deref() != Some(&reference) || !app.nce.can_topup() {
                return Err(bad("요청 번호 확인과 통신사 충전 설정이 필요합니다."));
            }
            let current: Option<String> =
                sqlx::query_scalar("SELECT sim_iccid FROM devices WHERE id=$1 AND owner_id=$2")
                    .bind(device)
                    .bind(user)
                    .fetch_optional(&mut *tx)
                    .await?
                    .flatten();
            if current
                .as_deref()
                .map(nce::normalize_iccid)
                .transpose()?
                .as_deref()
                != Some(&sim)
            {
                return Err(bad("요청 이후 장치 소유권 또는 USIM이 변경되었습니다."));
            }
            "submitting"
        }
        "reconcile"
            if is_admin && ["submitting", "unknown", "submitted"].contains(&status.as_str()) =>
        {
            if v.note.trim().is_empty() {
                return Err(bad("통신사 주문 확인 근거를 메모에 남겨 주세요."));
            }
            let order = v
                .order_id
                .as_deref()
                .ok_or_else(|| bad("통신사 주문 번호를 입력해 주세요."))?;
            let linked: Option<String> =
                sqlx::query_scalar("SELECT provider_order_id FROM sim_requests WHERE id=$1")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            if linked.as_deref().is_some_and(|linked| linked != order) {
                return Err(bad("이미 접수된 통신사 주문 번호와 일치하지 않습니다."));
            }
            let reused: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM sim_requests WHERE provider_order_id=$1 AND id<>$2)",
            )
            .bind(order)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if reused {
                return Err(bad("다른 충전 요청에 연결된 주문입니다."));
            }
            // Read-only lookup and exact SIM/type checks precede manual completion.
            let info = app.nce.order(order).await?;
            let matching = info
                .get("sims")
                .and_then(Value::as_array)
                .is_some_and(|sims| {
                    sims.iter().any(|s| {
                        s["iccid"]
                            .as_str()
                            .and_then(|s| nce::normalize_iccid(s).ok())
                            .as_deref()
                            == Some(&sim)
                    })
                });
            if !matching || info["order_type"].as_str() != Some("TOPUP") {
                return Err(bad("이 USIM에 해당하는 충전 주문인지 확인할 수 없습니다."));
            }
            sqlx::query("UPDATE sim_requests SET provider_order_id=$2 WHERE id=$1")
                .bind(id)
                .bind(order)
                .execute(&mut *tx)
                .await?;
            "completed"
        }
        _ => return Err(bad("현재 요청 상태에서는 이 작업을 할 수 없습니다.")),
    };
    sqlx::query("UPDATE sim_requests SET status=$2,admin_note=$3,processed_by=$4,updated_at=now() WHERE id=$1").bind(id).bind(next).bind(v.note.trim()).bind(actor).execute(&mut *tx).await?;
    if ["cancelled", "rejected"].contains(&next) {
        credit(
            &mut tx,
            user,
            actor,
            cost,
            Some(id),
            (
                "refund",
                &format!("sim:{id}:refund"),
                "전송 전 USIM 요청 취소",
            ),
        )
        .await?;
    }
    ledger(
        &mut tx,
        id,
        actor,
        &format!("sim.{next}"),
        json!({"from":status,"to":next,"note":v.note.trim()}),
    )
    .await?;
    tx.commit().await?;
    if next == "submitting" {
        // Detached once after durable submitting state: browser disconnects cannot
        // trigger a second purchase; process crash leaves a manual reconciliation.
        tokio::spawn(async move {
            let outcome = app.nce.topup(&sim).await;
            let (state, http, order) = match outcome {
                Ok((201, Some(order))) => ("submitted", Some(201i32), Some(order)),
                Ok((s, _)) if [400, 401, 403, 404, 422].contains(&s) => {
                    ("failed", Some(i32::from(s)), None)
                }
                Ok((s, _)) => ("unknown", Some(i32::from(s)), None),
                Err(_) => ("unknown", None, None),
            };
            let result:Result<()>=async {
                let mut tx=app.db.begin().await?;
                let updated=sqlx::query("UPDATE sim_requests SET status=$2,provider_status=$3,provider_order_id=$4,updated_at=now() WHERE id=$1 AND status='submitting'").bind(id).bind(state).bind(http).bind(&order).execute(&mut *tx).await?.rows_affected();
                if updated==1 {
                    if state=="failed" {credit(&mut tx,user,actor,cost,Some(id),("refund",&format!("sim:{id}:refund"),"통신사의 주문 거절")).await?;}
                    ledger(&mut tx,id,actor,&format!("sim.{state}"),json!({"http_status":http,"order_id":order})).await?;
                }
                tx.commit().await?;Ok(())
            }.await;
            if result.is_err() {
                tracing::error!(request_id = id, "Shield topup result needs reconciliation");
            }
        });
    }
    Ok(Json(json!({"ok":true,"status":next})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Adjustment {
    amount: i64,
    note: String,
    idempotency_key: String,
}
pub async fn adjust(
    State(app): State<App>,
    h: HeaderMap,
    Path(user): Path<i64>,
    Json(v): Json<Adjustment>,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, &h).await?;
    if v.amount == 0
        || v.amount.unsigned_abs() > 10_000_000
        || v.note.trim().is_empty()
        || v.note.chars().count() > 300
        || !request_key(&v.idempotency_key)
    {
        return Err(bad("조정 금액·사유·요청 번호를 확인해 주세요."));
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(user)
        .execute(&mut *tx)
        .await?;
    let reference = format!("adjust:{}", v.idempotency_key);
    let existing: Option<(i64, i64, i64)> = sqlx::query_as(
        "SELECT user_id,amount,balance_after FROM credit_entries WHERE reference=$1",
    )
    .bind(&reference)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((u, a, balance)) = existing {
        if u != user || a != v.amount {
            return Err(bad("다른 조정에서 사용한 요청 번호입니다."));
        }
        return Ok(Json(json!({"balance":balance,"duplicate":true})));
    }
    let balance = credit(
        &mut tx,
        user,
        actor,
        v.amount,
        None,
        ("adjustment", &reference, v.note.trim()),
    )
    .await?;
    admin::audit(
        &mut tx,
        Some(actor),
        "credit.adjust",
        "user",
        &user.to_string(),
        json!({"amount":v.amount,"balance":balance,"note":v.note.trim()}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"balance":balance})))
}
pub async fn credits(
    State(app): State<App>,
    h: HeaderMap,
    Query(p): Query<admin::Page>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    let admin = admin::require(&app, &h).await.is_ok();
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',e.id,'user_email',u.email,'amount',amount,'balance_after',balance_after,'kind',kind,'request_id',request_id,'note',note,'created_at',e.created_at) FROM credit_entries e JOIN users u ON u.id=e.user_id WHERE ($1 OR e.user_id=$2) AND e.id<$3 ORDER BY e.id DESC LIMIT 100").bind(admin).bind(user).bind(p.before.unwrap_or(i64::MAX)).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
