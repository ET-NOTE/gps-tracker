// (2026-07-28) Stage-4B-2: 월간 운행기록부 XLSX 생성 (2종).
//
// 1) NTS (국세청) — 별지 제73호 (업무용승용차 운행기록부) 서식
//    법인세법 시행규칙 [별지 제73호서식]. 세무 감사·경비 인정 근거.
//    필수 열: 사용일자 · 부서 · 사용자 · 사용목적 · 출발지 · 도착지 · 주행거리(km) · 업무용사용거리(km)
//    총계 + 업무사용비율 요약.
//
// 2) OURS (우리 전용) — 정보량 多 · 조직 실무용
//    회사 정보 헤더 + 차량별 sheet 분리 + 유류비 상세 + 좌표 + 부서 그룹.
//
// 사용:
//   let bytes = build_nts(&ctx)?;
//   응답: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet

use chrono::{DateTime, NaiveDate, Utc};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook, XlsxError};

#[derive(Debug, Clone)]
pub struct CorpInfoLite {
    pub business_number: Option<String>,
    pub company_name:    Option<String>,
    pub representative:  Option<String>,
    pub address:         Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeviceLite {
    pub id:                 i64,
    pub display_name:       Option<String>,
    pub device_uid:         String,
    pub license_plate:      Option<String>,
    pub model_year:         Option<i32>,
    pub engine_cc:          Option<i32>,
    pub purchase_price_krw: Option<i64>,
    pub acquired_at:        Option<NaiveDate>,
    pub department:         Option<String>,
    pub vehicle_type:       Option<String>,
    pub fuel_efficiency_kmpl: Option<f32>,
    pub fuel_type:          Option<String>,
}

#[derive(Debug, Clone)]
pub struct TripLite {
    pub started_at:     DateTime<Utc>,
    pub ended_at:       Option<DateTime<Utc>>,
    pub distance_m:     f64,
    pub start_address:  Option<String>,
    pub end_address:    Option<String>,
    pub start_lat:      Option<f64>,
    pub start_lng:      Option<f64>,
    pub end_lat:        Option<f64>,
    pub end_lng:        Option<f64>,
    pub purpose:        Option<String>,     // 'business'|'commute'|'other'|'unspecified'
    pub purpose_note:   Option<String>,
    pub driver_name:    Option<String>,
    pub fuel_liters:    Option<f64>,
    pub fuel_cost_krw:  Option<i64>,        // 사용자 수기 입력 (있으면 우선)
    pub note:           Option<String>,
}

pub struct ReportContext<'a> {
    pub month_ym:     String,            // "2026-07"
    pub corp:         &'a CorpInfoLite,
    pub per_device:   Vec<(&'a DeviceLite, Vec<TripLite>)>,
    pub fuel_price:   fn(&str) -> i64,   // fuel_type → 원/L
}

// ═══════════════════════════════════════════════════════════════
// 국세청 별지 제73호서식 — 표준 열 구성.
// ═══════════════════════════════════════════════════════════════
pub fn build_nts(ctx: &ReportContext) -> Result<Vec<u8>, XlsxError> {
    let mut wb = Workbook::new();
    let title_fmt   = title_format();
    let header_fmt  = table_header_format();
    let cell_fmt    = table_cell_format();
    let cell_num    = table_cell_num_format();
    let label_fmt   = header_label_format();
    let value_fmt   = header_value_format();
    let summary_fmt = summary_format();

    // 차량별로 sheet 하나 (국세청 서식은 차량 단위).
    for (i, (device, trips)) in ctx.per_device.iter().enumerate() {
        let sheet = wb.add_worksheet();
        let plate = device.license_plate.clone().unwrap_or_else(|| "미입력".into());
        let name  = short_sheet_name(&format!("{} {}", plate,
            device.display_name.clone().unwrap_or_default()), i);
        sheet.set_name(&name)?;

        // ── 제목 ─────────────────────────────────────
        sheet.merge_range(0, 0, 0, 7, "업무용승용차 운행기록부", &title_fmt)?;
        sheet.set_row_height(0, 26.0)?;

        // ── 헤더 표 (2 x 4 그리드) ────────────────────
        let year = &ctx.month_ym[..4];
        let month_no = &ctx.month_ym[5..];
        let header_rows: [[(&str, String); 4]; 3] = [
            [
                ("과세기간",      format!("{}년 {}월", year, month_no)),
                ("법인명",        ctx.corp.company_name.clone().unwrap_or_default()),
                ("사업자등록번호", ctx.corp.business_number.clone().unwrap_or_default()),
                ("대표자",        ctx.corp.representative.clone().unwrap_or_default()),
            ],
            [
                ("차량번호",      plate.clone()),
                ("차종",          device.display_name.clone().unwrap_or_else(|| device.device_uid.clone())),
                ("연식",          device.model_year.map(|y| format!("{}년", y)).unwrap_or_default()),
                ("배기량(cc)",    device.engine_cc.map(|c| c.to_string()).unwrap_or_default()),
            ],
            [
                ("취득일",        device.acquired_at.map(|d| d.to_string()).unwrap_or_default()),
                ("취득가액(원)",  device.purchase_price_krw.map(|p| p.to_string()).unwrap_or_default()),
                ("부서",          device.department.clone().unwrap_or_default()),
                ("차량유형",      vehicle_type_ko(device.vehicle_type.as_deref())),
            ],
        ];
        let mut row = 2u32;
        for r in header_rows.iter() {
            for (col_i, (label, value)) in r.iter().enumerate() {
                let c = (col_i * 2) as u16;
                sheet.write_string_with_format(row, c,     *label,       &label_fmt)?;
                sheet.write_string_with_format(row, c + 1, value.as_str(), &value_fmt)?;
            }
            row += 1;
        }

        // ── 운행 표 헤더 ─────────────────────────────
        row += 1;
        let cols = ["사용일자","운행시각","주행거리(km)","업무용거리(km)","출발지","도착지","사용목적","사용자"];
        for (i, c) in cols.iter().enumerate() {
            sheet.write_string_with_format(row, i as u16, *c, &header_fmt)?;
        }
        row += 1;

        // ── 운행 데이터 ──────────────────────────────
        let mut total_km = 0f64;
        let mut business_km = 0f64;
        for t in trips {
            let dist_km = t.distance_m / 1000.0;
            let biz_km = if t.purpose.as_deref() == Some("business") { dist_km } else { 0.0 };
            total_km    += dist_km;
            business_km += biz_km;

            sheet.write_string_with_format(row, 0, &fmt_date_kst(&t.started_at), &cell_fmt)?;
            sheet.write_string_with_format(row, 1, &fmt_time_range(t.started_at, t.ended_at), &cell_fmt)?;
            sheet.write_number_with_format(row, 2, dist_km, &cell_num)?;
            sheet.write_number_with_format(row, 3, biz_km,  &cell_num)?;
            sheet.write_string_with_format(row, 4, &t.start_address.clone().unwrap_or_default(), &cell_fmt)?;
            sheet.write_string_with_format(row, 5, &t.end_address.clone().unwrap_or_default(),   &cell_fmt)?;
            sheet.write_string_with_format(row, 6, &purpose_ko(t.purpose.as_deref(), t.purpose_note.as_deref()), &cell_fmt)?;
            sheet.write_string_with_format(row, 7, &t.driver_name.clone().unwrap_or_default(), &cell_fmt)?;
            row += 1;
        }

        // ── 요약 ─────────────────────────────────────
        row += 1;
        let pct = if total_km > 0.001 { (business_km / total_km) * 100.0 } else { 0.0 };
        sheet.merge_range(row, 0, row, 1, "총 주행거리(km)", &label_fmt)?;
        sheet.write_number_with_format(row, 2, total_km, &summary_fmt)?;
        row += 1;
        sheet.merge_range(row, 0, row, 1, "업무 사용거리(km)", &label_fmt)?;
        sheet.write_number_with_format(row, 2, business_km, &summary_fmt)?;
        row += 1;
        sheet.merge_range(row, 0, row, 1, "업무 사용비율(%)", &label_fmt)?;
        sheet.write_number_with_format(row, 2, pct, &summary_fmt)?;

        // 열 폭
        sheet.set_column_width(0, 12.0)?;
        sheet.set_column_width(1, 20.0)?;
        sheet.set_column_width(2, 14.0)?;
        sheet.set_column_width(3, 14.0)?;
        sheet.set_column_width(4, 30.0)?;
        sheet.set_column_width(5, 30.0)?;
        sheet.set_column_width(6, 16.0)?;
        sheet.set_column_width(7, 12.0)?;
    }

    Ok(wb.save_to_buffer()?)
}

// ═══════════════════════════════════════════════════════════════
// 우리 전용 서식 — 정보량 많음, 조직 실무용.
// 첫 sheet: 전 차량 요약 (부서별 그룹, 유류비 추정)
// 다음 sheet: 차량별 상세 (좌표 · 유류 · 비고 등 확장 열)
// ═══════════════════════════════════════════════════════════════
pub fn build_ours(ctx: &ReportContext) -> Result<Vec<u8>, XlsxError> {
    let mut wb = Workbook::new();
    let title_fmt   = title_format();
    let subtitle    = subtitle_format();
    let header_fmt  = table_header_format();
    let cell_fmt    = table_cell_format();
    let cell_num    = table_cell_num_format();
    let cell_won    = table_cell_won_format();
    let label_fmt   = header_label_format();
    let value_fmt   = header_value_format();
    let summary_fmt = summary_format();

    // ── Sheet 1: 요약 ─────────────────────────────────
    let summary = wb.add_worksheet();
    summary.set_name("요약")?;
    summary.merge_range(0, 0, 0, 8, &format!("{} 월간 운행 리포트", ctx.month_ym), &title_fmt)?;
    summary.set_row_height(0, 28.0)?;
    summary.merge_range(1, 0, 1, 8,
        &ctx.corp.company_name.clone().unwrap_or_else(|| "회사명 미입력".into()),
        &subtitle)?;

    let cols = ["차량명","차량번호","부서","연식","연료","총 km","업무 km","업무%","유류비 추정(원)"];
    let row0 = 3u32;
    for (i, c) in cols.iter().enumerate() {
        summary.write_string_with_format(row0, i as u16, *c, &header_fmt)?;
    }

    let mut grand_total = 0f64;
    let mut grand_biz   = 0f64;
    let mut grand_cost  = 0i64;
    let mut r = row0 + 1;
    for (d, trips) in ctx.per_device.iter() {
        let mut total_km = 0f64;
        let mut biz_km   = 0f64;
        let mut ann_cost = 0i64;
        for t in trips {
            let dist_km = t.distance_m / 1000.0;
            total_km += dist_km;
            if t.purpose.as_deref() == Some("business") { biz_km += dist_km; }
            if let Some(c) = t.fuel_cost_krw { ann_cost += c; }
        }
        // 유류비: 사용자 수기 입력 합계 우선, 없으면 자동 추정.
        let est_cost = if ann_cost > 0 {
            ann_cost
        } else if let (Some(kmpl), Some(ft)) = (d.fuel_efficiency_kmpl, d.fuel_type.as_deref()) {
            if kmpl > 0.0 {
                ((total_km / kmpl as f64) * (ctx.fuel_price)(ft) as f64) as i64
            } else { 0 }
        } else { 0 };
        let pct = if total_km > 0.001 { (biz_km / total_km) * 100.0 } else { 0.0 };
        grand_total += total_km; grand_biz += biz_km; grand_cost += est_cost;

        summary.write_string_with_format(r, 0, &d.display_name.clone().unwrap_or_else(|| d.device_uid.clone()), &cell_fmt)?;
        summary.write_string_with_format(r, 1, &d.license_plate.clone().unwrap_or_default(), &cell_fmt)?;
        summary.write_string_with_format(r, 2, &d.department.clone().unwrap_or_default(), &cell_fmt)?;
        summary.write_string_with_format(r, 3, &d.model_year.map(|y| y.to_string()).unwrap_or_default(), &cell_fmt)?;
        summary.write_string_with_format(r, 4, &fuel_type_ko(d.fuel_type.as_deref()), &cell_fmt)?;
        summary.write_number_with_format(r, 5, total_km, &cell_num)?;
        summary.write_number_with_format(r, 6, biz_km,   &cell_num)?;
        summary.write_number_with_format(r, 7, pct,      &cell_num)?;
        summary.write_number_with_format(r, 8, est_cost as f64, &cell_won)?;
        r += 1;
    }

    // 총계 row
    let grand_pct = if grand_total > 0.001 { (grand_biz / grand_total) * 100.0 } else { 0.0 };
    summary.merge_range(r, 0, r, 4, "총계", &label_fmt)?;
    summary.write_number_with_format(r, 5, grand_total, &summary_fmt)?;
    summary.write_number_with_format(r, 6, grand_biz,   &summary_fmt)?;
    summary.write_number_with_format(r, 7, grand_pct,   &summary_fmt)?;
    summary.write_number_with_format(r, 8, grand_cost as f64, &cell_won)?;

    for (i, w) in [16.0, 12.0, 12.0, 8.0, 10.0, 12.0, 12.0, 10.0, 18.0].iter().enumerate() {
        summary.set_column_width(i as u16, *w)?;
    }

    // ── Sheet N: 차량별 상세 ─────────────────────────
    for (i, (d, trips)) in ctx.per_device.iter().enumerate() {
        let sheet = wb.add_worksheet();
        let plate = d.license_plate.clone().unwrap_or_else(|| format!("차량{}", i + 1));
        let name = short_sheet_name(&plate, i);
        sheet.set_name(&name)?;

        sheet.merge_range(0, 0, 0, 9, &format!("{} 상세 운행", plate), &title_fmt)?;
        sheet.set_row_height(0, 24.0)?;

        let cols = ["사용일자","시작시각","종료시각","주행거리(km)","출발지","도착지","사용목적","사용자","유류(L)","유류비(원)"];
        for (ci, c) in cols.iter().enumerate() {
            sheet.write_string_with_format(2, ci as u16, *c, &header_fmt)?;
        }
        let mut row = 3u32;
        for t in trips {
            let dist_km = t.distance_m / 1000.0;
            sheet.write_string_with_format(row, 0, &fmt_date_kst(&t.started_at), &cell_fmt)?;
            sheet.write_string_with_format(row, 1, &fmt_time_kst(&t.started_at), &cell_fmt)?;
            sheet.write_string_with_format(row, 2, &t.ended_at.map(|e| fmt_time_kst(&e)).unwrap_or_else(|| "진행중".into()), &cell_fmt)?;
            sheet.write_number_with_format(row, 3, dist_km, &cell_num)?;
            sheet.write_string_with_format(row, 4, &t.start_address.clone().unwrap_or_default(), &cell_fmt)?;
            sheet.write_string_with_format(row, 5, &t.end_address.clone().unwrap_or_default(),   &cell_fmt)?;
            sheet.write_string_with_format(row, 6, &purpose_ko(t.purpose.as_deref(), t.purpose_note.as_deref()), &cell_fmt)?;
            sheet.write_string_with_format(row, 7, &t.driver_name.clone().unwrap_or_default(), &cell_fmt)?;
            if let Some(l) = t.fuel_liters { sheet.write_number_with_format(row, 8, l, &cell_num)?; }
            if let Some(c) = t.fuel_cost_krw { sheet.write_number_with_format(row, 9, c as f64, &cell_won)?; }
            row += 1;
        }

        for (i, w) in [12.0, 10.0, 10.0, 12.0, 28.0, 28.0, 16.0, 12.0, 10.0, 14.0].iter().enumerate() {
            sheet.set_column_width(i as u16, *w)?;
        }
    }

    Ok(wb.save_to_buffer()?)
}

// ── 포맷 헬퍼 ─────────────────────────────────────────
fn title_format() -> Format {
    Format::new().set_bold().set_font_size(16).set_align(FormatAlign::Center)
}
fn subtitle_format() -> Format {
    Format::new().set_font_size(11).set_font_color(Color::RGB(0x666666)).set_align(FormatAlign::Center)
}
fn table_header_format() -> Format {
    Format::new().set_bold()
        .set_background_color(Color::RGB(0xE9EDF5))
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
}
fn table_cell_format() -> Format {
    Format::new().set_border(FormatBorder::Thin).set_font_size(10)
}
fn table_cell_num_format() -> Format {
    Format::new().set_border(FormatBorder::Thin).set_font_size(10).set_num_format("#,##0.0")
}
fn table_cell_won_format() -> Format {
    Format::new().set_border(FormatBorder::Thin).set_font_size(10).set_num_format("#,##0")
}
fn header_label_format() -> Format {
    Format::new().set_bold().set_background_color(Color::RGB(0xF3F4F6))
        .set_border(FormatBorder::Thin).set_align(FormatAlign::Center)
}
fn header_value_format() -> Format {
    Format::new().set_border(FormatBorder::Thin)
}
fn summary_format() -> Format {
    Format::new().set_bold().set_border(FormatBorder::Thin).set_num_format("#,##0.0")
}

// ── 값 변환 ───────────────────────────────────────────
fn kst(t: DateTime<Utc>) -> DateTime<chrono::FixedOffset> {
    t.with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap())
}
fn fmt_date_kst(t: &DateTime<Utc>) -> String { kst(*t).format("%Y-%m-%d").to_string() }
fn fmt_time_kst(t: &DateTime<Utc>) -> String { kst(*t).format("%H:%M").to_string() }
fn fmt_time_range(s: DateTime<Utc>, e: Option<DateTime<Utc>>) -> String {
    match e {
        Some(e) => format!("{}~{}", fmt_time_kst(&s), fmt_time_kst(&e)),
        None    => format!("{}~진행중", fmt_time_kst(&s)),
    }
}
fn purpose_ko(p: Option<&str>, note: Option<&str>) -> String {
    let base = match p {
        Some("business")    => "업무",
        Some("commute")     => "출퇴근",
        Some("other")       => "기타",
        _                   => "미지정",
    };
    match (p, note) {
        (Some("other"), Some(n)) if !n.is_empty() => format!("기타: {}", n),
        _ => base.into(),
    }
}
fn vehicle_type_ko(t: Option<&str>) -> String {
    match t {
        Some("sedan")   => "승용",
        Some("van")     => "승합",
        Some("truck")   => "화물",
        Some("special") => "특수",
        Some("ev")      => "전기",
        _ => "",
    }.into()
}
fn fuel_type_ko(t: Option<&str>) -> String {
    match t {
        Some("gasoline") => "휘발유",
        Some("diesel")   => "경유",
        Some("lpg")      => "LPG",
        Some("ev")       => "전기",
        _ => "",
    }.into()
}
// Excel sheet 이름 제약: 최대 31자, / \ ? * [ ] : 금지.
fn short_sheet_name(name: &str, idx: usize) -> String {
    let cleaned: String = name.chars()
        .filter(|c| !"/\\?*[]:".contains(*c))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("차량{}", idx + 1);
    }
    let mut out = String::new();
    for ch in trimmed.chars() {
        if out.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum::<usize>() +
           (if ch.is_ascii() { 1 } else { 2 }) > 28 {
            break;
        }
        out.push(ch);
    }
    if out.is_empty() { format!("차량{}", idx + 1) } else { out }
}
