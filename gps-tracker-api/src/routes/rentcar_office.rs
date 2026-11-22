use axum::{
    extract::{FromRequestParts, Path, Query, State},
    http::request::Parts,
    routing::{delete, get, patch, post},
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

pub(super) struct RentalOwner {
    pub(super) user_id: i64,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for RentalOwner {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        if parts
            .extensions
            .get::<crate::auth::fleet::FleetScope>()
            .is_some()
        {
            return Err(AppError::Forbidden);
        }
        let auth = AuthUser::from_request_parts(parts, state).await?;
        let enabled: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT FROM users WHERE id=$1 AND gps_owner_service(users,'rentcar'))",
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
        .route("/rentcar/office/catalog", get(catalog))
        .route("/rentcar/office/catalog/:kind", post(create_master))
        .route("/rentcar/office/catalog/:kind/:id", patch(edit_master))
        .route("/rentcar/office/templates/:id", delete(delete_template))
        .route("/rentcar/office/customers/:id/contracts", get(customer_history))
        .route("/rentcar/office/book", get(book))
        .route("/rentcar/office/ledger", post(record))
        .route("/rentcar/office/costs", post(create_cost))
        .route("/rentcar/office/costs/:id", patch(edit_cost).delete(delete_cost))
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn changed() -> AppError {
    AppError::Conflict("다른 화면에서 항목이 변경되었습니다. 최신 목록을 확인해 주세요.".into())
}
fn db_error(e: sqlx::Error) -> AppError {
    if e.as_database_error()
        .is_some_and(|e| e.is_unique_violation())
    {
        AppError::Conflict("같은 정보가 이미 등록되어 있습니다.".into())
    } else {
        e.into()
    }
}

#[derive(Deserialize)]
struct CatalogOptions { summary: Option<bool> }

const CATALOG_SUMMARY_SQL: &str = concat!(
    include_str!("rentcar_office_parties.sql"),
    include_str!("rentcar_office_catalog.sql")
);
const CUSTOMER_HISTORY_SQL: &str = concat!(
    include_str!("rentcar_office_parties.sql"),
    include_str!("rentcar_customer_history.sql")
);

async fn catalog(State(s): State<AppState>, u: RentalOwner, Query(options):Query<CatalogOptions>) -> AppResult<Json<Value>> {
    let sql = if options.summary.unwrap_or(false) {
        CATALOG_SUMMARY_SQL
    } else {
        "SELECT coalesce(jsonb_object_agg(kind, rows),'{}') FROM (
            SELECT kind, jsonb_agg(details || jsonb_build_object('id',m.id,'name',name,
                'active',active,'revision',revision) || CASE WHEN kind='templates' THEN
                    jsonb_build_object('in_use',EXISTS(SELECT FROM rental_contracts c
                        WHERE c.user_id=m.user_id AND c.template_id=m.id))
                    ELSE '{}'::jsonb END ORDER BY active DESC,name,m.id) AS rows
            FROM rental_office_catalog m WHERE user_id=$1 GROUP BY kind) k"
    };
    let data: Value = sqlx::query_scalar(sql)
    .bind(u.user_id)
    .fetch_one(&s.db)
    .await?;
    let mut result = json!({"customers":[],"accounts":[],"rates":[],"templates":[]});
    for key in ["customers", "accounts", "rates", "templates"] {
        if let Some(rows) = data.get(key) {
            result[key] = rows.clone();
        }
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
struct HistoryQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

fn history_cursor(raw: &str) -> AppResult<(DateTime<Utc>, i64)> {
    let invalid = || bad("대여 이력 페이지 위치가 올바르지 않습니다.");
    let (time, id) = raw.split_once('|').ok_or_else(invalid)?;
    let time = DateTime::parse_from_rfc3339(time).map_err(|_| invalid())?;
    let id = id.parse::<i64>().ok().filter(|id| *id > 0).ok_or_else(invalid)?;
    Ok((time.with_timezone(&Utc), id))
}

async fn customer_history(
    State(state): State<AppState>,
    owner: RentalOwner,
    Path(customer_id): Path<i64>,
    Query(query): Query<HistoryQuery>,
) -> AppResult<Json<Value>> {
    let limit = query.limit.unwrap_or(10);
    if !(1..=50).contains(&limit) {
        return Err(bad("조회 건수는 1~50건으로 입력해 주세요."));
    }
    let cursor = query.cursor.as_deref().map(history_cursor).transpose()?;
    let (before_start, before_id) = cursor.unzip();
    let page = sqlx::query_scalar(CUSTOMER_HISTORY_SQL)
    .bind(owner.user_id)
    .bind(customer_id)
    .bind(before_start)
    .bind(before_id)
    .bind(limit)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(page))
}

fn text(raw: &Value, key: &str, limit: usize, required: bool) -> AppResult<String> {
    let value = raw.get(key).and_then(Value::as_str).unwrap_or("").trim();
    if (required && value.is_empty()) || value.chars().count() > limit {
        return Err(bad("필수 항목과 입력 길이를 확인해 주세요."));
    }
    Ok(value.into())
}
fn choice<'a>(raw: &'a Value, key: &str, choices: &[&str]) -> AppResult<&'a str> {
    raw.get(key)
        .and_then(Value::as_str)
        .filter(|v| choices.contains(v))
        .ok_or_else(|| bad("선택 항목을 확인해 주세요."))
}
fn money(raw: &Value, key: &str) -> AppResult<i64> {
    raw.get(key)
        .and_then(Value::as_i64)
        .filter(|n| (0..=1_000_000_000).contains(n))
        .ok_or_else(|| bad("금액은 0~10억 원 사이의 정수로 입력해 주세요."))
}
fn phone(raw: &Value) -> AppResult<String> {
    let value = text(raw, "phone", 25, true)?;
    let digits = value.bytes().filter(u8::is_ascii_digit).count();
    if !(7..=15).contains(&digits)
        || !value
            .chars()
            .all(|c| c.is_ascii_digit() || "+ ()-".contains(c))
    {
        return Err(bad("연락처를 확인해 주세요."));
    }
    Ok(value)
}
fn details(kind: &str, v: &Value) -> AppResult<Value> {
    Ok(match kind {
        "customers" => {
            let email = text(v, "email", 120, false)?;
            if !email.is_empty()
                && (!email.split_once('@').is_some_and(|(local, domain)| {
                    !local.is_empty() && domain.contains('.') && !domain.contains('@')
                }) || email.contains(char::is_whitespace))
            {
                return Err(bad("이메일 주소를 확인해 주세요."));
            }
            let checked = v["license_checked"].as_bool().unwrap_or(false);
            let account = if v["account_id"].is_null() {
                None
            } else {
                Some(
                    v["account_id"]
                        .as_i64()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| bad("거래처를 확인해 주세요."))?,
                )
            };
            json!({"kind":choice(v,"kind",&["person","business"])?,"phone":phone(v)?,
                "email":email,"account_id":account,"license_type":text(v,"license_type",40,checked)?,
                "license_checked":checked,"memo":text(v,"memo",1000,false)?})
        }
        "accounts" => {
            let number = text(v, "business_number", 12, false)?.replace('-', "");
            if !number.is_empty()
                && (number.len() != 10 || !number.bytes().all(|b| b.is_ascii_digit()))
            {
                return Err(bad("사업자등록번호는 숫자 10자리로 입력해 주세요."));
            }
            json!({"contact":text(v,"contact",40,true)?,"phone":phone(v)?,"business_number":number,
                "billing":choice(v,"billing",&["each","monthly"])?,"memo":text(v,"memo",1000,false)?})
        }
        "rates" => json!({"daily_krw":money(v,"daily_krw")?,"deposit_krw":money(v,"deposit_krw")?,
            "coverage_krw":money(v,"coverage_krw")?}),
        "templates" => json!({"body":text(v,"body",20000,true)?}),
        _ => return Err(AppError::NotFound),
    })
}
async fn save_master(
    db: &PgPool,
    uid: i64,
    kind: &str,
    id: Option<i64>,
    v: Value,
) -> AppResult<Json<Value>> {
    let name = text(&v, "name", 80, true)?;
    let details = details(kind, &v)?;
    let active = v["active"].as_bool().unwrap_or(true);
    let mut tx = db.begin().await?;
    if let Some(account) = details["account_id"].as_i64() {
        let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM rental_office_catalog
            WHERE user_id=$1 AND kind='accounts' AND id=$2 AND (active OR EXISTS
                (SELECT FROM rental_office_catalog c WHERE c.user_id=$1 AND c.id=$3 AND c.kind='customers'
                 AND (c.details->>'account_id')::bigint=$2)) FOR SHARE")
            .bind(uid).bind(account).bind(id).fetch_optional(&mut *tx).await?;
        if exists.is_none() {
            return Err(bad("연결할 수 있는 거래처를 선택해 주세요."));
        }
    }
    let saved: i64 = if let Some(id) = id {
        sqlx::query_scalar(
            "UPDATE rental_office_catalog SET name=$4,details=$5,active=$6,revision=revision+1
            WHERE user_id=$1 AND id=$2 AND kind=$3 AND revision=$7 RETURNING id",
        )
        .bind(uid)
        .bind(id)
        .bind(kind)
        .bind(name)
        .bind(details)
        .bind(active)
        .bind(v["revision"].as_i64())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
        .ok_or_else(changed)?
    } else {
        sqlx::query_scalar(
            "INSERT INTO rental_office_catalog(user_id,kind,name,details,active)
            VALUES($1,$2,$3,$4,$5) RETURNING id",
        )
        .bind(uid)
        .bind(kind)
        .bind(name)
        .bind(details)
        .bind(active)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?
    };
    tx.commit().await?;
    Ok(Json(json!({"id":saved})))
}
async fn create_master(
    State(s): State<AppState>,
    u: RentalOwner,
    Path(k): Path<String>,
    Json(v): Json<Value>,
) -> AppResult<Json<Value>> {
    save_master(&s.db, u.user_id, &k, None, v).await
}
async fn edit_master(
    State(s): State<AppState>,
    u: RentalOwner,
    Path((k, id)): Path<(String, i64)>,
    Json(v): Json<Value>,
) -> AppResult<Json<Value>> {
    save_master(&s.db, u.user_id, &k, Some(id), v).await
}

#[derive(Deserialize)]
struct DeleteRevision {
    revision: i64,
}

async fn delete_template(
    State(s): State<AppState>, owner: RentalOwner, Path(id): Path<i64>, Json(input): Json<DeleteRevision>,
) -> AppResult<Json<Value>> {
    let deleted = sqlx::query("DELETE FROM rental_office_catalog
        WHERE id=$1 AND user_id=$2 AND kind='templates' AND revision=$3")
        .bind(id).bind(owner.user_id).bind(input.revision).execute(&s.db).await
        .map_err(|e| if e.as_database_error().is_some_and(|e| e.is_foreign_key_violation()) {
            AppError::Conflict("계약에 연결된 양식은 삭제할 수 없습니다.".into())
        } else { e.into() })?;
    if deleted.rows_affected() == 0 {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT FROM rental_office_catalog
            WHERE id=$1 AND user_id=$2 AND kind='templates')")
            .bind(id).bind(owner.user_id).fetch_one(&s.db).await?;
        return Err(if exists { changed() } else { AppError::NotFound });
    }
    Ok(Json(json!({"id":id})))
}

async fn delete_cost(
    State(s): State<AppState>, owner: RentalOwner, Path(id): Path<i64>, Json(input): Json<DeleteRevision>,
) -> AppResult<Json<Value>> {
    let deleted = sqlx::query("DELETE FROM rental_office_costs WHERE id=$1 AND user_id=$2 AND revision=$3")
        .bind(id).bind(owner.user_id).bind(input.revision).execute(&s.db).await?;
    if deleted.rows_affected() == 0 {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT FROM rental_office_costs WHERE id=$1 AND user_id=$2)")
            .bind(id).bind(owner.user_id).fetch_one(&s.db).await?;
        return Err(if exists { changed() } else { AppError::NotFound });
    }
    Ok(Json(json!({"id":id})))
}

#[derive(Deserialize)]
struct Period {
    from: NaiveDate,
    to: NaiveDate,
}
async fn book(
    State(s): State<AppState>,
    u: RentalOwner,
    Query(p): Query<Period>,
) -> AppResult<Json<Value>> {
    if !(0..=366).contains(&(p.to - p.from).num_days()) {
        return Err(bad("조회 기간을 1년 이내로 선택해 주세요."));
    }
    let data = sqlx::query_scalar::<_, Value>(include_str!("rentcar_office_book.sql"))
        .bind(u.user_id)
        .bind(p.from)
        .bind(p.to)
        .fetch_one(&s.db)
        .await?;
    Ok(Json(data))
}

#[derive(Deserialize)]
struct Entry {
    contract_id: i64,
    kind: String,
    method: String,
    amount_krw: i64,
    recorded_at: DateTime<Utc>,
    #[serde(default)]
    memo: String,
    request_key: String,
}
fn validate_key(key: &str) -> AppResult<()> {
    uuid::Uuid::parse_str(key)
        .map(|_| ())
        .map_err(|_| bad("요청 식별자가 올바르지 않습니다."))
}
fn limit(kind: &str, billed: i64, deposit: i64, paid: i64, held: i64, cancelled: bool) -> i64 {
    match kind {
        "payment" => billed.saturating_sub(paid),
        "refund" => paid,
        "deposit_in" if !cancelled => deposit.saturating_sub(held),
        "deposit_out" => held,
        _ => 0,
    }
    .max(0)
}
async fn record(
    State(s): State<AppState>,
    u: RentalOwner,
    Json(e): Json<Entry>,
) -> AppResult<Json<Value>> {
    if !["payment", "refund", "deposit_in", "deposit_out"].contains(&e.kind.as_str())
        || !["card", "cash", "transfer"].contains(&e.method.as_str())
        || !(1..=1_000_000_000).contains(&e.amount_krw)
        || e.memo.chars().count() > 500
        || (e.kind == "refund" && e.memo.trim().is_empty())
    {
        return Err(bad(
            "금액과 결제 수단을 확인해 주세요. 이용료 환불에는 사유가 필요합니다.",
        ));
    }
    validate_key(&e.request_key)?;
    let mut tx = s.db.begin().await?;
    // Every record for a contract checks the committed balance after taking the same lock.
    let (billed,deposit,status,finalized): (i64,i64,String,bool) = sqlx::query_as(
        "SELECT rental_office_contract_fee(c)::bigint,deposit_krw,status,settlement_request_key IS NOT NULL
           FROM rental_contracts c
            WHERE user_id=$1 AND id=$2 FOR UPDATE")
        .bind(u.user_id).bind(e.contract_id).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    let old: Option<(i64, bool)> = sqlx::query_as(
        "SELECT id, (contract_id,kind,method,amount_krw,recorded_at,memo)
        = ($3,$4,$5,$6,$7,$8) FROM rental_office_ledger WHERE user_id=$1 AND request_key=$2",
    )
    .bind(u.user_id)
    .bind(&e.request_key)
    .bind(e.contract_id)
    .bind(&e.kind)
    .bind(&e.method)
    .bind(e.amount_krw)
    .bind(e.recorded_at)
    .bind(e.memo.trim())
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, same)) = old {
        return if same {
            Ok(Json(json!({"id":id})))
        } else {
            Err(changed())
        };
    }
    if finalized && matches!(e.kind.as_str(),"payment"|"refund") {
        return Err(AppError::Conflict("정산이 끝난 약정 계약입니다. 보증금 기록은 별도로 처리할 수 있습니다.".into()));
    }
    let (paid,held): (i64,i64) = sqlx::query_as("SELECT
        coalesce(sum(CASE kind WHEN 'payment' THEN amount_krw WHEN 'refund' THEN -amount_krw ELSE 0 END),0)::bigint,
        coalesce(sum(CASE kind WHEN 'deposit_in' THEN amount_krw WHEN 'deposit_out' THEN -amount_krw ELSE 0 END),0)::bigint
        FROM rental_office_ledger WHERE user_id=$1 AND contract_id=$2")
        .bind(u.user_id).bind(e.contract_id).fetch_one(&mut *tx).await?;
    if e.amount_krw > limit(&e.kind, billed, deposit, paid, held, status == "cancelled") {
        return Err(bad(
            "현재 기록 가능한 잔액을 초과했습니다. 계약 잔액을 확인해 주세요.",
        ));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO rental_office_ledger
        (user_id,contract_id,kind,method,amount_krw,recorded_at,memo,request_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    )
    .bind(u.user_id)
    .bind(e.contract_id)
    .bind(e.kind)
    .bind(e.method)
    .bind(e.amount_krw)
    .bind(e.recorded_at)
    .bind(e.memo.trim())
    .bind(e.request_key)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}

#[derive(Deserialize)]
struct Cost {
    vehicle_id: Option<i64>,
    device_id: Option<i64>,
    occurred_on: NaiveDate,
    category: String,
    amount_krw: i64,
    #[serde(default)]
    vendor: String,
    #[serde(default)]
    memo: String,
    request_key: String,
    revision: Option<i64>,
}
async fn save_cost(db: &PgPool, uid: i64, id: Option<i64>, c: Cost) -> AppResult<Json<Value>> {
    validate_key(&c.request_key)?;
    if !["wash", "repair", "fuel", "insurance", "other"].contains(&c.category.as_str())
        || !(1..=1_000_000_000).contains(&c.amount_krw)
        || c.vendor.chars().count() > 80
        || c.memo.chars().count() > 500
    {
        return Err(bad("비용 구분, 금액, 메모를 확인해 주세요."));
    }
    let mut tx = db.begin().await?;
    let (vehicle,device) = super::rentcar::assets::resolve(&mut tx, uid, c.vehicle_id, c.device_id).await?
        .ok_or_else(||bad("비용을 기록할 차량을 선택해 주세요."))?;
    let car: String = sqlx::query_scalar(
        "SELECT coalesce(nullif(plate,''),nullif(display_name,''),'차량 '||vehicle_id::text)
        FROM rental_asset_directory WHERE owner_id=$1 AND vehicle_id=$2",
    )
    .bind(uid)
    .bind(vehicle)
    .fetch_one(&mut *tx)
    .await?;
    let saved: Option<i64> = if let Some(id) = id {
        sqlx::query_scalar(
            "UPDATE rental_office_costs SET device_id=$3,vehicle_name=$4,occurred_on=$5,
            category=$6,amount_krw=$7,vendor=$8,memo=$9,vehicle_id=$11,revision=revision+1
            WHERE user_id=$1 AND id=$2 AND revision=$10 RETURNING id",
        )
        .bind(uid)
        .bind(id)
        .bind(device)
        .bind(car)
        .bind(c.occurred_on)
        .bind(c.category)
        .bind(c.amount_krw)
        .bind(c.vendor.trim())
        .bind(c.memo.trim())
        .bind(c.revision)
        .bind(vehicle)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar("INSERT INTO rental_office_costs AS c
            (user_id,request_key,device_id,vehicle_name,occurred_on,category,amount_krw,vendor,memo,vehicle_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id,request_key)
            DO UPDATE SET request_key=c.request_key WHERE (c.vehicle_id,c.occurred_on,c.category,c.amount_krw,c.vendor,c.memo)
                = (excluded.vehicle_id,excluded.occurred_on,excluded.category,excluded.amount_krw,excluded.vendor,excluded.memo)
            RETURNING id")
            .bind(uid).bind(c.request_key).bind(device).bind(car).bind(c.occurred_on)
            .bind(c.category).bind(c.amount_krw).bind(c.vendor.trim()).bind(c.memo.trim()).bind(vehicle)
            .fetch_optional(&mut *tx).await.map_err(|e| {
                if e.as_database_error().and_then(|d| d.constraint()) == Some("rental_office_cost_keys_pkey") {
                    AppError::Conflict("이미 삭제된 운영비입니다. 목록을 새로고침해 주세요.".into())
                } else { e.into() }
            })?
    };
    let id = saved.ok_or_else(changed)?;
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
async fn create_cost(
    State(s): State<AppState>,
    u: RentalOwner,
    Json(v): Json<Cost>,
) -> AppResult<Json<Value>> {
    save_cost(&s.db, u.user_id, None, v).await
}
async fn edit_cost(
    State(s): State<AppState>,
    u: RentalOwner,
    Path(id): Path<i64>,
    Json(v): Json<Cost>,
) -> AppResult<Json<Value>> {
    save_cost(&s.db, u.user_id, Some(id), v).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_cursor_preserves_tied_start_times_and_validates_ids() {
        let (start, id) = history_cursor("2021-01-09T11:59:01.123456Z|152").unwrap();
        assert_eq!(start.timestamp_subsec_micros(), 123456);
        assert_eq!(id, 152);
        for value in ["", "2021-01-09|5", "a|1", "2021-01-09T01:00:00Z|0",
                      "2021-01-09T01:00:00Z|-1", "2021-01-09T01:00:00Z|1|2"] {
            assert!(history_cursor(value).is_err());
        }
    }
    #[test]
    fn balances_are_independent_and_cancellation_allows_refunds() {
        assert_eq!(limit("payment", 900, 100, 600, 80, false), 300);
        assert_eq!(limit("deposit_in", 900, 100, 600, 80, false), 20);
        assert_eq!(limit("deposit_out", 900, 100, 600, 80, true), 80);
        assert_eq!(limit("refund", 900, 100, 600, 80, true), 600);
        assert_eq!(limit("payment", 0, 100, 600, 80, true), 0);
        assert_eq!(limit("payment", 900, 100, 600, 80, true), 300);
    }
    #[test]
    fn customer_license_and_rate_validation() {
        let mut c = json!({"kind":"person","phone":"010-1234-5678","license_checked":true});
        assert!(details("customers", &c).is_err());
        c["license_type"] = json!("2종 보통");
        assert!(details("customers", &c).is_ok());
        assert!(details(
            "rates",
            &json!({"daily_krw":123.4,"deposit_krw":1,"coverage_krw":10})
        )
        .is_err());
    }
}
