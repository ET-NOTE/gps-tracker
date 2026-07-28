// (2026-07-28) Stage-R1: 렌트카 (rental) 계약 관리.
//
// account_type='rentcar' 사용자 전용 (프론트 게이팅, 백엔드도 owner 만 접근).
// endpoints:
//   GET    /rentcar/contracts?status=&device_id=&from=&to=  list
//   POST   /rentcar/contracts                               create
//   PATCH  /rentcar/contracts/:id                           update
//   POST   /rentcar/contracts/:id/return                    반납 처리 (정산 자동)
//   DELETE /rentcar/contracts/:id                           delete

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rentcar/contracts", get(list_contracts).post(create_contract))
        .route("/rentcar/contracts/:id", patch(update_contract).delete(delete_contract))
        .route("/rentcar/contracts/:id/return", post(return_contract))
        .route("/rentcar/contracts/:id/invoice.xlsx", get(invoice_xlsx))
}

#[derive(Debug, Serialize, FromRow)]
pub struct Contract {
    pub id:                  i64,
    pub user_id:             i64,
    pub device_id:           i64,
    pub device_name:         Option<String>,
    pub license_plate:       Option<String>,
    pub renter_name:         String,
    pub renter_phone:        Option<String>,
    pub renter_id_last4:     Option<String>,
    pub starts_at:           DateTime<Utc>,
    pub ends_at:             DateTime<Utc>,
    pub rate_type:           String,
    pub rate_amount_krw:     i64,
    pub included_km_per_day: Option<i32>,
    pub over_km_price_krw:   Option<i32>,
    pub deposit_krw:         i64,
    pub return_odometer_km:  Option<i32>,
    pub pickup_odometer_km:  Option<i32>,
    pub settled_amount_krw:  Option<i64>,
    pub settled_at:          Option<DateTime<Utc>>,
    pub pickup_location:     Option<String>,
    pub return_location:     Option<String>,
    pub status:              String,
    pub note:                Option<String>,
    pub created_at:          DateTime<Utc>,
    // (2026-07-28 R4) settlement breakdown
    pub base_fee_krw:        Option<i64>,
    pub late_hours:          Option<i32>,
    pub late_fee_krw:        Option<i64>,
    pub over_km:             Option<i32>,
    pub over_km_fee_krw:     Option<i64>,
    pub extra_fee_krw:       Option<i64>,
    pub refund_krw:          Option<i64>,
    pub returned_at:         Option<DateTime<Utc>>,
    pub settlement_json:     Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct ContractQuery {
    pub status:    Option<String>,
    pub device_id: Option<i64>,
    pub from:      Option<String>,
    pub to:        Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ContractPayload {
    pub device_id:           i64,
    pub renter_name:         String,
    pub renter_phone:        Option<String>,
    pub renter_id_last4:     Option<String>,
    pub starts_at:           DateTime<Utc>,
    pub ends_at:             DateTime<Utc>,
    pub rate_type:           Option<String>,
    pub rate_amount_krw:     Option<i64>,
    pub included_km_per_day: Option<i32>,
    pub over_km_price_krw:   Option<i32>,
    pub deposit_krw:         Option<i64>,
    pub pickup_odometer_km:  Option<i32>,
    pub pickup_location:     Option<String>,
    pub return_location:     Option<String>,
    pub status:              Option<String>,
    pub note:                Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReturnPayload {
    pub return_odometer_km: Option<i32>,
    pub return_location:    Option<String>,
    pub extra_fee_krw:      Option<i64>,
    pub extra_fee_label:    Option<String>,   // (R4) 기타 요금 사유 (세차·파손 등)
    pub returned_at:        Option<DateTime<Utc>>, // (R4) 실제 반납 시각 (null → NOW())
    pub note:               Option<String>,
}

// (R4) 지연 반납 할증 배수 — 1.5배.
const LATE_FEE_MULTIPLIER: f64 = 1.5;

// (R4) rate_type 별 1시간 당 환산 요금 (지연 요금 계산용).
fn hourly_rate(rate_type: &str, rate_amount: i64) -> i64 {
    match rate_type {
        "hourly"  => rate_amount,
        "monthly" => rate_amount / 720,   // 30d × 24h
        _         => rate_amount / 24,    // daily
    }
}

fn fmt_krw(n: i64) -> String {
    let s = n.abs().to_string();
    let b = s.as_bytes();
    let mut out = String::new();
    for (i, c) in b.iter().enumerate() {
        if i > 0 && (b.len() - i) % 3 == 0 { out.push(','); }
        out.push(*c as char);
    }
    if n < 0 { format!("-{out}") } else { out }
}

async fn verify_device_owner(state: &AppState, uid: i64, device_id: i64) -> AppResult<()> {
    let owner: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT owner_id FROM devices WHERE id = $1",
    ).bind(device_id).fetch_optional(&state.db).await?;
    match owner {
        Some(Some(o)) if o == uid => Ok(()),
        _ => Err(AppError::NotFound),
    }
}

async fn list_contracts(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ContractQuery>,
) -> AppResult<Json<Vec<Contract>>> {
    let now = Utc::now();
    let from = q.from.as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc)))
        .unwrap_or_else(|| now - chrono::Duration::days(30));
    let to = q.to.as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc)))
        .unwrap_or_else(|| now + chrono::Duration::days(90));
    let statuses: Option<Vec<String>> = q.status.as_deref().map(|s|
        s.split(',').map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect::<Vec<_>>())
        .filter(|v| !v.is_empty());

    let rows: Vec<Contract> = if let (Some(dev_id), Some(ref sts)) = (q.device_id, statuses.as_ref()) {
        sqlx::query_as(SQL_LIST_DEV_STATUS)
            .bind(user.user_id).bind(dev_id).bind(from).bind(to).bind(sts)
            .fetch_all(&state.db).await?
    } else if let Some(dev_id) = q.device_id {
        sqlx::query_as(SQL_LIST_DEV)
            .bind(user.user_id).bind(dev_id).bind(from).bind(to)
            .fetch_all(&state.db).await?
    } else if let Some(ref sts) = statuses {
        sqlx::query_as(SQL_LIST_STATUS)
            .bind(user.user_id).bind(from).bind(to).bind(sts)
            .fetch_all(&state.db).await?
    } else {
        sqlx::query_as(SQL_LIST_ALL)
            .bind(user.user_id).bind(from).bind(to)
            .fetch_all(&state.db).await?
    };
    Ok(Json(rows))
}

async fn create_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ContractPayload>,
) -> AppResult<Json<Contract>> {
    if req.ends_at <= req.starts_at {
        return Err(AppError::BadRequest("ends_at must be after starts_at".into()));
    }
    if req.renter_name.trim().is_empty() {
        return Err(AppError::BadRequest("renter_name required".into()));
    }
    verify_device_owner(&state, user.user_id, req.device_id).await?;
    let rate_type = req.rate_type.unwrap_or_else(|| "daily".into());
    if !matches!(rate_type.as_str(), "hourly"|"daily"|"monthly") {
        return Err(AppError::BadRequest(format!("invalid rate_type: {rate_type}")));
    }
    let status = req.status.unwrap_or_else(|| "draft".into());
    if !matches!(status.as_str(), "draft"|"active"|"returned"|"overdue"|"cancelled") {
        return Err(AppError::BadRequest(format!("invalid status: {status}")));
    }
    let row: Contract = sqlx::query_as(SQL_INSERT)
        .bind(user.user_id).bind(req.device_id)
        .bind(req.renter_name.trim())
        .bind(req.renter_phone.as_deref())
        .bind(req.renter_id_last4.as_deref())
        .bind(req.starts_at).bind(req.ends_at)
        .bind(&rate_type).bind(req.rate_amount_krw.unwrap_or(0))
        .bind(req.included_km_per_day).bind(req.over_km_price_krw)
        .bind(req.deposit_krw.unwrap_or(0))
        .bind(req.pickup_odometer_km)
        .bind(req.pickup_location.as_deref())
        .bind(req.return_location.as_deref())
        .bind(&status).bind(req.note.as_deref())
        .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn update_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ContractPayload>,
) -> AppResult<Json<Contract>> {
    if req.ends_at <= req.starts_at {
        return Err(AppError::BadRequest("ends_at must be after starts_at".into()));
    }
    let rate_type = req.rate_type.unwrap_or_else(|| "daily".into());
    let status    = req.status.unwrap_or_else(|| "draft".into());
    let row: Option<Contract> = sqlx::query_as(SQL_UPDATE)
        .bind(id).bind(user.user_id).bind(req.device_id)
        .bind(req.renter_name.trim())
        .bind(req.renter_phone.as_deref())
        .bind(req.renter_id_last4.as_deref())
        .bind(req.starts_at).bind(req.ends_at)
        .bind(&rate_type).bind(req.rate_amount_krw.unwrap_or(0))
        .bind(req.included_km_per_day).bind(req.over_km_price_krw)
        .bind(req.deposit_krw.unwrap_or(0))
        .bind(req.pickup_odometer_km)
        .bind(req.pickup_location.as_deref())
        .bind(req.return_location.as_deref())
        .bind(&status).bind(req.note.as_deref())
        .fetch_optional(&state.db).await?;
    Ok(Json(row.ok_or(AppError::NotFound)?))
}

async fn return_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ReturnPayload>,
) -> AppResult<Json<Contract>> {
    #[derive(FromRow)]
    struct Cur {
        rate_type: String, rate_amount_krw: i64,
        starts_at: DateTime<Utc>, ends_at: DateTime<Utc>,
        included_km_per_day: Option<i32>, over_km_price_krw: Option<i32>,
        pickup_odometer_km: Option<i32>,
        deposit_krw: i64,
    }
    let cur: Option<Cur> = sqlx::query_as(
        r#"SELECT rate_type, rate_amount_krw, starts_at, ends_at,
                  included_km_per_day, over_km_price_krw, pickup_odometer_km, deposit_krw
             FROM rental_contracts WHERE id = $1 AND user_id = $2"#,
    ).bind(id).bind(user.user_id).fetch_optional(&state.db).await?;
    let cur = cur.ok_or(AppError::NotFound)?;

    // ── 1. 기본 요금 (계약 기간 × unit rate) ─────────────────────────
    let dur = cur.ends_at - cur.starts_at;
    let (units_raw, unit_label) = match cur.rate_type.as_str() {
        "hourly"  => ((dur.num_minutes() as f64 / 60.0).ceil() as i64, "시간"),
        "monthly" => ((dur.num_days()    as f64 / 30.0).ceil() as i64, "개월"),
        _         => ((dur.num_hours()   as f64 / 24.0).ceil() as i64, "일"),
    };
    let units = units_raw.max(1);
    let base_fee = cur.rate_amount_krw * units;

    // ── 2. 초과 주행 요금 ────────────────────────────────────────────
    let mut over_km_val: i32 = 0;
    let mut over_km_fee: i64 = 0;
    if let (Some(ret_od), Some(pick_od), Some(included_per_day), Some(over_price)) =
        (req.return_odometer_km, cur.pickup_odometer_km, cur.included_km_per_day, cur.over_km_price_krw)
    {
        let driven = (ret_od - pick_od).max(0);
        let days = ((dur.num_hours() as f64 / 24.0).ceil() as i32).max(1);
        let allowed = included_per_day * days;
        over_km_val = (driven - allowed).max(0);
        over_km_fee = (over_km_val as i64) * (over_price as i64);
    }

    // ── 3. 지연 반납 요금 ────────────────────────────────────────────
    let returned_at = req.returned_at.unwrap_or_else(Utc::now);
    let late_hours: i32 = if returned_at > cur.ends_at {
        let d = returned_at - cur.ends_at;
        ((d.num_minutes() as f64 / 60.0).ceil() as i32).max(0)
    } else { 0 };
    let hourly = hourly_rate(&cur.rate_type, cur.rate_amount_krw);
    let late_fee: i64 = if late_hours > 0 {
        ((late_hours as f64) * (hourly as f64) * LATE_FEE_MULTIPLIER).round() as i64
    } else { 0 };

    // ── 4. 기타 (수동 입력) ──────────────────────────────────────────
    let extra_fee = req.extra_fee_krw.unwrap_or(0);
    let extra_label = req.extra_fee_label.clone().unwrap_or_else(|| "기타".into());

    // ── 5. 합계 · 환급 ───────────────────────────────────────────────
    let subtotal = base_fee + over_km_fee + late_fee + extra_fee;
    // refund > 0 = 임차인에게 환급, refund < 0 = 임차인이 추가 청구
    let refund = cur.deposit_krw - subtotal;

    // ── 6. line items JSON (invoice 재현용) ──────────────────────────
    let mut lines: Vec<Value> = Vec::new();
    lines.push(json!({
        "kind": "base",
        "label": format!("기본 요금 ({units}{unit_label} × {}원)", fmt_krw(cur.rate_amount_krw)),
        "amount": base_fee,
    }));
    if over_km_val > 0 && over_km_fee > 0 {
        let over_price = cur.over_km_price_krw.unwrap_or(0);
        lines.push(json!({
            "kind": "over_km",
            "label": format!("초과 주행 ({over_km_val}km × {}원)", fmt_krw(over_price as i64)),
            "amount": over_km_fee,
        }));
    }
    if late_hours > 0 && late_fee > 0 {
        lines.push(json!({
            "kind": "late",
            "label": format!("지연 반납 ({late_hours}시간 × {}원 × {}배)",
                fmt_krw(hourly), LATE_FEE_MULTIPLIER),
            "amount": late_fee,
        }));
    }
    if extra_fee != 0 {
        lines.push(json!({
            "kind": "extra",
            "label": extra_label,
            "amount": extra_fee,
        }));
    }
    let settlement = json!({
        "lines": lines,
        "subtotal": subtotal,
        "deposit": cur.deposit_krw,
        "balance": refund,
    });

    let row: Contract = sqlx::query_as(
        r#"WITH upd AS (
            UPDATE rental_contracts
               SET status = 'returned',
                   return_odometer_km = COALESCE($3, return_odometer_km),
                   return_location    = COALESCE($4, return_location),
                   settled_amount_krw = $5,
                   settled_at         = NOW(),
                   note               = COALESCE($6, note),
                   base_fee_krw       = $7,
                   late_hours         = $8,
                   late_fee_krw       = $9,
                   over_km            = $10,
                   over_km_fee_krw    = $11,
                   extra_fee_krw      = $12,
                   refund_krw         = $13,
                   returned_at        = $14,
                   settlement_json    = $15,
                   updated_at         = NOW()
             WHERE id = $1 AND user_id = $2
             RETURNING *
        )
        SELECT upd.id, upd.user_id, upd.device_id,
               d.display_name  AS device_name,
               d.license_plate AS license_plate,
               upd.renter_name, upd.renter_phone, upd.renter_id_last4,
               upd.starts_at, upd.ends_at,
               upd.rate_type, upd.rate_amount_krw, upd.included_km_per_day, upd.over_km_price_krw,
               upd.deposit_krw, upd.return_odometer_km, upd.pickup_odometer_km,
               upd.settled_amount_krw, upd.settled_at, upd.pickup_location, upd.return_location,
               upd.status, upd.note, upd.created_at,
               upd.base_fee_krw, upd.late_hours, upd.late_fee_krw, upd.over_km, upd.over_km_fee_krw,
               upd.extra_fee_krw, upd.refund_krw, upd.returned_at, upd.settlement_json
          FROM upd
     LEFT JOIN devices d ON d.id = upd.device_id"#,
    )
    .bind(id).bind(user.user_id)
    .bind(req.return_odometer_km).bind(req.return_location.as_deref())
    .bind(subtotal).bind(req.note.as_deref())
    .bind(base_fee).bind(late_hours).bind(late_fee)
    .bind(over_km_val).bind(over_km_fee)
    .bind(extra_fee).bind(refund).bind(returned_at)
    .bind(&settlement)
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn delete_contract(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let n = sqlx::query("DELETE FROM rental_contracts WHERE id = $1 AND user_id = $2")
        .bind(id).bind(user.user_id).execute(&state.db).await?.rows_affected();
    if n == 0 { return Err(AppError::NotFound); }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// (R4) GET /rentcar/contracts/:id/invoice.xlsx — 반납 완료 계약 청구서.
// settlement_json 기반으로 line item · 소계 · 보증금 · 잔액 렌더링.
async fn invoice_xlsx(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    let row: Option<Contract> = sqlx::query_as(SQL_INVOICE_SELECT)
        .bind(id).bind(user.user_id)
        .fetch_optional(&state.db).await?;
    let c = row.ok_or(AppError::NotFound)?;
    if c.status != "returned" {
        return Err(AppError::BadRequest("아직 반납되지 않은 계약입니다".into()));
    }
    // 회사(임대인) 정보 최소 조회.
    let corp: Option<CorpLite> = sqlx::query_as(
        r#"SELECT company_name, business_number, representative, address
             FROM corporate_info WHERE user_id = $1"#,
    ).bind(user.user_id).fetch_optional(&state.db).await.ok().flatten();

    let bytes = build_invoice_xlsx(&c, corp.as_ref())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("xlsx: {e}")))?;

    let plate = c.license_plate.clone().unwrap_or_else(|| c.device_id.to_string());
    let fname = format!("청구서_{}_{}_{}.xlsx",
        plate,
        c.renter_name,
        c.settled_at.map(|d| d.format("%Y%m%d").to_string()).unwrap_or_else(|| "unknown".into()));
    // RFC5987 filename* — 한글 포함.
    let enc = url_encode(&fname);
    let cd = format!("attachment; filename=\"invoice.xlsx\"; filename*=UTF-8''{enc}");

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    headers.insert(header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&cd).unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"invoice.xlsx\"")));
    Ok((StatusCode::OK, headers, bytes).into_response())
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z'|b'a'..=b'z'|b'0'..=b'9'|b'-'|b'_'|b'.'|b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[derive(FromRow)]
struct CorpLite {
    company_name:    Option<String>,
    business_number: Option<String>,
    representative:  Option<String>,
    address:         Option<String>,
}

fn build_invoice_xlsx(c: &Contract, corp: Option<&CorpLite>) -> Result<Vec<u8>, rust_xlsxwriter::XlsxError> {
    use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("청구서")?;
    ws.set_column_width(0, 4.0)?;
    ws.set_column_width(1, 20.0)?;
    ws.set_column_width(2, 40.0)?;
    ws.set_column_width(3, 18.0)?;
    ws.set_column_width(4, 4.0)?;

    let title_fmt = Format::new().set_bold().set_font_size(20).set_align(FormatAlign::Center);
    let sub_fmt   = Format::new().set_align(FormatAlign::Center).set_font_color(Color::RGB(0x666666));
    let label_fmt = Format::new().set_bold().set_background_color(Color::RGB(0xF5F5F7))
                     .set_border(FormatBorder::Thin).set_align(FormatAlign::Center);
    let value_fmt = Format::new().set_border(FormatBorder::Thin);
    let value_r   = Format::new().set_border(FormatBorder::Thin).set_align(FormatAlign::Right).set_num_format("#,##0");
    let line_hdr  = Format::new().set_bold().set_background_color(Color::RGB(0xEEF2FF))
                     .set_border(FormatBorder::Thin).set_align(FormatAlign::Center);
    let total_l   = Format::new().set_bold().set_background_color(Color::RGB(0xF5F5F7))
                     .set_border(FormatBorder::Thin).set_align(FormatAlign::Right);
    let total_v   = Format::new().set_bold().set_border(FormatBorder::Thin)
                     .set_align(FormatAlign::Right).set_num_format("#,##0");
    let refund_l  = Format::new().set_bold().set_background_color(Color::RGB(0xDCFCE7))
                     .set_border(FormatBorder::Thin).set_align(FormatAlign::Right);
    let refund_v  = Format::new().set_bold().set_background_color(Color::RGB(0xDCFCE7))
                     .set_border(FormatBorder::Thin).set_align(FormatAlign::Right).set_num_format("#,##0");
    let charge_l  = Format::new().set_bold().set_background_color(Color::RGB(0xFEE2E2))
                     .set_border(FormatBorder::Thin).set_align(FormatAlign::Right);
    let charge_v  = Format::new().set_bold().set_background_color(Color::RGB(0xFEE2E2))
                     .set_border(FormatBorder::Thin).set_align(FormatAlign::Right).set_num_format("#,##0");

    // ── 타이틀 ───────────────────────────────────────
    ws.merge_range(0, 1, 0, 3, "렌 트 카   청 구 서", &title_fmt)?;
    ws.set_row_height(0, 32.0)?;
    let settled_ymd = c.settled_at.map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
    ws.merge_range(1, 1, 1, 3, &format!("발행일: {}", settled_ymd), &sub_fmt)?;

    // ── 임대인 (회사) ─────────────────────────────────
    let mut r: u32 = 3;
    ws.merge_range(r, 1, r, 3, "임대인 (공급자)", &line_hdr)?;
    r += 1;
    if let Some(cp) = corp {
        let opt = |s: &Option<String>| s.as_deref().unwrap_or("-").to_string();
        ws.write_string_with_format(r, 1, "회사명", &label_fmt)?;
        ws.merge_range(r, 2, r, 3, &opt(&cp.company_name), &value_fmt)?;
        r += 1;
        ws.write_string_with_format(r, 1, "사업자번호", &label_fmt)?;
        ws.merge_range(r, 2, r, 3, &opt(&cp.business_number), &value_fmt)?;
        r += 1;
        ws.write_string_with_format(r, 1, "대표자", &label_fmt)?;
        ws.merge_range(r, 2, r, 3, &opt(&cp.representative), &value_fmt)?;
        r += 1;
        ws.write_string_with_format(r, 1, "주소", &label_fmt)?;
        ws.merge_range(r, 2, r, 3, &opt(&cp.address), &value_fmt)?;
        r += 1;
    } else {
        ws.write_string_with_format(r, 1, "회사 정보", &label_fmt)?;
        ws.merge_range(r, 2, r, 3, "(회사 정보 페이지에서 입력해주세요)", &value_fmt)?;
        r += 1;
    }

    // ── 임차인 ────────────────────────────────────────
    r += 1;
    ws.merge_range(r, 1, r, 3, "임차인", &line_hdr)?;
    r += 1;
    ws.write_string_with_format(r, 1, "성명", &label_fmt)?;
    ws.merge_range(r, 2, r, 3, c.renter_name.as_str(), &value_fmt)?;
    r += 1;
    ws.write_string_with_format(r, 1, "연락처", &label_fmt)?;
    ws.merge_range(r, 2, r, 3, c.renter_phone.as_deref().unwrap_or("-"), &value_fmt)?;
    r += 1;
    ws.write_string_with_format(r, 1, "신분증 뒤4", &label_fmt)?;
    ws.merge_range(r, 2, r, 3, c.renter_id_last4.as_deref().unwrap_or("-"), &value_fmt)?;
    r += 1;

    // ── 계약 정보 ────────────────────────────────────
    r += 1;
    ws.merge_range(r, 1, r, 3, "계약 정보", &line_hdr)?;
    r += 1;
    ws.write_string_with_format(r, 1, "차량", &label_fmt)?;
    let vehicle = format!("{} ({})",
        c.device_name.as_deref().unwrap_or("-"),
        c.license_plate.as_deref().unwrap_or("-"));
    ws.merge_range(r, 2, r, 3, &vehicle, &value_fmt)?;
    r += 1;
    ws.write_string_with_format(r, 1, "계약 시작", &label_fmt)?;
    ws.merge_range(r, 2, r, 3, &c.starts_at.format("%Y-%m-%d %H:%M").to_string(), &value_fmt)?;
    r += 1;
    ws.write_string_with_format(r, 1, "계약 종료", &label_fmt)?;
    ws.merge_range(r, 2, r, 3, &c.ends_at.format("%Y-%m-%d %H:%M").to_string(), &value_fmt)?;
    r += 1;
    ws.write_string_with_format(r, 1, "실제 반납", &label_fmt)?;
    let ret_s = c.returned_at.map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".into());
    ws.merge_range(r, 2, r, 3, &ret_s, &value_fmt)?;
    r += 1;
    if c.pickup_odometer_km.is_some() || c.return_odometer_km.is_some() {
        ws.write_string_with_format(r, 1, "주행거리", &label_fmt)?;
        let pick = c.pickup_odometer_km.unwrap_or(0);
        let ret  = c.return_odometer_km.unwrap_or(0);
        let s = format!("{} → {} km ({}km)", pick, ret, (ret - pick).max(0));
        ws.merge_range(r, 2, r, 3, &s, &value_fmt)?;
        r += 1;
    }

    // ── 정산 line items ──────────────────────────────
    r += 1;
    ws.merge_range(r, 1, r, 3, "정산 내역", &line_hdr)?;
    r += 1;
    ws.write_string_with_format(r, 1, "항목", &label_fmt)?;
    ws.write_string_with_format(r, 2, "설명",  &label_fmt)?;
    ws.write_string_with_format(r, 3, "금액(원)", &label_fmt)?;
    r += 1;
    if let Some(Value::Object(map)) = c.settlement_json.as_ref().map(|v| v.clone()).map(|v| v)
        .and_then(|v| if v.is_object() { Some(v) } else { None })
    {
        if let Some(Value::Array(arr)) = map.get("lines") {
            for line in arr {
                let kind  = line.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                let label = line.get("label").and_then(|v| v.as_str()).unwrap_or("");
                let amt   = line.get("amount").and_then(|v| v.as_i64()).unwrap_or(0);
                let kind_ko = match kind {
                    "base"    => "기본료",
                    "over_km" => "초과주행",
                    "late"    => "지연반납",
                    "extra"   => "기타",
                    _ => kind,
                };
                ws.write_string_with_format(r, 1, kind_ko, &value_fmt)?;
                ws.write_string_with_format(r, 2, label,   &value_fmt)?;
                ws.write_number_with_format(r, 3, amt as f64, &value_r)?;
                r += 1;
            }
        }
    }
    // ── 소계 · 보증금 · 잔액 ────────────────────────
    let subtotal = c.settled_amount_krw.unwrap_or(0);
    let deposit  = c.deposit_krw;
    let balance  = c.refund_krw.unwrap_or(deposit - subtotal);
    ws.merge_range(r, 1, r, 2, "소계", &total_l)?;
    ws.write_number_with_format(r, 3, subtotal as f64, &total_v)?;
    r += 1;
    ws.merge_range(r, 1, r, 2, "보증금", &total_l)?;
    ws.write_number_with_format(r, 3, deposit as f64, &total_v)?;
    r += 1;
    if balance >= 0 {
        ws.merge_range(r, 1, r, 2, "환급액 (임차인 → 지급)", &refund_l)?;
        ws.write_number_with_format(r, 3, balance as f64, &refund_v)?;
    } else {
        ws.merge_range(r, 1, r, 2, "추가 청구 (임차인 → 수취)", &charge_l)?;
        ws.write_number_with_format(r, 3, (-balance) as f64, &charge_v)?;
    }

    let buf = wb.save_to_buffer()?;
    Ok(buf)
}

const SQL_INVOICE_SELECT: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at,
    c.base_fee_krw, c.late_hours, c.late_fee_krw, c.over_km, c.over_km_fee_krw,
    c.extra_fee_krw, c.refund_krw, c.returned_at, c.settlement_json
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.id = $1 AND c.user_id = $2";

const SQL_LIST_ALL: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at,
    c.base_fee_krw, c.late_hours, c.late_fee_krw, c.over_km, c.over_km_fee_krw,
    c.extra_fee_krw, c.refund_krw, c.returned_at, c.settlement_json
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.starts_at < $3 AND c.ends_at > $2
    ORDER BY c.starts_at DESC";
const SQL_LIST_DEV: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at,
    c.base_fee_krw, c.late_hours, c.late_fee_krw, c.over_km, c.over_km_fee_krw,
    c.extra_fee_krw, c.refund_krw, c.returned_at, c.settlement_json
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.device_id = $2 AND c.starts_at < $4 AND c.ends_at > $3
    ORDER BY c.starts_at DESC";
const SQL_LIST_STATUS: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at,
    c.base_fee_krw, c.late_hours, c.late_fee_krw, c.over_km, c.over_km_fee_krw,
    c.extra_fee_krw, c.refund_krw, c.returned_at, c.settlement_json
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.starts_at < $3 AND c.ends_at > $2 AND c.status = ANY($4::TEXT[])
    ORDER BY c.starts_at DESC";
const SQL_LIST_DEV_STATUS: &str = "SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
    c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
    c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
    c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
    c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
    c.status, c.note, c.created_at,
    c.base_fee_krw, c.late_hours, c.late_fee_krw, c.over_km, c.over_km_fee_krw,
    c.extra_fee_krw, c.refund_krw, c.returned_at, c.settlement_json
    FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.user_id = $1 AND c.device_id = $2 AND c.starts_at < $4 AND c.ends_at > $3
      AND c.status = ANY($5::TEXT[])
    ORDER BY c.starts_at DESC";

const SQL_INSERT: &str = r#"WITH ins AS (
    INSERT INTO rental_contracts
        (user_id, device_id, renter_name, renter_phone, renter_id_last4,
         starts_at, ends_at, rate_type, rate_amount_krw,
         included_km_per_day, over_km_price_krw, deposit_krw,
         pickup_odometer_km, pickup_location, return_location,
         status, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING *
)
SELECT ins.id, ins.user_id, ins.device_id,
       d.display_name  AS device_name,
       d.license_plate AS license_plate,
       ins.renter_name, ins.renter_phone, ins.renter_id_last4,
       ins.starts_at, ins.ends_at,
       ins.rate_type, ins.rate_amount_krw, ins.included_km_per_day, ins.over_km_price_krw,
       ins.deposit_krw, ins.return_odometer_km, ins.pickup_odometer_km,
       ins.settled_amount_krw, ins.settled_at, ins.pickup_location, ins.return_location,
       ins.status, ins.note, ins.created_at,
       ins.base_fee_krw, ins.late_hours, ins.late_fee_krw, ins.over_km, ins.over_km_fee_krw,
       ins.extra_fee_krw, ins.refund_krw, ins.returned_at, ins.settlement_json
  FROM ins
LEFT JOIN devices d ON d.id = ins.device_id"#;

const SQL_UPDATE: &str = r#"WITH upd AS (
    UPDATE rental_contracts SET
        device_id = $3, renter_name = $4, renter_phone = $5, renter_id_last4 = $6,
        starts_at = $7, ends_at = $8,
        rate_type = $9, rate_amount_krw = $10,
        included_km_per_day = $11, over_km_price_krw = $12, deposit_krw = $13,
        pickup_odometer_km = $14, pickup_location = $15, return_location = $16,
        status = $17, note = $18,
        updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING *
)
SELECT upd.id, upd.user_id, upd.device_id,
       d.display_name  AS device_name,
       d.license_plate AS license_plate,
       upd.renter_name, upd.renter_phone, upd.renter_id_last4,
       upd.starts_at, upd.ends_at,
       upd.rate_type, upd.rate_amount_krw, upd.included_km_per_day, upd.over_km_price_krw,
       upd.deposit_krw, upd.return_odometer_km, upd.pickup_odometer_km,
       upd.settled_amount_krw, upd.settled_at, upd.pickup_location, upd.return_location,
       upd.status, upd.note, upd.created_at,
       upd.base_fee_krw, upd.late_hours, upd.late_fee_krw, upd.over_km, upd.over_km_fee_krw,
       upd.extra_fee_krw, upd.refund_krw, upd.returned_at, upd.settlement_json
  FROM upd
LEFT JOIN devices d ON d.id = upd.device_id"#;
