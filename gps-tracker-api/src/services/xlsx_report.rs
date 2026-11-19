// (2026-07-28) Stage-4B-2: 월간 운행기록부 XLSX 생성 (2종).
//
// 1) NTS — 사용자가 제공한 업무용승용차 운행기록부의 표 구조와 항목.
//    계기판 입력 쌍이 있으면 ⑦=⑥-⑤, 없으면 운행기록 거리임을 밝힌다. 사용자 부서는 배정 당시 값.
//    최신 법정 서식과의 동일성이나 제출 적합성을 주장하지 않는다.
//
// 2) OURS (우리 전용) — 정보량 多 · 조직 실무용
//    회사 정보 헤더 + 차량별 sheet 분리 + 유류비 상세 + 좌표 + 부서 그룹.
//
// 사용:
//   let bytes = build_nts(&ctx)?;
//   응답: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet

use chrono::{DateTime, NaiveDate, Utc};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook, Worksheet, XlsxError};

#[derive(Debug, Clone)]
pub struct CorpInfoLite {
    pub business_number: Option<String>,
    pub company_name: Option<String>,
    pub representative: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeviceLite {
    pub display_name: Option<String>,
    pub device_uid: String,
    pub license_plate: Option<String>,
    pub car_model: Option<String>,
    pub model_year: Option<i32>,
    pub engine_cc: Option<i32>,
    pub purchase_price_krw: Option<i64>,
    pub acquired_at: Option<NaiveDate>,
    pub department: Option<String>,
    pub vehicle_type: Option<String>,
    pub fuel_efficiency_kmpl: Option<f32>,
    pub fuel_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TripLite {
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub distance_m: Option<f64>,
    pub report_included: bool,
    pub quality_note: String,
    pub start_address: Option<String>,
    pub end_address: Option<String>,
    pub purpose: Option<String>, // 'business'|'commute'|'other'|'unspecified'
    pub purpose_note: Option<String>,
    pub note: Option<String>,
    pub driver_name: Option<String>,
    pub driver_department: Option<String>,
    pub odometer_before_km: Option<f64>,
    pub odometer_after_km: Option<f64>,
    pub fuel_liters: Option<f64>,
    pub fuel_cost_krw: Option<i64>, // 사용자 수기 입력 (있으면 우선)
}

pub struct ReportContext<'a> {
    pub month_ym: String, // "2026-07"
    /// Selected purposes, if any. Totals then describe this subset, not the month.
    pub purpose_filter: Option<Vec<String>>,
    pub corp: &'a CorpInfoLite,
    pub per_device: Vec<(&'a DeviceLite, Vec<TripLite>)>,
    /// fuel_type ('gasoline'|'diesel'|'lpg'|'ev') → 원/L. env override + 오피넷 캐시.
    pub fuel_price: Box<dyn Fn(&str) -> i64 + Send + Sync + 'a>,
}

// ═══════════════════════════════════════════════════════════════
// 첨부 운행기록부 B12:Q14 열 구성. 구형 nts 요청 URL 유지.
// ═══════════════════════════════════════════════════════════════
pub fn build_nts(ctx: &ReportContext) -> Result<Vec<u8>, XlsxError> {
    let mut wb = Workbook::new();
    let cell = nts_cell_format();
    let label = cell
        .clone()
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_background_color(Color::RGB(0xF0F2F4));
    let number = cell
        .clone()
        .set_align(FormatAlign::Right)
        .set_num_format("#,##0.00");
    let section = Format::new()
        .set_font_name("맑은 고딕")
        .set_font_size(11)
        .set_bold();
    let note_fmt = Format::new()
        .set_font_name("맑은 고딕")
        .set_font_size(9)
        .set_text_wrap()
        .set_align(FormatAlign::VerticalCenter);
    let purpose_scope = purpose_filter_label(ctx.purpose_filter.as_deref());
    let scope = match purpose_scope.as_deref() {
        Some(purposes) => format!("조회 범위: 선택 차량 · {} · 목적: {purposes} (필터 적용 내역 · 월 전체 합계가 아닙니다)", ctx.month_ym),
        None => format!("조회 범위: 선택 차량 · {} · 운행목적 전체", ctx.month_ym),
    };
    let mut detail_notes: Vec<(usize, String, String, String)> = Vec::new();
    let mut note_pages = std::collections::HashMap::new();

    for (i, (device, trips)) in ctx.per_device.iter().enumerate() {
        let sheet = wb.add_worksheet();
        let plate = device.license_plate.as_deref().unwrap_or("");
        let display_name = device.display_name.as_deref().unwrap_or("").trim();
        let identity = if plate.is_empty() {
            if display_name.is_empty() {
                format!("차량 {}", i + 1)
            } else {
                display_name.to_string()
            }
        } else {
            format!("{plate} {display_name}").trim_end().to_string()
        };
        // Prefixes keep names unique even when registration/model data are missing.
        let name = short_sheet_name(&format!("{} {identity}", i + 1), i);
        sheet.set_name(&name)?;
        configure_nts_page(sheet);
        for (col, width) in [16.0, 11.0, 10.0, 13.0, 13.0, 11.0, 12.0, 13.0, 30.0]
            .iter()
            .enumerate()
        {
            sheet.set_column_width(col as u16, *width)?;
        }
        sheet.set_repeat_rows(9, 11)?;
        sheet.set_freeze_panes(12, 0)?;
        let footer_scope = purpose_scope
            .as_ref()
            .map(|value| format!(" · 목적: {value} (필터 적용)"))
            .unwrap_or_default();
        let footer = format!(
            "&L{} · {}{}&R&P / &N",
            (if plate.is_empty() { &identity } else { plate }).replace('&', "&&"),
            ctx.month_ym,
            footer_scope
        );
        sheet.set_footer(&footer);
        let appendix_name = format!("비고 부록 {}", i + 1);
        note_pages.insert(name.clone(), (appendix_name.clone(), footer));

        // The supplied form's company header, vehicle section and grouped grid.
        sheet.merge_range(0, 0, 1, 0, "조회기간", &label)?;
        sheet.merge_range(
            0,
            1,
            1,
            2,
            &ctx.month_ym,
            &cell.clone().set_align(FormatAlign::Center),
        )?;
        sheet.merge_range(
            0,
            3,
            1,
            6,
            "업무용승용차 운행기록부",
            &cell
                .clone()
                .set_bold()
                .set_font_size(17)
                .set_align(FormatAlign::Center),
        )?;
        sheet.write_string_with_format(0, 7, "상호명", &label)?;
        sheet.write_string_with_format(
            0,
            8,
            ctx.corp.company_name.as_deref().unwrap_or(""),
            &cell,
        )?;
        sheet.write_string_with_format(1, 7, "사업자등록번호", &label)?;
        sheet.write_string_with_format(
            1,
            8,
            ctx.corp.business_number.as_deref().unwrap_or(""),
            &cell,
        )?;
        sheet.set_row_height(0, 27)?;
        sheet.set_row_height(1, 27)?;
        let vehicle_scope = if display_name.is_empty() {
            scope.clone()
        } else {
            format!("차량명: {display_name} · {scope}")
        };
        sheet.merge_range(2, 0, 2, 8, &vehicle_scope, &note_fmt)?;
        sheet.set_row_height(2, 30)?;
        sheet.merge_range(3, 0, 3, 8, "1. 기본정보", &section)?;
        sheet.set_row_height(3, 24)?;
        sheet.write_string_with_format(4, 0, "①차종", &label)?;
        sheet.merge_range(4, 1, 4, 3, device.car_model.as_deref().unwrap_or(""), &cell)?;
        sheet.merge_range(4, 4, 4, 5, "②자동차등록번호", &label)?;
        sheet.merge_range(4, 6, 4, 8, plate, &cell)?;
        sheet.set_row_height(4, 27)?;
        sheet.merge_range(5, 0, 5, 8, "2. 업무용 사용비율 계산", &section)?;
        sheet.set_row_height(5, 26)?;
        let odometer_count = trips.iter().filter(|t| nts_odometer(t).is_some()).count();
        let record_distance_count = trips
            .iter()
            .filter(|t| nts_odometer(t).is_none() && record_distance(t).is_some())
            .count();
        let missing_distance_count = trips.len() - odometer_count - record_distance_count;
        let distance_basis = format!("⑦거리 기준: 계기판 차이(⑥−⑤) {odometer_count}건 · 운행기록 거리 대체 {record_distance_count}건{} · ④사용자는 차량 이용자 기준(운전자와 다르면 수정)",
            if missing_distance_count > 0 { format!(" · 거리 확인 필요 {missing_distance_count}건") } else { String::new() });
        sheet.merge_range(6, 0, 6, 8, &distance_basis, &note_fmt)?;
        sheet.set_row_height(6, 40)?;
        let counts = format!(
            "조회 {}건 · 합계 포함 {}건 · 합계 제외 {}건 · 부서는 사용자 배정 당시 기록입니다.",
            trips.len(),
            trips.iter().filter(|t| nts_distance(t).is_some()).count(),
            trips.iter().filter(|t| nts_distance(t).is_none()).count()
        );
        sheet.merge_range(7, 0, 7, 8, &counts, &note_fmt)?;
        sheet.set_row_height(7, 21)?;
        sheet.set_row_height(8, 7)?;
        sheet.merge_range(9, 0, 11, 0, "③사용일자\n(요일)", &label)?;
        sheet.merge_range(9, 1, 9, 2, "④사용자", &label)?;
        sheet.merge_range(9, 3, 9, 8, "운 행 내 역", &label)?;
        sheet.merge_range(10, 1, 11, 1, "부서", &label)?;
        sheet.merge_range(10, 2, 11, 2, "성명", &label)?;
        sheet.merge_range(10, 3, 11, 3, "⑤주행 전\n계기판 거리(㎞)", &label)?;
        sheet.merge_range(10, 4, 11, 4, "⑥주행 후\n계기판 거리(㎞)", &label)?;
        sheet.merge_range(10, 5, 11, 5, "⑦주행거리\n(㎞)", &label)?;
        sheet.merge_range(10, 6, 10, 7, "업무용 사용거리(㎞)", &label)?;
        sheet.merge_range(10, 8, 11, 8, "⑩비고", &label)?;
        sheet.write_string_with_format(11, 6, "⑧출·퇴근용", &label)?;
        sheet.write_string_with_format(11, 7, "⑨일반 업무용", &label)?;
        for row in 9..=11 {
            sheet.set_row_height(row, 25)?;
        }

        let mut row = 12;
        let mut totals = [0.0_f64; 3];
        let mut complete = true;
        for t in trips {
            let values = nts_distance(t);
            let known_purpose =
                matches!(t.purpose.as_deref(), Some("business" | "commute" | "other"));
            complete &= values.is_some() && known_purpose;
            let date = kst(t.started_at);
            use chrono::Datelike;
            let day = ["일", "월", "화", "수", "목", "금", "토"]
                [date.weekday().num_days_from_sunday() as usize];
            let date_text = format!("{} ({day})", date.format("%Y-%m-%d"));
            let row_cell = if values.is_none() {
                cell.clone().set_background_color(Color::RGB(0xF5F5F5))
            } else {
                cell.clone()
            };
            let row_number = row_cell
                .clone()
                .set_align(FormatAlign::Right)
                .set_num_format("#,##0.00");
            // Blank cells retain borders and can be completed after download.
            for col in 0..=8 {
                sheet.write_blank(row, col, &row_cell)?;
            }
            sheet.write_string_with_format(
                row,
                0,
                &date_text,
                &row_cell.clone().set_align(FormatAlign::Center),
            )?;
            sheet.write_string_with_format(
                row,
                1,
                t.driver_department.as_deref().unwrap_or(""),
                &row_cell,
            )?;
            sheet.write_string_with_format(
                row,
                2,
                t.driver_name.as_deref().unwrap_or(""),
                &row_cell,
            )?;
            if let Some([before, after]) = nts_odometer(t) {
                sheet.write_number_with_format(row, 3, before, &row_number)?;
                sheet.write_number_with_format(row, 4, after, &row_number)?;
            }
            if let Some(distance) = nts_row_distance(t) {
                sheet.write_number_with_format(row, 5, distance, &row_number)?;
            }
            if let Some(values) = values {
                for (i, value) in values.iter().enumerate() {
                    totals[i] += value;
                }
                if known_purpose {
                    sheet.write_number_with_format(row, 6, values[1], &row_number)?;
                    sheet.write_number_with_format(row, 7, values[2], &row_number)?;
                }
            }
            let note = nts_trip_note(t);
            let visible_note = if note.chars().count() > 100 || note.contains(['\n', '\r']) {
                let index = detail_notes.len() + 1;
                detail_notes.push((index, name.clone(), date_text, note));
                format!(
                    "{}{appendix_name} · 번호 {index}",
                    if values.is_none() {
                        "합계 제외 · "
                    } else {
                        ""
                    }
                )
            } else {
                note
            };
            sheet.write_string_with_format(row, 8, &visible_note, &row_cell)?;
            let lines = [
                text_lines(t.driver_department.as_deref().unwrap_or(""), 10),
                text_lines(t.driver_name.as_deref().unwrap_or(""), 9),
                text_lines(&visible_note, 28),
            ]
            .into_iter()
            .max()
            .unwrap_or(1);
            sheet.set_row_height(row, (14.0 * lines as f64 + 10.0).clamp(34.0, 300.0))?;
            row += 1;
        }
        if trips.is_empty() {
            sheet.merge_range(
                row,
                0,
                row,
                8,
                "조건에 맞는 운행 내역이 없습니다.",
                &cell.clone().set_align(FormatAlign::Center),
            )?;
            sheet.set_row_height(row, 34)?;
            row += 1;
        }
        totals = totals.map(|v| (v * 100.0).round() / 100.0);
        let total = totals[0];
        let work = ((totals[1] + totals[2]) * 100.0).round() / 100.0;
        sheet.merge_range(row, 0, row, 4, "조회 내역 합계 (확정 운행만 포함)", &label)?;
        for (i, value) in totals.iter().enumerate() {
            sheet.write_number_with_format(
                row,
                5 + i as u16,
                *value,
                &number.clone().set_bold(),
            )?;
        }
        sheet.write_string_with_format(row, 8, "합계 제외 기록은 더하지 않음", &cell)?;
        sheet.set_row_height(row, 30)?;
        row += 2;
        for (col, text) in [
            (0, "⑪조회 내역 총주행거리(㎞)"),
            (3, "⑫조회 내역 업무용 사용거리(㎞)"),
            (6, "⑬업무사용비율(⑫/⑪)"),
        ] {
            sheet.merge_range(row, col, row, col + 2, text, &label)?;
            sheet.merge_range(
                row + 1,
                col,
                row + 1,
                col + 2,
                "",
                &number.clone().set_bold().set_align(FormatAlign::Center),
            )?;
        }
        sheet.set_row_height(row, 30)?;
        sheet.set_row_height(row + 1, 29)?;
        let summary_num = number
            .clone()
            .set_bold()
            .set_font_size(12)
            .set_align(FormatAlign::Center);
        sheet.write_number_with_format(row + 1, 0, total, &summary_num)?;
        sheet.write_number_with_format(row + 1, 3, work, &summary_num)?;
        if complete && total > 0.0 {
            sheet.write_number_with_format(
                row + 1,
                6,
                work / total,
                &summary_num.clone().set_num_format("0.00%"),
            )?;
        }
        row += 3;
        let guidance = if purpose_scope.is_some() {
            "목적 필터를 적용한 일부 내역의 합계·비율입니다. 월 전체 또는 과세기간 전체 비율이 아닙니다."
        } else {
            "합계는 선택 차량·조회기간 기준입니다. 과세기간 전체 자료로 사용하려면 조회 범위와 누락 정보를 확인해 주세요."
        };
        let odometer_guidance = if odometer_count < trips.len() {
            format!("계기판 거리 미입력·확인 필요 {}건: ⑤⑥은 공란, 유효한 운행기록 거리는 ⑦에 대체 표시합니다. 실제 기록을 확인해 주세요.", trips.len() - odometer_count)
        } else {
            "계기판 차이(⑥−⑤)를 ⑦에 반영합니다. 조회 범위와 사용자(차량 이용자) 정보를 확인해 주세요.".into()
        };
        let mut guidance_lines = vec![guidance, "계기판 입력만으로 미확정 운행을 합계에 포함하지 않습니다. 종료·거리 미확인 운행은 합계 제외하며, 미확정 또는 용무 미지정이 있으면 비율은 공란입니다.", &odometer_guidance];
        if !trips.is_empty() {
            guidance_lines.push("대체·참고 값은 GPS 계산 또는 검토·보정된 운행기록 거리입니다. 계기판 실제 기록과 다를 수 있습니다.");
        }
        if super::subject_projection::current().is_some() {
            guidance_lines.push(super::subject_projection::NOTE);
        }
        // Excel prints a row as a unit. Keep the guidance together instead of
        // reserving 32 points for each short sentence and orphaning the last one.
        // The estimate respects Korean width and explicit newlines, without
        // shrinking the font or forcing an entire trip list onto one page.
        let guidance_block = guidance_lines.join("\n");
        sheet.merge_range(row, 0, row, 8, &guidance_block, &note_fmt)?;
        sheet.set_row_height(row, 14.0 * text_lines(&guidance_block, 150) as f64 + 10.0)?;
        row += 1;
        sheet.set_print_area(0, 0, row - 1, 8)?;
        // Preserve management metadata from the previous export below the print
        // form. Vehicle department here never substitutes for the user's field.
        let reference = nts_reference_info(ctx.corp, device);
        if !reference.is_empty() {
            sheet.merge_range(
                row + 1,
                0,
                row + 1,
                8,
                "참고용 차량 관리 정보 (인쇄영역 외)",
                &section,
            )?;
            sheet.set_row_height(row + 1, 25)?;
            sheet.merge_range(row + 2, 0, row + 2, 8, &reference, &note_fmt)?;
            sheet.set_row_height(
                row + 2,
                (14.0 * text_lines(&reference, 150) as f64 + 12.0).max(30.0),
            )?;
        }
    }

    // Each appendix contains one vehicle, so its repeated footer can identify
    // the vehicle accurately on every page, including continuation pages.
    let note_groups: Vec<_> = detail_notes
        .chunk_by(|left, right| left.1 == right.1)
        .collect();
    for notes in note_groups {
        let sheet = wb.add_worksheet();
        let (appendix_name, footer) = &note_pages[&notes[0].1];
        sheet.set_name(appendix_name)?;
        configure_nts_page(sheet);
        sheet.set_footer(footer);
        sheet.set_column_width(0, 10)?;
        sheet.set_column_width(1, 24)?;
        sheet.set_column_width(2, 96)?;
        sheet.merge_range(0, 0, 0, 2, "업무용승용차 운행기록부 · 상세 비고", &section)?;
        sheet.set_row_height(0, 28)?;
        sheet.merge_range(1, 0, 1, 2, &scope, &note_fmt)?;
        sheet.set_row_height(1, 30)?;
        for (col, text) in [
            "번호",
            "차량 시트 / 사용일자",
            "비고 원문 (이어지는 행 포함)",
        ]
        .iter()
        .enumerate()
        {
            sheet.write_string_with_format(2, col as u16, *text, &label)?;
        }
        sheet.set_row_height(2, 26)?;
        sheet.set_repeat_rows(0, 2)?;
        let mut row = 3;
        for (index, vehicle, date, note) in notes {
            // A bounded row height avoids Excel's 409-point clipping limit.
            // Splitting preserves every character, including newlines and spaces.
            for (part, text) in split_note(note).iter().enumerate() {
                sheet.write_string_with_format(
                    row,
                    0,
                    if part == 0 {
                        index.to_string()
                    } else {
                        format!("{index} 계속")
                    },
                    &cell,
                )?;
                sheet.write_string_with_format(row, 1, format!("{vehicle}\n{date}"), &cell)?;
                sheet.write_string_with_format(row, 2, text, &cell)?;
                sheet.set_row_height(row, (14.0 * text_lines(text, 90) as f64 + 12.0).max(40.0))?;
                row += 1;
            }
        }
        sheet.set_print_area(0, 0, row - 1, 2)?;
    }
    if ctx.per_device.is_empty() {
        let sheet = wb.add_worksheet();
        sheet.set_name("운행기록부")?;
        configure_nts_page(sheet);
        sheet.set_column_width(0, 110)?;
        sheet.write_string_with_format(0, 0, "업무용승용차 운행기록부", &section)?;
        sheet.write_string_with_format(1, 0, &scope, &note_fmt)?;
        sheet.write_string_with_format(2, 0, "조건에 맞는 차량이 없습니다.", &note_fmt)?;
        sheet.set_row_height(1, 32)?;
        sheet.set_print_area(0, 0, 2, 0)?;
    }
    if super::subject_projection::current().is_some() {
        let sheet = wb.add_worksheet();
        sheet.set_name("조회 범위")?;
        sheet.set_column_width(0, 100)?;
        sheet.write_string(0, 0, super::subject_projection::NOTE)?;
    }
    wb.save_to_buffer()
}

// ═══════════════════════════════════════════════════════════════
// 우리 전용 서식 — 정보량 많음, 조직 실무용.
// 첫 sheet: 전 차량 요약 (부서별 그룹, 유류비 추정)
// 다음 sheet: 차량별 상세 (좌표 · 유류 · 비고 등 확장 열)
// ═══════════════════════════════════════════════════════════════
pub fn build_ours(ctx: &ReportContext) -> Result<Vec<u8>, XlsxError> {
    let mut wb = Workbook::new();
    let title_fmt = title_format();
    let subtitle = subtitle_format();
    let header_fmt = table_header_format();
    let cell_fmt = table_cell_format();
    let cell_num = table_cell_num_format();
    let cell_won = table_cell_won_format();
    let label_fmt = header_label_format();
    let summary_fmt = summary_format();

    // ── Sheet 1: 요약 ─────────────────────────────────
    let summary = wb.add_worksheet();
    summary.set_name("요약")?;
    summary.merge_range(
        0,
        0,
        0,
        8,
        &format!("{} 월간 운행 리포트", ctx.month_ym),
        &title_fmt,
    )?;
    summary.set_row_height(0, 28.0)?;
    summary.merge_range(
        1,
        0,
        1,
        8,
        &ctx.corp
            .company_name
            .clone()
            .unwrap_or_else(|| "회사명 미입력".into()),
        &subtitle,
    )?;
    if let Some(purposes) = purpose_filter_label(ctx.purpose_filter.as_deref()) {
        summary.merge_range(2, 0, 2, 8,
            &format!("목적 필터: {purposes} · 표시된 합계·비율은 필터 적용 내역이며 월 전체 기준이 아닙니다."),
            &table_cell_format().set_text_wrap())?;
        summary.set_row_height(2, 32)?;
    }

    let cols = [
        "차량명",
        "차량번호",
        "부서",
        "연식",
        "연료",
        "총 km",
        "업무 km",
        "업무%",
        "유류비 추정(원)",
    ];
    let row0 = 3u32;
    for (i, c) in cols.iter().enumerate() {
        summary.write_string_with_format(row0, i as u16, *c, &header_fmt)?;
    }

    let mut grand_total = 0f64;
    let mut grand_biz = 0f64;
    let mut grand_cost = 0i64;
    let mut r = row0 + 1;
    for (d, trips) in ctx.per_device.iter() {
        let mut total_km = 0f64;
        let mut biz_km = 0f64;
        let mut ann_cost = 0i64;
        for t in trips {
            // Entered costs remain valid even when GPS distance needs review.
            if let Some(c) = t.fuel_cost_krw {
                ann_cost += c;
            }
            let Some(meters) = confirmed_meters(t) else {
                continue;
            };
            let dist_km = meters / 1000.0;
            total_km += dist_km;
            if t.purpose.as_deref() == Some("business") {
                biz_km += dist_km;
            }
        }
        // 유류비: 사용자 수기 입력 합계 우선, 없으면 자동 추정.
        let est_cost = if ann_cost > 0 {
            ann_cost
        } else if let (Some(kmpl), Some(ft)) = (d.fuel_efficiency_kmpl, d.fuel_type.as_deref()) {
            if kmpl > 0.0 {
                ((total_km / kmpl as f64) * (ctx.fuel_price)(ft) as f64) as i64
            } else {
                0
            }
        } else {
            0
        };
        let pct = if total_km > 0.001 {
            (biz_km / total_km) * 100.0
        } else {
            0.0
        };
        grand_total += total_km;
        grand_biz += biz_km;
        grand_cost += est_cost;

        summary.write_string_with_format(
            r,
            0,
            d.display_name
                .clone()
                .unwrap_or_else(|| d.device_uid.clone()),
            &cell_fmt,
        )?;
        summary.write_string_with_format(
            r,
            1,
            d.license_plate.clone().unwrap_or_default(),
            &cell_fmt,
        )?;
        summary.write_string_with_format(
            r,
            2,
            d.department.clone().unwrap_or_default(),
            &cell_fmt,
        )?;
        summary.write_string_with_format(
            r,
            3,
            d.model_year.map(|y| y.to_string()).unwrap_or_default(),
            &cell_fmt,
        )?;
        summary.write_string_with_format(r, 4, fuel_type_ko(d.fuel_type.as_deref()), &cell_fmt)?;
        summary.write_number_with_format(r, 5, total_km, &cell_num)?;
        summary.write_number_with_format(r, 6, biz_km, &cell_num)?;
        summary.write_number_with_format(r, 7, pct, &cell_num)?;
        summary.write_number_with_format(r, 8, est_cost as f64, &cell_won)?;
        r += 1;
    }

    // 총계 row
    let grand_pct = if grand_total > 0.001 {
        (grand_biz / grand_total) * 100.0
    } else {
        0.0
    };
    summary.merge_range(r, 0, r, 4, "총계", &label_fmt)?;
    summary.write_number_with_format(r, 5, grand_total, &summary_fmt)?;
    summary.write_number_with_format(r, 6, grand_biz, &summary_fmt)?;
    summary.write_number_with_format(r, 7, grand_pct, &summary_fmt)?;
    summary.write_number_with_format(r, 8, grand_cost as f64, &cell_won)?;

    for (i, w) in [16.0, 12.0, 12.0, 8.0, 10.0, 12.0, 12.0, 10.0, 18.0]
        .iter()
        .enumerate()
    {
        summary.set_column_width(i as u16, *w)?;
    }

    // ── Sheet N: 차량별 상세 ─────────────────────────
    for (i, (d, trips)) in ctx.per_device.iter().enumerate() {
        let sheet = wb.add_worksheet();
        let plate = d
            .license_plate
            .clone()
            .unwrap_or_else(|| format!("차량{}", i + 1));
        let name = short_sheet_name(&plate, i);
        sheet.set_name(&name)?;

        sheet.merge_range(0, 0, 0, 10, &format!("{plate} 상세 운행"), &title_fmt)?;
        sheet.set_row_height(0, 24.0)?;
        if let Some(purposes) = purpose_filter_label(ctx.purpose_filter.as_deref()) {
            sheet.merge_range(
                1,
                0,
                1,
                10,
                &format!("목적 필터: {purposes} · 선택 목적의 운행만 포함합니다."),
                &cell_fmt.clone().set_text_wrap(),
            )?;
            sheet.set_row_height(1, 27)?;
        }

        let cols = [
            "사용일자",
            "시작시각",
            "종료시각",
            "주행거리(km)",
            "출발지",
            "도착지",
            "사용목적",
            "사용자",
            "유류(L)",
            "유류비(원)",
            "기록 상태",
        ];
        for (ci, c) in cols.iter().enumerate() {
            sheet.write_string_with_format(2, ci as u16, *c, &header_fmt)?;
        }
        let mut row = 3u32;
        for t in trips {
            sheet.write_string_with_format(row, 0, fmt_date_kst(&t.started_at), &cell_fmt)?;
            sheet.write_string_with_format(row, 1, fmt_time_kst(&t.started_at), &cell_fmt)?;
            sheet.write_string_with_format(
                row,
                2,
                t.ended_at
                    .map(|e| {
                        if fmt_date_kst(&e) == fmt_date_kst(&t.started_at) {
                            fmt_time_kst(&e)
                        } else {
                            format!("{} {}", fmt_date_kst(&e), fmt_time_kst(&e))
                        }
                    })
                    .unwrap_or_else(|| "종료 미수신".into()),
                &cell_fmt,
            )?;
            if let Some(meters) = recorded_meters(t) {
                sheet.write_number_with_format(row, 3, meters / 1000.0, &cell_num)?;
            } else {
                sheet.write_blank(row, 3, &cell_num)?;
            }
            sheet.write_string_with_format(
                row,
                4,
                t.start_address.clone().unwrap_or_default(),
                &cell_fmt,
            )?;
            sheet.write_string_with_format(
                row,
                5,
                t.end_address.clone().unwrap_or_default(),
                &cell_fmt,
            )?;
            sheet.write_string_with_format(
                row,
                6,
                purpose_ko(t.purpose.as_deref(), t.purpose_note.as_deref()),
                &cell_fmt,
            )?;
            sheet.write_string_with_format(
                row,
                7,
                t.driver_name.clone().unwrap_or_default(),
                &cell_fmt,
            )?;
            if let Some(l) = t.fuel_liters {
                sheet.write_number_with_format(row, 8, l, &cell_num)?;
            }
            if let Some(c) = t.fuel_cost_krw {
                sheet.write_number_with_format(row, 9, c as f64, &cell_won)?;
            }
            sheet.write_string_with_format(row, 10, &t.quality_note, &cell_fmt)?;
            row += 1;
        }

        for (i, w) in [
            12.0, 10.0, 20.0, 12.0, 28.0, 28.0, 16.0, 12.0, 10.0, 14.0, 26.0,
        ]
        .iter()
        .enumerate()
        {
            sheet.set_column_width(i as u16, *w)?;
        }
    }

    if super::subject_projection::current().is_some() {
        let sheet = wb.add_worksheet();
        sheet.set_name("조회 범위")?;
        sheet.set_column_width(0, 100)?;
        sheet.write_string(0, 0, super::subject_projection::NOTE)?;
    }
    wb.save_to_buffer()
}

// Labels are also used in filenames, so only known labels enter the filename.
// Unknown values still leave an explicit filter marker instead of looking unfiltered.
pub fn purpose_filter_label(filter: Option<&[String]>) -> Option<String> {
    let filter = filter.filter(|values| !values.is_empty())?;
    let choices = [
        ("business", "업무"),
        ("commute", "출퇴근"),
        ("other", "기타"),
        ("unspecified", "미지정"),
    ];
    let mut labels: Vec<&str> = choices
        .iter()
        .filter(|(key, _)| filter.iter().any(|value| value == key))
        .map(|(_, label)| *label)
        .collect();
    let unknown = filter
        .iter()
        .any(|value| !choices.iter().any(|(key, _)| value == key));
    if labels.len() == choices.len() && !unknown {
        return None;
    }
    if unknown {
        labels.push("알수없는목적");
    }
    Some(labels.join("·"))
}

// Use only the vehicles actually included by the server. Names never include a
// SIM identifier, driver, company registration number, or a raw request value.
pub fn report_filename(ctx: &ReportContext, kind: &str, all_vehicles: bool) -> String {
    let kind_label = if kind == "nts" {
        "국세청양식"
    } else {
        "우리양식"
    };
    let scope = purpose_filter_label(ctx.purpose_filter.as_deref())
        .map(|label| format!("_목적-{}", label.replace('·', "-")))
        .unwrap_or_default();
    let vehicle_scope = match ctx.per_device.as_slice() {
        [] => "대상차량없음".to_string(),
        [(vehicle, _)] => {
            let name = filename_identity_part(vehicle.display_name.as_deref().unwrap_or(""));
            let plate = filename_identity_part(vehicle.license_plate.as_deref().unwrap_or(""));
            match (name.is_empty(), plate.is_empty()) {
                (true, true) => "차량정보미등록".to_string(),
                (true, false) => plate,
                (false, true) => format!("{name}_차량번호미등록"),
                (false, false) if name == plate => plate,
                (false, false) => format!("{name}_{plate}"),
            }
        }
        vehicles => format!(
            "{}차량{}대",
            if all_vehicles { "전체" } else { "선택" },
            vehicles.len()
        ),
    };
    format!(
        "운행기록부_{vehicle_scope}_{}_{kind_label}{scope}.xlsx",
        ctx.month_ym.replace('-', "")
    )
}

fn filename_identity_part(value: &str) -> String {
    // Keep Korean/Unicode names readable, but exclude filesystem separators,
    // control/bidi characters and punctuation that can resemble an extension.
    // Each identity is capped in UTF-8 bytes, keeping the whole filename under
    // common filesystem limits even with two Korean identities and all filters.
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '(' | ')') {
                c
            } else {
                ' '
            }
        })
        .collect();
    let normalized = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut bytes = 0;
    normalized
        .chars()
        .take_while(|c| {
            bytes += c.len_utf8();
            bytes <= 60
        })
        .collect::<String>()
        .trim_matches([' ', '-', '_'])
        .to_string()
}

fn nts_cell_format() -> Format {
    Format::new()
        .set_font_name("맑은 고딕")
        .set_font_size(10)
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0x68717C))
        .set_text_wrap()
        .set_align(FormatAlign::VerticalCenter)
}

fn nts_reference_info(corp: &CorpInfoLite, device: &DeviceLite) -> String {
    let vehicle_type = device.vehicle_type.as_deref().map(|value| {
        match value {
            "sedan" => "승용",
            "van" => "승합",
            "truck" => "화물",
            "special" => "특수",
            "ev" => "전기",
            other => other,
        }
        .to_string()
    });
    [
        ("차량명", device.display_name.clone()),
        ("대표자", corp.representative.clone()),
        ("연식", device.model_year.map(|v| v.to_string())),
        ("배기량(cc)", device.engine_cc.map(|v| v.to_string())),
        ("취득일", device.acquired_at.map(|v| v.to_string())),
        (
            "취득가액(원)",
            device.purchase_price_krw.map(|v| v.to_string()),
        ),
        ("차량 소속 부서", device.department.clone()),
        ("차량유형", vehicle_type),
    ]
    .into_iter()
    .filter_map(|(label, value)| {
        value
            .filter(|v| !v.is_empty())
            .map(|v| format!("{label}: {v}"))
    })
    .collect::<Vec<_>>()
    .join(" · ")
}

fn configure_nts_page(sheet: &mut Worksheet) {
    sheet
        .set_landscape()
        .set_paper_size(9)
        .set_print_fit_to_pages(1, 0)
        .set_margins(0.3, 0.3, 0.35, 0.35, 0.15, 0.15)
        .set_footer("&R&P / &N")
        .set_print_center_horizontally(true)
        .set_screen_gridlines(false);
}

fn nts_trip_note(t: &TripLite) -> String {
    let mut notes = vec![
        purpose_ko(t.purpose.as_deref(), None),
        t.quality_note.clone(),
    ];
    if nts_distance(t).is_none() {
        notes.push("미확정·종료·거리 확인 필요 · 합계 제외".into());
    }
    if let Some([before, after]) = nts_odometer(t) {
        let measured = ((after - before) * 100.0).round() / 100.0;
        let record_note = record_distance(t)
            .filter(|recorded| *recorded != measured)
            .map(|recorded| format!(" · 운행기록 거리 참고 {recorded:.2} km"))
            .unwrap_or_default();
        notes.push(format!("계기판 차이 적용{record_note}"));
    } else {
        notes.push(format!(
            "계기판 미입력·확인 필요 · {}",
            if record_distance(t).is_some() {
                "운행기록 거리 기준"
            } else {
                "운행기록 거리 확인 필요"
            }
        ));
    }
    if t.driver_name.as_deref().is_none_or(|s| s.trim().is_empty()) {
        notes.push("성명 미지정".into());
    }
    for value in [t.purpose_note.as_deref(), t.note.as_deref()]
        .into_iter()
        .flatten()
    {
        if !value.is_empty() {
            notes.push(value.to_string());
        }
    }
    notes.push(format!(
        "{}~{}",
        fmt_time_kst(&t.started_at),
        t.ended_at
            .map(|v| {
                if kst(v).date_naive() != kst(t.started_at).date_naive() {
                    format!("{} {}", fmt_date_kst(&v), fmt_time_kst(&v))
                } else {
                    fmt_time_kst(&v)
                }
            })
            .unwrap_or_else(|| "종료 미수신".into())
    ));
    notes
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
}

// Conservative display-width estimate for wrapped Korean/Latin text.
fn text_lines(text: &str, columns: usize) -> usize {
    text.split('\n')
        .map(|line| {
            line.chars()
                .filter(|c| *c != '\r')
                .map(|c| if c.is_ascii() { 1 } else { 2 })
                .sum::<usize>()
                .div_ceil(columns)
                .max(1)
        })
        .sum()
}

fn split_note(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut width = 0;
    let mut newlines = 0;
    for ch in text.chars() {
        if width >= 540 || newlines >= 6 {
            parts.push(std::mem::take(&mut part));
            width = 0;
            newlines = 0;
        }
        part.push(ch);
        width += if ch.is_ascii() { 1 } else { 2 };
        if ch == '\n' {
            newlines += 1;
        }
    }
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}

// ── 포맷 헬퍼 ─────────────────────────────────────────
fn title_format() -> Format {
    Format::new()
        .set_bold()
        .set_font_size(16)
        .set_align(FormatAlign::Center)
}
fn subtitle_format() -> Format {
    Format::new()
        .set_font_size(11)
        .set_font_color(Color::RGB(0x666666))
        .set_align(FormatAlign::Center)
}
fn table_header_format() -> Format {
    Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xE9EDF5))
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
}
fn table_cell_format() -> Format {
    Format::new()
        .set_border(FormatBorder::Thin)
        .set_font_size(10)
}
fn table_cell_num_format() -> Format {
    Format::new()
        .set_border(FormatBorder::Thin)
        .set_font_size(10)
        .set_num_format("#,##0.0")
}
fn table_cell_won_format() -> Format {
    Format::new()
        .set_border(FormatBorder::Thin)
        .set_font_size(10)
        .set_num_format("#,##0")
}
fn header_label_format() -> Format {
    Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xF3F4F6))
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
}
fn summary_format() -> Format {
    Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_num_format("#,##0.0")
}

// ── 값 변환 ───────────────────────────────────────────
fn kst(t: DateTime<Utc>) -> DateTime<chrono::FixedOffset> {
    t.with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap())
}
fn fmt_date_kst(t: &DateTime<Utc>) -> String {
    kst(*t).format("%Y-%m-%d").to_string()
}
fn fmt_time_kst(t: &DateTime<Utc>) -> String {
    kst(*t).format("%H:%M").to_string()
}
fn purpose_ko(p: Option<&str>, note: Option<&str>) -> String {
    let base = match p {
        Some("business") => "업무",
        Some("commute") => "출퇴근",
        Some("other") => "기타",
        _ => "미지정",
    };
    match (p, note) {
        (Some("other"), Some(n)) if !n.is_empty() => format!("기타: {n}"),
        _ => base.into(),
    }
}
fn fuel_type_ko(t: Option<&str>) -> String {
    match t {
        Some("gasoline") => "휘발유",
        Some("diesel") => "경유",
        Some("lpg") => "LPG",
        Some("ev") => "전기",
        _ => "",
    }
    .into()
}
// Excel sheet 이름 제약: 최대 31자, / \ ? * [ ] : 금지.
fn short_sheet_name(name: &str, idx: usize) -> String {
    let cleaned: String = name.chars().filter(|c| !"/\\?*[]:".contains(*c)).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("차량{}", idx + 1);
    }
    let mut out = String::new();
    for ch in trimmed.chars() {
        if out
            .chars()
            .map(|c| if c.is_ascii() { 1 } else { 2 })
            .sum::<usize>()
            + (if ch.is_ascii() { 1 } else { 2 })
            > 28
        {
            break;
        }
        out.push(ch);
    }
    if out.is_empty() {
        format!("차량{}", idx + 1)
    } else {
        out
    }
}

fn nts_odometer(t: &TripLite) -> Option<[f64; 2]> {
    let (before, after) = (t.odometer_before_km?, t.odometer_after_km?);
    let valid = |v: f64| {
        v.is_finite()
            && (0.0..=9_999_999.99).contains(&v)
            && (v * 100.0 - (v * 100.0).round()).abs() <= 0.000001
    };
    (valid(before) && valid(after) && after >= before).then_some([before, after])
}

fn recorded_meters(t: &TripLite) -> Option<f64> {
    t.distance_m.filter(|m| m.is_finite() && *m >= 0.0)
}

fn confirmed_meters(t: &TripLite) -> Option<f64> {
    if !t.report_included || t.ended_at.is_none_or(|end| end <= t.started_at) {
        return None;
    }
    recorded_meters(t)
}

fn record_distance(t: &TripLite) -> Option<f64> {
    recorded_meters(t).map(|m| (m / 10.0).round() / 100.0)
}

// HWP instruction 7: ⑦ = ⑥ - ⑤ for measured readings. Trip distance is explicit
// fallback and may be GPS-derived, manually corrected, or a merged source sum.
// This does not alter the original trip distance or confirm its data quality.
fn nts_row_distance(t: &TripLite) -> Option<f64> {
    nts_odometer(t)
        .map(|[before, after]| ((after - before) * 100.0).round() / 100.0)
        .or_else(|| record_distance(t))
}

// [total, commute, general business], rounded to the precision written to Excel.
fn nts_distance(t: &TripLite) -> Option<[f64; 3]> {
    confirmed_meters(t)?;
    let km = nts_row_distance(t)?;
    Some([
        km,
        if t.purpose.as_deref() == Some("commute") {
            km
        } else {
            0.0
        },
        if t.purpose.as_deref() == Some("business") {
            km
        } else {
            0.0
        },
    ])
}
#[cfg(test)]
mod nts_tests {
    use super::*;
    fn filename_device(name: Option<&str>, plate: Option<&str>) -> DeviceLite {
        DeviceLite {
            display_name: name.map(str::to_string),
            license_plate: plate.map(str::to_string),
            device_uid: "PRIVATE-SIM-UID".into(),
            car_model: None,
            model_year: None,
            engine_cc: None,
            purchase_price_krw: None,
            acquired_at: None,
            department: Some("PRIVATE-DEPARTMENT".into()),
            vehicle_type: None,
            fuel_efficiency_kmpl: None,
            fuel_type: None,
        }
    }
    fn filename_for(
        vehicles: &[DeviceLite],
        kind: &str,
        filter: Option<Vec<String>>,
        all_vehicles: bool,
    ) -> String {
        let corp = CorpInfoLite {
            business_number: Some("PRIVATE-BUSINESS-NUMBER".into()),
            company_name: Some("PRIVATE-COMPANY".into()),
            representative: None,
        };
        let ctx = ReportContext {
            month_ym: "2026-11".into(),
            purpose_filter: filter,
            corp: &corp,
            per_device: vehicles.iter().map(|vehicle| (vehicle, vec![])).collect(),
            fuel_price: Box::new(|_| 0),
        };
        report_filename(&ctx, kind, all_vehicles)
    }
    fn trip() -> TripLite {
        TripLite {
            started_at: DateTime::parse_from_rfc3339("2026-10-28T15:01:00Z")
                .unwrap()
                .to_utc(),
            ended_at: Some(
                DateTime::parse_from_rfc3339("2026-10-28T16:01:00Z")
                    .unwrap()
                    .to_utc(),
            ),
            distance_m: Some(10004.0),
            report_included: true,
            quality_note: "확정".into(),
            start_address: None,
            end_address: None,
            purpose: Some("commute".into()),
            purpose_note: None,
            note: None,
            driver_name: None,
            driver_department: None,
            odometer_before_km: None,
            odometer_after_km: None,
            fuel_liters: None,
            fuel_cost_krw: None,
        }
    }
    #[test]
    fn commute_and_general_business_are_separate_columns() {
        let mut t = trip();
        assert_eq!(nts_distance(&t), Some([10.0, 10.0, 0.0]));
        t.purpose = Some("business".into());
        assert_eq!(nts_distance(&t), Some([10.0, 0.0, 10.0]));
        t.purpose = None;
        assert_eq!(nts_distance(&t), Some([10.0, 0.0, 0.0]));
    }
    #[test]
    fn invalid_and_open_trips_do_not_enter_totals() {
        let mut t = trip();
        t.ended_at = None;
        assert_eq!(nts_distance(&t), None);
        t = trip();
        t.distance_m = None;
        assert_eq!(nts_row_distance(&t), None);
        assert_eq!(nts_distance(&t), None);
        t.distance_m = Some(f64::NAN);
        assert_eq!(nts_distance(&t), None);
        t = trip();
        t.distance_m = Some(-1.0);
        assert_eq!(nts_distance(&t), None);
        t = trip();
        t.distance_m = Some(0.0);
        assert_eq!(nts_distance(&t), Some([0.0, 0.0, 0.0]));
    }
    #[test]
    fn measured_distance_uses_readings_preserves_gps_and_accepts_zero() {
        let mut t = trip();
        t.odometer_before_km = Some(1234.56);
        t.odometer_after_km = Some(1246.90);
        assert_eq!(nts_odometer(&t), Some([1234.56, 1246.90]));
        assert_eq!(nts_distance(&t), Some([12.34, 12.34, 0.0]));
        assert_eq!(t.distance_m, Some(10004.0));
        assert!(nts_trip_note(&t).contains("운행기록 거리 참고 10.00 km"));
        t.odometer_before_km = Some(0.0);
        t.odometer_after_km = Some(0.0);
        assert_eq!(nts_distance(&t), Some([0.0, 0.0, 0.0]));
        t.odometer_before_km = Some(9_999_999.98);
        t.odometer_after_km = Some(9_999_999.99);
        assert_eq!(nts_row_distance(&t), Some(0.01));
    }
    #[test]
    fn invalid_odometer_pairs_are_blank_and_use_explicit_gps_fallback() {
        for (before, after) in [
            (None, Some(10.0)),
            (Some(0.0), None),
            (Some(-1.0), Some(10.0)),
            (Some(11.0), Some(10.0)),
            (Some(f64::NAN), Some(10.0)),
            (Some(0.0), Some(f64::INFINITY)),
            (Some(0.0), Some(10_000_000.0)),
            (Some(0.0), Some(1.001)),
        ] {
            let mut t = trip();
            t.odometer_before_km = before;
            t.odometer_after_km = after;
            assert_eq!(nts_odometer(&t), None);
            assert_eq!(nts_row_distance(&t), Some(10.0));
            assert!(nts_trip_note(&t).contains("계기판 미입력·확인 필요 · 운행기록 거리 기준"));
        }
    }
    #[test]
    fn measured_values_do_not_confirm_quality_or_include_invalid_trips() {
        for variant in 0..3 {
            let mut t = trip();
            t.odometer_before_km = Some(100.0);
            t.odometer_after_km = Some(120.0);
            match variant {
                0 => t.report_included = false,
                1 => t.ended_at = None,
                _ => t.distance_m = Some(f64::NAN),
            }
            assert_eq!(nts_row_distance(&t), Some(20.0));
            assert_eq!(nts_distance(&t), None);
            assert!(nts_trip_note(&t).contains("합계 제외"));
        }
    }
    #[test]
    fn corrected_distance_fallback_is_not_asserted_as_raw_gps() {
        let mut t = trip();
        t.distance_m = Some(42_500.0);
        t.quality_note = "사용자 확인·거리 보정".into();
        assert_eq!(nts_row_distance(&t), Some(42.5));
        let note = nts_trip_note(&t);
        assert!(note.contains("운행기록 거리 기준"));
        assert!(!note.contains("GPS 기준"));
    }
    #[test]
    fn purpose_filter_is_explicit_in_body_label_and_filename() {
        let vehicles = [filename_device(Some("영업 1호"), Some("123가4567"))];
        let values = vec!["commute".into(), "business".into(), "business".into()];
        assert_eq!(
            purpose_filter_label(Some(&values)),
            Some("업무·출퇴근".into())
        );
        assert_eq!(
            filename_for(&vehicles, "nts", Some(values), false),
            "운행기록부_영업 1호_123가4567_202611_국세청양식_목적-업무-출퇴근.xlsx"
        );
        let all = vec![
            "business".into(),
            "commute".into(),
            "other".into(),
            "unspecified".into(),
        ];
        assert_eq!(purpose_filter_label(Some(&all)), None);
        assert_eq!(
            filename_for(&vehicles, "nts", Some(all), false),
            "운행기록부_영업 1호_123가4567_202611_국세청양식.xlsx"
        );
        let unknown = vec!["../../bad".into()];
        assert_eq!(
            filename_for(&vehicles, "nts", Some(unknown), false),
            "운행기록부_영업 1호_123가4567_202611_국세청양식_목적-알수없는목적.xlsx"
        );
    }
    #[test]
    fn filename_uses_resolved_vehicle_count_without_listing_other_vehicle_names() {
        let vehicles = [
            filename_device(Some("동일한 이름"), Some("123가4567")),
            filename_device(Some("동일한 이름"), Some("123가4567")),
        ];
        assert_eq!(
            filename_for(&vehicles, "nts", None, true),
            "운행기록부_전체차량2대_202611_국세청양식.xlsx"
        );
        assert_eq!(
            filename_for(&vehicles, "ours", None, false),
            "운행기록부_선택차량2대_202611_우리양식.xlsx"
        );
        assert_eq!(
            filename_for(&[], "nts", None, false),
            "운행기록부_대상차량없음_202611_국세청양식.xlsx"
        );
    }
    #[test]
    fn filename_handles_missing_and_duplicate_vehicle_labels_without_sim_fallbacks() {
        for (name, plate, identity) in [
            (Some("영업1호"), None, "영업1호_차량번호미등록"),
            (None, Some("123가4567"), "123가4567"),
            (Some("123가4567"), Some(" 123가4567 "), "123가4567"),
            (None, None, "차량정보미등록"),
            (
                Some("./\\<>:\"|?*\r\n\u{202e}"),
                Some("..."),
                "차량정보미등록",
            ),
        ] {
            let result = filename_for(&[filename_device(name, plate)], "nts", None, false);
            assert_eq!(
                result,
                format!("운행기록부_{identity}_202611_국세청양식.xlsx")
            );
            assert!(!result.contains("PRIVATE"));
        }
    }
    #[test]
    fn filename_bounds_unicode_identity_and_normalizes_unsafe_whitespace_and_characters() {
        assert_eq!(filename_identity_part(" ../영업 : 1호\r\n\t "), "영업 1호");
        let long_name = "장거리영업차량🚗/".repeat(100);
        let long_plate = "가나다라".repeat(100);
        let filters = vec![
            "business".into(),
            "commute".into(),
            "other".into(),
            "unspecified".into(),
            "../unknown".into(),
        ];
        let result = filename_for(
            &[filename_device(Some(&long_name), Some(&long_plate))],
            "nts",
            Some(filters),
            false,
        );
        assert!(
            result.len() <= 240,
            "UTF-8 filename exceeds filesystem limit: {}",
            result.len()
        );
        assert!(
            result.ends_with("_202611_국세청양식_목적-업무-출퇴근-기타-미지정-알수없는목적.xlsx")
        );
        assert!(!result
            .chars()
            .any(|c| c.is_control()
                || matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '?' | '*' | '|')));
        assert!(!result.contains("  "));
        assert!(!result.contains("PRIVATE"));
    }
    #[test]
    fn long_multiline_notes_preserve_every_character_in_bounded_rows() {
        let original = format!(
            "{}\r\n{}끝표시",
            "용무 메모🙂 / ".repeat(300),
            "\n빈 줄\n".repeat(20)
        );
        let chunks = split_note(&original);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.concat(), original);
        assert!(chunks.iter().all(|part| text_lines(part, 90) <= 13));
        let mut t = trip();
        t.purpose = Some("business".into());
        t.purpose_note = Some("거래처 방문".into());
        t.note = Some(original.clone());
        let note = nts_trip_note(&t);
        assert!(note.contains("거래처 방문"));
        assert!(note.contains(&original));
        t.report_included = false;
        assert!(nts_trip_note(&t).contains("합계 제외"));
    }
}
