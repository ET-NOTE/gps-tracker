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
        // (R6) 임차인
        .route("/rentcar/renters",             get(list_renters))
        .route("/rentcar/renters/:phone",      get(renter_detail))
        .route("/rentcar/blacklist",           get(list_blacklist).post(add_blacklist))
        .route("/rentcar/blacklist/:id",       axum::routing::delete(remove_blacklist))
        .route("/rentcar/blacklist/check",     get(check_blacklist))
        // (R9-a) 인수/반납 QR 토큰 발급 + 사진 조회 (owner)
        .route("/rentcar/contracts/:id/handoff-tokens", get(list_handoff_tokens).post(issue_handoff_token))
        .route("/rentcar/handoff-tokens/:id",           axum::routing::delete(revoke_handoff_token))
        .route("/rentcar/photos/:id",                   get(get_photo).delete(delete_photo))
        // (R9-a 확장) owner 가 계약별 사진 (파손·연료·오도미터) 업로드/조회 갤러리
        .route("/rentcar/contracts/:id/photos",         get(list_photos).post(upload_photo))
        // (R9-a) public — 임차인 auth-free 링크
        .route("/rentcar/handoff/:token",               get(handoff_view))
        .route("/rentcar/handoff/:token/submit",        post(handoff_submit))
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

// ═══════════════════════════════════════════════════════════════
// (2026-07-28) Stage-R6: 임차인 registry (파생) + 블랙리스트.
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, FromRow)]
pub struct RenterSummary {
    pub renter_phone:    String,
    pub renter_name:     Option<String>,
    pub contracts_count: i64,
    pub returned_count:  i64,
    pub overdue_count:   i64,
    pub late_count:      i64,
    pub total_revenue:   i64,
    pub first_at:        DateTime<Utc>,
    pub last_at:         DateTime<Utc>,
    pub blacklisted:     bool,
    pub blacklist_severity: Option<String>,
    pub blacklist_reason:   Option<String>,
}

async fn list_renters(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<RenterSummary>>> {
    let rows: Vec<RenterSummary> = sqlx::query_as(
        r#"WITH agg AS (
            SELECT c.renter_phone,
                   MAX(c.renter_name) FILTER (WHERE c.renter_name <> '') AS renter_name,
                   COUNT(*)::BIGINT                                     AS contracts_count,
                   COUNT(*) FILTER (WHERE c.status = 'returned')::BIGINT AS returned_count,
                   COUNT(*) FILTER (WHERE c.status = 'overdue' )::BIGINT AS overdue_count,
                   COUNT(*) FILTER (WHERE COALESCE(c.late_hours,0) > 0)::BIGINT AS late_count,
                   COALESCE(SUM(c.settled_amount_krw), 0)::BIGINT       AS total_revenue,
                   MIN(c.starts_at) AS first_at,
                   MAX(c.starts_at) AS last_at
              FROM rental_contracts c
             WHERE c.user_id = $1 AND c.renter_phone IS NOT NULL AND c.renter_phone <> ''
          GROUP BY c.renter_phone
        )
        SELECT a.renter_phone, a.renter_name,
               a.contracts_count, a.returned_count, a.overdue_count, a.late_count,
               a.total_revenue, a.first_at, a.last_at,
               (b.id IS NOT NULL)  AS blacklisted,
               b.severity          AS blacklist_severity,
               b.reason            AS blacklist_reason
          FROM agg a
     LEFT JOIN renter_blacklist b
            ON b.user_id = $1 AND b.renter_phone = a.renter_phone
         ORDER BY a.last_at DESC"#,
    ).bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

async fn renter_detail(
    State(state): State<AppState>,
    user: AuthUser,
    Path(phone): Path<String>,
) -> AppResult<Json<Value>> {
    // 통계
    let summary: Option<RenterSummary> = sqlx::query_as(
        r#"WITH agg AS (
            SELECT c.renter_phone,
                   MAX(c.renter_name) FILTER (WHERE c.renter_name <> '') AS renter_name,
                   COUNT(*)::BIGINT                                     AS contracts_count,
                   COUNT(*) FILTER (WHERE c.status = 'returned')::BIGINT AS returned_count,
                   COUNT(*) FILTER (WHERE c.status = 'overdue' )::BIGINT AS overdue_count,
                   COUNT(*) FILTER (WHERE COALESCE(c.late_hours,0) > 0)::BIGINT AS late_count,
                   COALESCE(SUM(c.settled_amount_krw), 0)::BIGINT       AS total_revenue,
                   MIN(c.starts_at) AS first_at,
                   MAX(c.starts_at) AS last_at
              FROM rental_contracts c
             WHERE c.user_id = $1 AND c.renter_phone = $2
          GROUP BY c.renter_phone
        )
        SELECT a.renter_phone, a.renter_name,
               a.contracts_count, a.returned_count, a.overdue_count, a.late_count,
               a.total_revenue, a.first_at, a.last_at,
               (b.id IS NOT NULL)  AS blacklisted,
               b.severity          AS blacklist_severity,
               b.reason            AS blacklist_reason
          FROM agg a
     LEFT JOIN renter_blacklist b
            ON b.user_id = $1 AND b.renter_phone = a.renter_phone"#,
    ).bind(user.user_id).bind(&phone).fetch_optional(&state.db).await?;
    let summary = summary.ok_or(AppError::NotFound)?;

    // 계약 이력 (최대 100건, 최신순)
    let contracts: Vec<Contract> = sqlx::query_as(
        r#"SELECT c.id, c.user_id, c.device_id, d.display_name AS device_name, d.license_plate,
                  c.renter_name, c.renter_phone, c.renter_id_last4, c.starts_at, c.ends_at,
                  c.rate_type, c.rate_amount_krw, c.included_km_per_day, c.over_km_price_krw,
                  c.deposit_krw, c.return_odometer_km, c.pickup_odometer_km,
                  c.settled_amount_krw, c.settled_at, c.pickup_location, c.return_location,
                  c.status, c.note, c.created_at,
                  c.base_fee_krw, c.late_hours, c.late_fee_krw, c.over_km, c.over_km_fee_krw,
                  c.extra_fee_krw, c.refund_krw, c.returned_at, c.settlement_json
             FROM rental_contracts c LEFT JOIN devices d ON d.id = c.device_id
            WHERE c.user_id = $1 AND c.renter_phone = $2
         ORDER BY c.starts_at DESC LIMIT 100"#,
    ).bind(user.user_id).bind(&phone).fetch_all(&state.db).await?;

    Ok(Json(json!({ "summary": summary, "contracts": contracts })))
}

#[derive(Debug, Serialize, FromRow)]
pub struct BlacklistEntry {
    pub id:            i64,
    pub user_id:       i64,
    pub renter_phone:  String,
    pub renter_name:   Option<String>,
    pub reason:        String,
    pub severity:      String,
    pub created_at:    DateTime<Utc>,
    pub created_by:    Option<i64>,
}

async fn list_blacklist(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<BlacklistEntry>>> {
    let rows: Vec<BlacklistEntry> = sqlx::query_as(
        r#"SELECT id, user_id, renter_phone, renter_name, reason, severity, created_at, created_by
             FROM renter_blacklist WHERE user_id = $1 ORDER BY created_at DESC"#,
    ).bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct BlacklistPayload {
    pub renter_phone: String,
    pub renter_name:  Option<String>,
    pub reason:       String,
    pub severity:     Option<String>,  // 'warn' (default) | 'block'
}

async fn add_blacklist(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<BlacklistPayload>,
) -> AppResult<Json<BlacklistEntry>> {
    if req.renter_phone.trim().is_empty() {
        return Err(AppError::BadRequest("renter_phone required".into()));
    }
    if req.reason.trim().is_empty() {
        return Err(AppError::BadRequest("reason required".into()));
    }
    let sev = req.severity.unwrap_or_else(|| "warn".into());
    if !matches!(sev.as_str(), "warn"|"block") {
        return Err(AppError::BadRequest(format!("invalid severity: {sev}")));
    }
    let row: BlacklistEntry = sqlx::query_as(
        r#"INSERT INTO renter_blacklist (user_id, renter_phone, renter_name, reason, severity, created_by)
           VALUES ($1, $2, $3, $4, $5, $1)
           ON CONFLICT (user_id, renter_phone)
           DO UPDATE SET reason = EXCLUDED.reason,
                         severity = EXCLUDED.severity,
                         renter_name = COALESCE(EXCLUDED.renter_name, renter_blacklist.renter_name)
           RETURNING id, user_id, renter_phone, renter_name, reason, severity, created_at, created_by"#,
    )
    .bind(user.user_id).bind(req.renter_phone.trim())
    .bind(req.renter_name.as_deref())
    .bind(req.reason.trim()).bind(&sev)
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn remove_blacklist(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let n = sqlx::query("DELETE FROM renter_blacklist WHERE id = $1 AND user_id = $2")
        .bind(id).bind(user.user_id).execute(&state.db).await?.rows_affected();
    if n == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct CheckQuery {
    pub phone: String,
}

async fn check_blacklist(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<CheckQuery>,
) -> AppResult<Json<Value>> {
    let entry: Option<BlacklistEntry> = sqlx::query_as(
        r#"SELECT id, user_id, renter_phone, renter_name, reason, severity, created_at, created_by
             FROM renter_blacklist WHERE user_id = $1 AND renter_phone = $2"#,
    ).bind(user.user_id).bind(q.phone.trim()).fetch_optional(&state.db).await?;

    // 재방문 여부 — 이 phone 으로 계약 몇 건?
    let visits: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::BIGINT FROM rental_contracts
            WHERE user_id = $1 AND renter_phone = $2"#,
    ).bind(user.user_id).bind(q.phone.trim()).fetch_one(&state.db).await.unwrap_or(0);

    Ok(Json(json!({
        "blacklisted": entry.is_some(),
        "entry":       entry,
        "visits":      visits,
    })))
}

// ═══════════════════════════════════════════════════════════════
// (2026-07-28) Stage-R9-a: 렌트카 인수/반납 QR self-handoff.
//   1) owner 가 계약에 대해 handoff token 발급 → 카톡 등으로 링크 전송
//   2) 임차인이 로그인 없이 링크 열어 오도미터 사진 + 서명 제출
//   3) pickup → status active + pickup_odometer/photo/signature 확정
//      return → status returned + return_odometer/photo/signature + settlement 계산
// ═══════════════════════════════════════════════════════════════

const HANDOFF_DEFAULT_TTL_HOURS: i64 = 72;
const HANDOFF_MAX_PHOTO_BYTES:   usize = 4 * 1024 * 1024;  // 4MB

fn generate_handoff_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];   // 128 bit → base64 22자
    rand::thread_rng().fill_bytes(&mut buf);
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(22);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in &buf {
        acc = (acc << 8) | (b as u32);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(ALPHABET[((acc >> bits) & 0x3F) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (6 - bits)) & 0x3F) as usize] as char);
    }
    out
}

#[derive(Debug, Serialize, FromRow)]
pub struct HandoffToken {
    pub id:          i64,
    pub contract_id: i64,
    pub user_id:     i64,
    pub purpose:     String,
    pub token:       String,
    pub created_at:  DateTime<Utc>,
    pub expires_at:  DateTime<Utc>,
    pub used_at:     Option<DateTime<Utc>>,
    pub revoked_at:  Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct IssueTokenPayload {
    pub purpose:       String,             // pickup | return
    pub expires_hours: Option<i64>,        // 기본 72
}

async fn issue_handoff_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path(contract_id): Path<i64>,
    Json(req): Json<IssueTokenPayload>,
) -> AppResult<Json<HandoffToken>> {
    if !matches!(req.purpose.as_str(), "pickup"|"return") {
        return Err(AppError::BadRequest("purpose must be pickup or return".into()));
    }
    let hours = req.expires_hours.unwrap_or(HANDOFF_DEFAULT_TTL_HOURS).clamp(1, 720);
    // 소유권 확인
    let owner_check: Option<i64> = sqlx::query_scalar(
        "SELECT user_id FROM rental_contracts WHERE id = $1"
    ).bind(contract_id).fetch_optional(&state.db).await?;
    match owner_check {
        Some(uid) if uid == user.user_id => {}
        _ => return Err(AppError::NotFound),
    }
    let token = generate_handoff_token();
    let expires_at = Utc::now() + chrono::Duration::hours(hours);
    let row: HandoffToken = sqlx::query_as(
        r#"INSERT INTO rental_handoff_tokens (contract_id, user_id, purpose, token, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, contract_id, user_id, purpose, token, created_at, expires_at, used_at, revoked_at"#,
    )
    .bind(contract_id).bind(user.user_id).bind(&req.purpose).bind(&token).bind(expires_at)
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn list_handoff_tokens(
    State(state): State<AppState>,
    user: AuthUser,
    Path(contract_id): Path<i64>,
) -> AppResult<Json<Vec<HandoffToken>>> {
    // 소유권 확인은 SQL 조건으로
    let rows: Vec<HandoffToken> = sqlx::query_as(
        r#"SELECT id, contract_id, user_id, purpose, token, created_at, expires_at, used_at, revoked_at
             FROM rental_handoff_tokens
            WHERE contract_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 20"#,
    ).bind(contract_id).bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

async fn revoke_handoff_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let n = sqlx::query(
        r#"UPDATE rental_handoff_tokens
              SET revoked_at = NOW()
            WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND used_at IS NULL"#,
    ).bind(id).bind(user.user_id).execute(&state.db).await?.rows_affected();
    if n == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({ "ok": true })))
}

// ─── public — 임차인 auth-free 뷰 ─────────────────────

#[derive(Debug, Serialize)]
struct HandoffView {
    purpose:         String,
    status:          String,      // "ready" | "used" | "revoked" | "expired"
    contract_id:     i64,
    company_name:    Option<String>,
    device_name:     Option<String>,
    license_plate:   Option<String>,
    renter_name:     String,
    starts_at:       DateTime<Utc>,
    ends_at:         DateTime<Utc>,
    rate_type:       String,
    rate_amount_krw: i64,
    deposit_krw:     i64,
    pickup_odometer_km: Option<i32>,   // return purpose 시 참고용
    used_at:         Option<DateTime<Utc>>,
    submitted_photo_id: Option<i64>,   // used 시 photo 조회용
}

async fn load_handoff_by_token(pool: &sqlx::PgPool, token: &str) -> AppResult<HandoffView> {
    #[derive(FromRow)]
    struct Row {
        contract_id: i64,
        user_id: i64,
        purpose: String,
        expires_at: DateTime<Utc>,
        used_at: Option<DateTime<Utc>>,
        revoked_at: Option<DateTime<Utc>>,
        device_name: Option<String>,
        license_plate: Option<String>,
        renter_name: String,
        starts_at: DateTime<Utc>,
        ends_at: DateTime<Utc>,
        rate_type: String,
        rate_amount_krw: i64,
        deposit_krw: i64,
        pickup_odometer_km: Option<i32>,
    }
    let r: Option<Row> = sqlx::query_as(
        r#"SELECT t.contract_id, t.user_id, t.purpose, t.expires_at, t.used_at, t.revoked_at,
                  d.display_name AS device_name, d.license_plate,
                  c.renter_name, c.starts_at, c.ends_at, c.rate_type, c.rate_amount_krw,
                  c.deposit_krw, c.pickup_odometer_km
             FROM rental_handoff_tokens t
             JOIN rental_contracts c ON c.id = t.contract_id
        LEFT JOIN devices d ON d.id = c.device_id
            WHERE t.token = $1"#,
    ).bind(token).fetch_optional(pool).await?;
    let r = r.ok_or(AppError::NotFound)?;

    let status = if r.revoked_at.is_some()          { "revoked" }
                 else if r.used_at.is_some()        { "used" }
                 else if r.expires_at <= Utc::now() { "expired" }
                 else                               { "ready" };

    // used 이면 임차인이 제출한 사진 id (동일 purpose)
    let submitted_photo_id: Option<i64> = if status == "used" {
        let kind = if r.purpose == "pickup" { "pickup_odometer" } else { "return_odometer" };
        sqlx::query_scalar(
            r#"SELECT id FROM rental_photos
                WHERE contract_id = $1 AND kind = $2
             ORDER BY uploaded_at DESC LIMIT 1"#,
        ).bind(r.contract_id).bind(kind).fetch_optional(pool).await.ok().flatten()
    } else { None };

    // owner 회사명
    let company_name: Option<String> = sqlx::query_scalar(
        "SELECT company_name FROM corporate_info WHERE user_id = $1"
    ).bind(r.user_id).fetch_optional(pool).await.ok().flatten();

    Ok(HandoffView {
        purpose: r.purpose,
        status: status.to_string(),
        contract_id: r.contract_id,
        company_name,
        device_name: r.device_name,
        license_plate: r.license_plate,
        renter_name: r.renter_name,
        starts_at: r.starts_at,
        ends_at: r.ends_at,
        rate_type: r.rate_type,
        rate_amount_krw: r.rate_amount_krw,
        deposit_krw: r.deposit_krw,
        pickup_odometer_km: r.pickup_odometer_km,
        used_at: r.used_at,
        submitted_photo_id,
    })
}

async fn handoff_view(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<Json<HandoffView>> {
    let v = load_handoff_by_token(&state.db, &token).await?;
    Ok(Json(v))
}

#[derive(Debug, Deserialize)]
pub struct HandoffExtraPhoto {
    pub kind:     String,   // 'damage' | 'fuel' — purpose 와 결합해 DB kind 로 매핑
    pub data_url: String,
}

#[derive(Debug, Deserialize)]
pub struct HandoffSubmitPayload {
    pub odometer_km:      i32,
    pub signature_svg:    String,       // SVG dataURL 또는 raw <svg> — 프론트가 작성
    pub photo_data_url:   String,       // "data:image/jpeg;base64,..."
    pub renter_confirmed_name: Option<String>,   // 임차인이 이름 확인 재입력
    // (2026-07-28 R9-b) 추가 사진 (파손 · 연료 게이지) — max 6장
    #[serde(default)]
    pub extra_photos:     Vec<HandoffExtraPhoto>,
}

const HANDOFF_MAX_EXTRA_PHOTOS: usize = 6;

async fn handoff_submit(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(req): Json<HandoffSubmitPayload>,
) -> AppResult<Json<Value>> {
    if req.signature_svg.trim().is_empty() {
        return Err(AppError::BadRequest("서명이 비어 있습니다".into()));
    }
    if req.photo_data_url.trim().is_empty() {
        return Err(AppError::BadRequest("사진이 비어 있습니다".into()));
    }
    if req.extra_photos.len() > HANDOFF_MAX_EXTRA_PHOTOS {
        return Err(AppError::BadRequest(format!("사진은 최대 {}장까지", HANDOFF_MAX_EXTRA_PHOTOS)));
    }
    // 오도미터 사진 파싱
    let (odo_mime, odo_bytes) = parse_data_url(&req.photo_data_url)
        .ok_or_else(|| AppError::BadRequest("photo_data_url invalid".into()))?;
    if odo_bytes.len() > HANDOFF_MAX_PHOTO_BYTES {
        return Err(AppError::BadRequest("photo too large (>4MB)".into()));
    }
    // 추가 사진 파싱 + kind 매핑 검증
    let mut extras_parsed: Vec<(String, String, Vec<u8>)> = Vec::with_capacity(req.extra_photos.len());
    for p in &req.extra_photos {
        if !matches!(p.kind.as_str(), "damage"|"fuel") {
            return Err(AppError::BadRequest(format!("invalid extra kind: {}", p.kind)));
        }
        let (m, b) = parse_data_url(&p.data_url)
            .ok_or_else(|| AppError::BadRequest("extra photo data_url invalid".into()))?;
        if b.len() > HANDOFF_MAX_PHOTO_BYTES {
            return Err(AppError::BadRequest("extra photo too large (>4MB)".into()));
        }
        extras_parsed.push((p.kind.clone(), m, b));
    }

    // 토큰 상태 검증
    #[derive(FromRow)]
    struct Tk { id: i64, contract_id: i64, user_id: i64, purpose: String,
                expires_at: DateTime<Utc>, used_at: Option<DateTime<Utc>>, revoked_at: Option<DateTime<Utc>> }
    let tk: Option<Tk> = sqlx::query_as(
        r#"SELECT id, contract_id, user_id, purpose, expires_at, used_at, revoked_at
             FROM rental_handoff_tokens WHERE token = $1"#,
    ).bind(&token).fetch_optional(&state.db).await?;
    let tk = tk.ok_or(AppError::NotFound)?;
    if tk.revoked_at.is_some() { return Err(AppError::BadRequest("취소된 링크입니다".into())); }
    if tk.used_at.is_some()    { return Err(AppError::BadRequest("이미 제출된 링크입니다".into())); }
    if tk.expires_at <= Utc::now() { return Err(AppError::BadRequest("만료된 링크입니다".into())); }

    // (R9-b) return purpose 시 자동 settlement 위해 계약 요약 미리 로드.
    #[derive(FromRow)]
    struct Cur {
        rate_type: String, rate_amount_krw: i64,
        starts_at: DateTime<Utc>, ends_at: DateTime<Utc>,
        included_km_per_day: Option<i32>, over_km_price_krw: Option<i32>,
        pickup_odometer_km: Option<i32>, deposit_krw: i64,
    }
    let cur: Cur = sqlx::query_as(
        r#"SELECT rate_type, rate_amount_krw, starts_at, ends_at,
                  included_km_per_day, over_km_price_krw, pickup_odometer_km, deposit_krw
             FROM rental_contracts WHERE id = $1"#,
    ).bind(tk.contract_id).fetch_one(&state.db).await?;

    let mut tx = state.db.begin().await?;

    let photo_kind = if tk.purpose == "pickup" { "pickup_odometer" } else { "return_odometer" };
    let photo_id: i64 = sqlx::query_scalar(
        r#"INSERT INTO rental_photos (contract_id, user_id, kind, mime, bytes, uploaded_by_token)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id"#,
    )
    .bind(tk.contract_id).bind(tk.user_id).bind(photo_kind).bind(&odo_mime).bind(&odo_bytes).bind(tk.id)
    .fetch_one(&mut *tx).await?;

    // 추가 사진 저장 (damage/fuel × purpose)
    let mut extra_photo_ids: Vec<i64> = Vec::with_capacity(extras_parsed.len());
    for (kind_short, mime, bytes) in &extras_parsed {
        let db_kind = match (tk.purpose.as_str(), kind_short.as_str()) {
            ("pickup", "damage") => "pickup_damage",
            ("pickup", "fuel")   => "pickup_fuel",
            ("return", "damage") => "return_damage",
            ("return", "fuel")   => "return_fuel",
            _ => continue,   // 위 검증에서 걸러짐, defensive
        };
        let id: i64 = sqlx::query_scalar(
            r#"INSERT INTO rental_photos (contract_id, user_id, kind, mime, bytes, uploaded_by_token)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"#,
        )
        .bind(tk.contract_id).bind(tk.user_id).bind(db_kind).bind(mime).bind(bytes).bind(tk.id)
        .fetch_one(&mut *tx).await?;
        extra_photo_ids.push(id);
    }

    let mut settlement_out: Option<Value> = None;

    if tk.purpose == "pickup" {
        // 인수: pickup 정보 확정. draft → active.
        sqlx::query(
            r#"UPDATE rental_contracts SET
                pickup_odometer_km    = $2,
                pickup_signature_svg  = $3,
                pickup_signed_at      = NOW(),
                status                = CASE WHEN status = 'draft' THEN 'active' ELSE status END,
                updated_at            = NOW()
              WHERE id = $1"#,
        )
        .bind(tk.contract_id).bind(req.odometer_km).bind(&req.signature_svg)
        .execute(&mut *tx).await?;
    } else {
        // (R9-b) 반납: 자동 settlement 실행. return_contract 와 동일 공식.
        // 임차인 self-return 은 extra_fee = 0 (파손비/세차비 등은 owner 가 별도 편집).
        let (settled_json, subtotal, base_fee, late_hours, late_fee, over_km_val, over_km_fee, refund, returned_at) =
            compute_settlement(
                &cur.rate_type, cur.rate_amount_krw,
                cur.starts_at, cur.ends_at,
                cur.included_km_per_day, cur.over_km_price_krw,
                cur.pickup_odometer_km, cur.deposit_krw,
                req.odometer_km, None, None, None,
            );

        sqlx::query(
            r#"UPDATE rental_contracts SET
                return_odometer_km    = $2,
                return_signature_svg  = $3,
                return_signed_at      = NOW(),
                status                = 'returned',
                settled_amount_krw    = $4,
                settled_at            = NOW(),
                base_fee_krw          = $5,
                late_hours            = $6,
                late_fee_krw          = $7,
                over_km               = $8,
                over_km_fee_krw       = $9,
                extra_fee_krw         = 0,
                refund_krw            = $10,
                returned_at           = $11,
                settlement_json       = $12,
                updated_at            = NOW()
              WHERE id = $1"#,
        )
        .bind(tk.contract_id).bind(req.odometer_km).bind(&req.signature_svg)
        .bind(subtotal).bind(base_fee).bind(late_hours).bind(late_fee)
        .bind(over_km_val).bind(over_km_fee).bind(refund).bind(returned_at)
        .bind(&settled_json)
        .execute(&mut *tx).await?;
        settlement_out = Some(settled_json);
    }
    sqlx::query("UPDATE rental_handoff_tokens SET used_at = NOW() WHERE id = $1")
        .bind(tk.id).execute(&mut *tx).await?;

    tx.commit().await?;

    // Owner 알림 event insert (기존 FCM 워커 push)
    let evt_kind = if tk.purpose == "pickup" { "rental_pickup_done" } else { "rental_return_done" };
    let _ = sqlx::query(
        r#"INSERT INTO events (device_id, user_id, occurred_at, kind, data)
           SELECT c.device_id, c.user_id, NOW(), $2,
                  jsonb_build_object(
                    'contract_id', c.id,
                    'renter_name', c.renter_name,
                    'odometer_km', $3::INT,
                    'photo_id',    $4::BIGINT,
                    'extra_photo_ids', $5::JSONB)
             FROM rental_contracts c WHERE c.id = $1"#,
    ).bind(tk.contract_id).bind(evt_kind).bind(req.odometer_km).bind(photo_id)
    .bind(serde_json::to_value(&extra_photo_ids).unwrap_or_default())
    .execute(&state.db).await;

    // 이름 확인값과 불일치면 audit 로그 성격 note 붙임 (best-effort)
    if let Some(name) = req.renter_confirmed_name.as_deref() {
        let name = name.trim();
        if !name.is_empty() {
            let _ = sqlx::query(
                r#"UPDATE rental_contracts
                      SET note = COALESCE(note, '') ||
                        CASE WHEN COALESCE(note,'') = '' THEN '' ELSE E'\n' END ||
                        '[' || $2 || ' handoff] 임차인 확인 이름: ' || $3
                    WHERE id = $1"#,
            ).bind(tk.contract_id).bind(&tk.purpose).bind(name)
            .execute(&state.db).await;
        }
    }

    Ok(Json(json!({
        "ok": true,
        "purpose": tk.purpose,
        "photo_id": photo_id,
        "extra_photo_ids": extra_photo_ids,
        "settlement": settlement_out,   // return purpose 시 breakdown, pickup 은 null
    })))
}

// (R9-b) return_contract 와 동일 공식. 임차인 self-return 은 extra_fee 없음.
// 반환: (settlement_json, subtotal, base_fee, late_hours, late_fee, over_km, over_km_fee, refund, returned_at)
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
fn compute_settlement(
    rate_type: &str,
    rate_amount_krw: i64,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    included_km_per_day: Option<i32>,
    over_km_price_krw: Option<i32>,
    pickup_odometer_km: Option<i32>,
    deposit_krw: i64,
    return_odo_km: i32,
    extra_fee_override: Option<i64>,
    extra_label_override: Option<&str>,
    returned_at_override: Option<DateTime<Utc>>,
) -> (Value, i64, i64, i32, i64, i32, i64, i64, DateTime<Utc>) {
    let dur = ends_at - starts_at;
    let (units_raw, unit_label) = match rate_type {
        "hourly"  => ((dur.num_minutes() as f64 / 60.0).ceil() as i64, "시간"),
        "monthly" => ((dur.num_days()    as f64 / 30.0).ceil() as i64, "개월"),
        _         => ((dur.num_hours()   as f64 / 24.0).ceil() as i64, "일"),
    };
    let units = units_raw.max(1);
    let base_fee = rate_amount_krw * units;

    let mut over_km_val: i32 = 0;
    let mut over_km_fee: i64 = 0;
    if let (Some(pick_od), Some(inc_per_day), Some(over_price)) =
        (pickup_odometer_km, included_km_per_day, over_km_price_krw)
    {
        let driven = (return_odo_km - pick_od).max(0);
        let days = ((dur.num_hours() as f64 / 24.0).ceil() as i32).max(1);
        let allowed = inc_per_day * days;
        over_km_val = (driven - allowed).max(0);
        over_km_fee = (over_km_val as i64) * (over_price as i64);
    }

    let returned_at = returned_at_override.unwrap_or_else(Utc::now);
    let late_hours: i32 = if returned_at > ends_at {
        let d = returned_at - ends_at;
        ((d.num_minutes() as f64 / 60.0).ceil() as i32).max(0)
    } else { 0 };
    let hourly = hourly_rate(rate_type, rate_amount_krw);
    let late_fee: i64 = if late_hours > 0 {
        ((late_hours as f64) * (hourly as f64) * LATE_FEE_MULTIPLIER).round() as i64
    } else { 0 };

    let extra_fee = extra_fee_override.unwrap_or(0);
    let extra_label = extra_label_override.unwrap_or("기타").to_string();

    let subtotal = base_fee + over_km_fee + late_fee + extra_fee;
    let refund = deposit_krw - subtotal;

    let mut lines: Vec<Value> = Vec::new();
    lines.push(json!({
        "kind": "base",
        "label": format!("기본 요금 ({units}{unit_label} × {}원)", fmt_krw(rate_amount_krw)),
        "amount": base_fee,
    }));
    if over_km_val > 0 && over_km_fee > 0 {
        let over_price = over_km_price_krw.unwrap_or(0);
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
        lines.push(json!({ "kind": "extra", "label": extra_label, "amount": extra_fee }));
    }
    let settlement = json!({
        "lines": lines,
        "subtotal": subtotal,
        "deposit": deposit_krw,
        "balance": refund,
    });
    (settlement, subtotal, base_fee, late_hours, late_fee, over_km_val, over_km_fee, refund, returned_at)
}

async fn get_photo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<axum::response::Response> {
    #[derive(FromRow)]
    struct Row { mime: String, bytes: Vec<u8>, user_id: i64 }
    let row: Option<Row> = sqlx::query_as(
        "SELECT mime, bytes, user_id FROM rental_photos WHERE id = $1"
    ).bind(id).fetch_optional(&state.db).await?;
    let row = row.ok_or(AppError::NotFound)?;
    if row.user_id != user.user_id {
        return Err(AppError::NotFound);
    }
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE,
        HeaderValue::from_str(&row.mime).unwrap_or_else(|_| HeaderValue::from_static("image/jpeg")));
    headers.insert(header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"));
    Ok((StatusCode::OK, headers, row.bytes).into_response())
}

// (R9-a 확장) owner 계약별 사진 목록 (썸네일 갤러리 뷰용).
#[derive(Debug, Serialize, FromRow)]
pub struct PhotoMeta {
    pub id:          i64,
    pub contract_id: i64,
    pub kind:        String,
    pub mime:        String,
    pub uploaded_at: DateTime<Utc>,
    pub size_bytes:  i64,
}

async fn list_photos(
    State(state): State<AppState>,
    user: AuthUser,
    Path(contract_id): Path<i64>,
) -> AppResult<Json<Vec<PhotoMeta>>> {
    let rows: Vec<PhotoMeta> = sqlx::query_as(
        r#"SELECT id, contract_id, kind, mime, uploaded_at,
                  OCTET_LENGTH(bytes)::BIGINT AS size_bytes
             FROM rental_photos
            WHERE contract_id = $1 AND user_id = $2
         ORDER BY uploaded_at ASC"#,
    ).bind(contract_id).bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct UploadPhotoPayload {
    pub kind:      String,           // pickup_odometer|pickup_damage|pickup_fuel|return_*
    pub data_url:  String,
}

const OWNER_ALLOWED_KINDS: &[&str] = &[
    "pickup_odometer","pickup_damage","pickup_fuel",
    "return_odometer","return_damage","return_fuel",
];

async fn upload_photo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(contract_id): Path<i64>,
    Json(req): Json<UploadPhotoPayload>,
) -> AppResult<Json<PhotoMeta>> {
    if !OWNER_ALLOWED_KINDS.iter().any(|k| *k == req.kind) {
        return Err(AppError::BadRequest(format!("invalid kind: {}", req.kind)));
    }
    // 소유권 확인
    let owner: Option<i64> = sqlx::query_scalar(
        "SELECT user_id FROM rental_contracts WHERE id = $1"
    ).bind(contract_id).fetch_optional(&state.db).await?;
    match owner {
        Some(uid) if uid == user.user_id => {}
        _ => return Err(AppError::NotFound),
    }
    let (mime, bytes) = parse_data_url(&req.data_url)
        .ok_or_else(|| AppError::BadRequest("data_url invalid".into()))?;
    if bytes.len() > HANDOFF_MAX_PHOTO_BYTES {
        return Err(AppError::BadRequest("photo too large (>4MB)".into()));
    }
    let row: PhotoMeta = sqlx::query_as(
        r#"INSERT INTO rental_photos (contract_id, user_id, kind, mime, bytes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, contract_id, kind, mime, uploaded_at,
                     OCTET_LENGTH(bytes)::BIGINT AS size_bytes"#,
    )
    .bind(contract_id).bind(user.user_id).bind(&req.kind).bind(&mime).bind(&bytes)
    .fetch_one(&state.db).await?;
    Ok(Json(row))
}

async fn delete_photo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let n = sqlx::query("DELETE FROM rental_photos WHERE id = $1 AND user_id = $2")
        .bind(id).bind(user.user_id).execute(&state.db).await?.rows_affected();
    if n == 0 { return Err(AppError::NotFound); }
    Ok(Json(json!({ "ok": true })))
}

fn parse_data_url(s: &str) -> Option<(String, Vec<u8>)> {
    // "data:image/jpeg;base64,{b64}"
    let s = s.strip_prefix("data:")?;
    let (meta, b64) = s.split_once(",")?;
    let (mime, is_b64) = if let Some(m) = meta.strip_suffix(";base64") {
        (m.to_string(), true)
    } else {
        (meta.to_string(), false)
    };
    if !is_b64 { return None; }  // urlencoded 미지원
    // base64 decode
    let bytes = base64_decode(b64)?;
    if !mime.starts_with("image/") { return None; }
    Some((mime, bytes))
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: [i8; 256] = {
        let mut t = [-1i8; 256];
        let a = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0;
        while i < 64 { t[a[i] as usize] = i as i8; i += 1; }
        // URL-safe 대체 문자
        t[b'-' as usize] = 62;
        t[b'_' as usize] = 63;
        t
    };
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in s.as_bytes() {
        if b == b'\n' || b == b'\r' || b == b' ' { continue; }
        let v = T[b as usize];
        if v < 0 { return None; }
        acc = (acc << 6) | (v as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}
