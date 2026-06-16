// /api/v1/devices/:id/route/analyze — ChatGPT 기반 운행 인사이트 (rate-limited).

use axum::{extract::{Path, Query, State}, routing::{get, post}, Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    services::{
        credits,
        kakao_geo::{self, Resolved},
        openai::{self, ChatMessage},
    },
    state::AppState,
};

const ENDPOINT: &str = "route_analyze";
const ADMIN_EMAIL: &str = "admin@admin.com";
const COST_PER_ANALYSIS: i64 = 20;       // 회당 20 KRW (포인트)
const MAX_POINTS_TO_GPT: usize = 40;     // 균등 분포 샘플
const MAX_OUT_TOKENS:    u32 = 900;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices/:id/route/analyze",  post(analyze))
        .route("/devices/:id/ai-analyses",    get(list_analyses))
        .route("/ai-analyses/:id",            get(get_analysis).delete(delete_analysis))
        .route("/ai/usage", get(usage_today))
}

// ─── 사용량 조회 ────────────────────────────────────────────────
// 과거 daily limit 모델에서 credit 모델로 전환:
//   - admin email = unlimited
//   - 그 외 = 회당 COST_PER_ANALYSIS 포인트 차감
//   - 잔액 부족 시 charge 가 BadRequest 반환
// 응답 호환: used_today/limit 필드는 프론트가 기존 코드 유지하도록 남겨두되, 의미는 무시.
#[derive(Debug, Serialize)]
struct UsageView {
    used_today:        i64,
    limit:             i64,
    unlimited:         bool,
    cost_per_analysis: i64,
    credit_balance:    i64,
}

async fn usage_today(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<UsageView>> {
    let email = user_email(&state, user.user_id).await?;
    let unlimited = email.as_deref() == Some(ADMIN_EMAIL);
    let used = today_count(&state, user.user_id).await?;
    let bal  = credits::balance(&state.db, user.user_id).await.unwrap_or(0);
    Ok(Json(UsageView {
        used_today:        used,
        limit:             0,                          // legacy
        unlimited,
        cost_per_analysis: COST_PER_ANALYSIS,
        credit_balance:    bal,
    }))
}

// ─── 분석 본 함수 ───────────────────────────────────────────────
#[derive(Debug, Deserialize)]
pub struct AnalyzeRequest {
    pub date: NaiveDate,    // KST 기준 yyyy-mm-dd
}

#[derive(Debug, Serialize)]
pub struct AnalyzeResponse {
    pub date:           NaiveDate,
    pub analysis:       String,
    pub used_today:     i64,
    pub limit:          i64,            // legacy, 프론트 기존 호환용 0
    pub unlimited:      bool,
    pub model:          Option<String>,
    pub credit_charged: i64,
    pub credit_balance: i64,
    pub analysis_id:    Option<i64>,    // 영구 저장된 분석 row id (재조회용)
}

#[derive(Debug, FromRow)]
struct PointRow {
    recorded_at: DateTime<Utc>,
    lat:         Option<f64>,
    lng:         Option<f64>,
}

#[derive(Debug, FromRow)]
struct DailyStatsRow {
    distance_m:    f64,
    moving_s:      i32,
    stop_count:    i32,
    max_speed_kmh: f32,
    avg_speed_kmh: f32,
    first_fix_at:  Option<DateTime<Utc>>,
    last_fix_at:   Option<DateTime<Utc>>,
}

async fn analyze(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    Json(req): Json<AnalyzeRequest>,
) -> AppResult<Json<AnalyzeResponse>> {
    // 본인 소유 + 표시명
    let dev: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT owner_id, display_name FROM devices WHERE id = $1")
            .bind(device_id).fetch_optional(&state.db).await?;
    let (owner, display_name) = dev.ok_or(AppError::NotFound)?;
    if owner != Some(user.user_id) { return Err(AppError::NotFound); }

    // 포인트 차감 (admin email 은 무료). 잔액 부족이면 charge 가 BadRequest.
    let email = user_email(&state, user.user_id).await?;
    let unlimited = email.as_deref() == Some(ADMIN_EMAIL);
    let used = today_count(&state, user.user_id).await?;
    let charged_txn = if unlimited {
        None
    } else {
        Some(credits::charge(
            &state.db, user.user_id, COST_PER_ANALYSIS,
            "ai_analysis", None,
            Some(&format!("device {} {}", device_id, req.date)),
        ).await?)
    };

    // 차감 이후 실패하면 환불해야 함. 분석 본 로직을 inner 로 묶고 결과 처리.
    let outcome: AppResult<(String, Option<String>, Option<i32>, Option<i32>)> = (async {
        // 데이터 적재 — date 를 KST 자정~다음날 자정 범위로 변환
        let start = format!("{}T00:00:00+09:00", req.date);
        let end   = format!("{}T23:59:59+09:00", req.date);
        let start: DateTime<Utc> = chrono::DateTime::parse_from_rfc3339(&start)
            .map_err(|e| AppError::BadRequest(format!("invalid date: {e}")))?.with_timezone(&Utc);
        let end:   DateTime<Utc> = chrono::DateTime::parse_from_rfc3339(&end)
            .map_err(|e| AppError::BadRequest(format!("invalid date: {e}")))?.with_timezone(&Utc);

        let points: Vec<PointRow> = sqlx::query_as(
            r#"SELECT recorded_at, lat, lng
                 FROM location_records
                WHERE device_id = $1 AND user_id = $4 AND fix = TRUE
                  AND recorded_at >= $2 AND recorded_at <= $3
                ORDER BY recorded_at ASC"#,
        )
        .bind(device_id).bind(start).bind(end).bind(user.user_id)
        .fetch_all(&state.db).await?;

        if points.len() < 3 {
            return Err(AppError::BadRequest("이 날짜에 분석할 fix 데이터가 부족합니다.".into()));
        }

        let stats: Option<DailyStatsRow> = sqlx::query_as(
            r#"SELECT distance_m, moving_s, stop_count, max_speed_kmh, avg_speed_kmh,
                      first_fix_at, last_fix_at
                 FROM daily_stats
                WHERE device_id = $1 AND user_id = $3 AND date = $2"#,
        )
        .bind(device_id).bind(req.date).bind(user.user_id)
        .fetch_optional(&state.db).await?;

        let stops = extract_stops(&points, 50.0, 5 * 60);
        let enriched = enrich_speeds(&points);
        let signals = detect_anomalies(&enriched, &stops);
        let geo = resolve_geography(&state.db, &points, &stops).await;

        let prompt = build_prompt(
            display_name.as_deref().unwrap_or("디바이스"),
            req.date, &stops, stats.as_ref(), &signals, &geo,
        );

        let messages = [
            ChatMessage { role: "system", content: SYSTEM_PROMPT },
            ChatMessage { role: "user",   content: &prompt },
        ];
        let result = openai::chat(&messages, MAX_OUT_TOKENS).await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("openai: {e:#}")))?;

        Ok((result.text, result.model, result.tokens_in, result.tokens_out))
    }).await;

    let (text, model, tokens_in, tokens_out) = match outcome {
        Ok(v) => v,
        Err(e) => {
            // 차감했으면 환불 (best-effort)
            if charged_txn.is_some() {
                let _ = credits::refund(
                    &state.db, user.user_id, COST_PER_ANALYSIS,
                    "ai_refund", None, Some("ai_analysis 실패 자동 환불"),
                ).await;
            }
            return Err(e);
        }
    };

    // 사용량 audit (best effort)
    let _ = sqlx::query(
        r#"INSERT INTO ai_usage_log (user_id, endpoint, tokens_in, tokens_out, model)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(user.user_id).bind(ENDPOINT)
    .bind(tokens_in).bind(tokens_out).bind(model.as_deref())
    .execute(&state.db).await;

    // 영구 저장 — 본문 + 메타. 같은 (device,date) 에 여러 번 분석 가능 (이력 누적).
    let charged = if unlimited { 0 } else { COST_PER_ANALYSIS };
    let analysis_id: Option<i64> = sqlx::query_scalar(
        r#"INSERT INTO ai_analyses (user_id, device_id, target_date, analysis, model, tokens_in, tokens_out, cost_credits)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id"#,
    )
    .bind(user.user_id).bind(device_id).bind(req.date)
    .bind(&text).bind(model.as_deref())
    .bind(tokens_in).bind(tokens_out).bind(charged)
    .fetch_optional(&state.db).await.unwrap_or(None);

    let used_today = used + 1;
    let balance = match &charged_txn {
        Some(t) => t.balance,
        None    => credits::balance(&state.db, user.user_id).await.unwrap_or(0),
    };
    Ok(Json(AnalyzeResponse {
        date: req.date,
        analysis: text,
        used_today,
        limit: 0,
        unlimited,
        model,
        credit_charged: charged,
        credit_balance: balance,
        analysis_id,
    }))
}

// ─── 분석 이력 조회 ──────────────────────────────────────
#[derive(Debug, FromRow, Serialize)]
struct AnalysisRow {
    id:           i64,
    device_id:    i64,
    target_date:  NaiveDate,
    analysis:     String,
    model:        Option<String>,
    tokens_in:    Option<i32>,
    tokens_out:   Option<i32>,
    cost_credits: i64,
    created_at:   DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct AnalysisListQuery {
    date:  Option<NaiveDate>,    // 특정 일자 필터 (선택)
    limit: Option<i64>,
}

async fn list_analyses(
    State(state): State<AppState>,
    user: AuthUser,
    Path(device_id): Path<i64>,
    Query(q): Query<AnalysisListQuery>,
) -> AppResult<Json<Vec<AnalysisRow>>> {
    // 본인 디바이스 검증
    let owner: Option<i64> = sqlx::query_scalar(
        "SELECT owner_id FROM devices WHERE id = $1",
    )
    .bind(device_id).fetch_optional(&state.db).await?.flatten();
    if owner != Some(user.user_id) { return Err(AppError::NotFound); }

    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows = if let Some(d) = q.date {
        sqlx::query_as::<_, AnalysisRow>(
            r#"SELECT id, device_id, target_date, analysis, model,
                      tokens_in, tokens_out, cost_credits, created_at
                 FROM ai_analyses
                WHERE device_id = $1 AND user_id = $2 AND target_date = $3
                ORDER BY created_at DESC LIMIT $4"#,
        )
        .bind(device_id).bind(user.user_id).bind(d).bind(limit)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, AnalysisRow>(
            r#"SELECT id, device_id, target_date, analysis, model,
                      tokens_in, tokens_out, cost_credits, created_at
                 FROM ai_analyses
                WHERE device_id = $1 AND user_id = $2
                ORDER BY created_at DESC LIMIT $3"#,
        )
        .bind(device_id).bind(user.user_id).bind(limit)
        .fetch_all(&state.db).await?
    };
    Ok(Json(rows))
}

async fn get_analysis(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<AnalysisRow>> {
    let row: Option<AnalysisRow> = sqlx::query_as(
        r#"SELECT id, device_id, target_date, analysis, model,
                  tokens_in, tokens_out, cost_credits, created_at
             FROM ai_analyses
            WHERE id = $1 AND user_id = $2"#,
    )
    .bind(id).bind(user.user_id).fetch_optional(&state.db).await?;
    Ok(Json(row.ok_or(AppError::NotFound)?))
}

async fn delete_analysis(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let n = sqlx::query("DELETE FROM ai_analyses WHERE id = $1 AND user_id = $2")
        .bind(id).bind(user.user_id)
        .execute(&state.db).await?
        .rows_affected();
    if n == 0 { return Err(AppError::NotFound); }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ─── helpers ────────────────────────────────────────────────────

const SYSTEM_PROMPT: &str = "\
당신은 한국의 렌트카·배달·물류 회사 운영 관리자에게 차량 운행 데이터를 분석해 보고하는 운영 분석가입니다. \
사용자(운영자)는 차량 한 대의 하루치 운행 데이터를 받고 있으며, 즉시 행동 가능한 인사이트를 원합니다. \
\
원칙: \
1) 모든 수치·시간은 입력 데이터에 근거. 데이터에 없는 사실 절대 만들지 말 것. \
2) **위치는 이미 도로명·건물명·동까지 해석되어 입력에 함께 제공됩니다. 좌표를 직접 추측하지 말고 제공된 주소·건물명을 그대로 인용하세요.** \
3) 건물명이 있으면 그 건물의 일반 용도(예: '터미널' → 운수, '○○센터' → 거점, '○○아파트' → 주거지) 관점에서 운영 의미를 풀어주세요. \
4) 추측이 필요하면 '추정' '~으로 보임' 등으로 명시. 단정 금지. \
5) '자동 감지된 이상'으로 입력된 신호는 그대로 인용하고 운영 의미를 설명. \
6) '평소 패턴 대비'·'타 차량 대비' 같은 비교는 데이터에 없으면 하지 말 것. \
7) 광고·정치·민감주제 금지. \
\
출력 형식 (반드시 markdown, 한국어, 4섹션, 섹션 사이 빈 줄): \
\
## 핵심 KPI \
- 이동거리 / 운행시간 / 평균·최고속도 / 정차 횟수 / 야간운행 비중 (있으면) — 1~2줄. \
\
## 특이사항 (운영자 주의) \
- 자동 감지 이상 신호 + 운영 관점 의미 + 권장 확인 사항. \
- 항목 없으면 '특이사항 없음'으로 짧게. \
\
## 운행 패턴 \
- 출발/도착 위치는 입력에 명시된 주소·건물명을 그대로 인용. \
- 경유 지역은 입력 주소를 묶어 '○○동→○○동' 식으로 표현. \
- 도로 유형(시내/국도/고속도로)·이동 거리·평균속도로 추정. \
\
## 권장 조치 \
- 운영자가 즉시 행동할 만한 항목 1~3개 (예: '14:30 5분 비정상 정차 — 운전자 확인'). \
- 없으면 '추가 조치 불필요'. \
\
어조: 객관·간결·정량 우선. 700자 이내.";

// ─── 주소 사전 해석 ────────────────────────────────────────────
//
// 정차 좌표 + 출발/종료/경유 waypoint 좌표를 카카오 API로 한 번에 해석.
// GPT 입력 토큰을 줄이면서 정확도를 높임.

struct GeoContext {
    stop_addrs:     Vec<Option<Resolved>>,         // index = stop index
    start_addr:     Option<Resolved>,
    end_addr:       Option<Resolved>,
    waypoint_addrs: Vec<(DateTime<Utc>, Resolved)>, // 시간 정렬, 4점 균등 분포
}

async fn resolve_geography(
    db: &sqlx::PgPool,
    points: &[PointRow],
    stops: &[(DateTime<Utc>, DateTime<Utc>, f64, f64)],
) -> GeoContext {
    // 좌표 모음 — 동시 호출
    let mut coords: Vec<(f64, f64)> = Vec::new();
    // [0..stops.len()) = stops
    for (_, _, la, ln) in stops { coords.push((*la, *ln)); }

    // 시작/끝
    let start_lat_lng = points.iter().find_map(|p| Some((p.lat?, p.lng?)));
    let end_lat_lng   = points.iter().rev().find_map(|p| Some((p.lat?, p.lng?)));
    let start_idx = coords.len();
    if let Some(c) = start_lat_lng { coords.push(c); }
    let end_idx = coords.len();
    if let Some(c) = end_lat_lng { coords.push(c); }

    // 경유 waypoints — 시간 균등 4점 (출발/도착 제외)
    let wp_times: Vec<DateTime<Utc>> = {
        let mut v = vec![];
        let pts: Vec<&PointRow> = points.iter()
            .filter(|p| p.lat.is_some() && p.lng.is_some()).collect();
        if pts.len() >= 6 {
            for i in 1..=4 {
                let idx = (pts.len() * i) / 5;
                v.push(pts[idx].recorded_at);
            }
        }
        v
    };
    let waypoint_start = coords.len();
    for t in &wp_times {
        let p = points.iter().find(|p| p.recorded_at == *t);
        if let Some(p) = p {
            if let (Some(la), Some(ln)) = (p.lat, p.lng) {
                coords.push((la, ln));
            }
        }
    }

    let resolved = kakao_geo::reverse_many_cached(db, &coords).await;

    let stop_addrs: Vec<Option<Resolved>> = (0..stops.len())
        .map(|i| resolved.get(i).cloned().flatten())
        .collect();
    let start_addr = if start_lat_lng.is_some() { resolved.get(start_idx).cloned().flatten() } else { None };
    let end_addr   = if end_lat_lng.is_some()   { resolved.get(end_idx).cloned().flatten() } else { None };
    let mut waypoint_addrs: Vec<(DateTime<Utc>, Resolved)> = Vec::new();
    for (i, t) in wp_times.iter().enumerate() {
        if let Some(Some(r)) = resolved.get(waypoint_start + i) {
            waypoint_addrs.push((*t, r.clone()));
        }
    }

    GeoContext { stop_addrs, start_addr, end_addr, waypoint_addrs }
}

fn build_prompt(
    name: &str,
    date: NaiveDate,
    stops: &[(DateTime<Utc>, DateTime<Utc>, f64, f64)],
    stats: Option<&DailyStatsRow>,
    signals: &Signals,
    geo: &GeoContext,
) -> String {
    let mut buf = String::new();
    let kst = chrono::FixedOffset::east_opt(9*3600).unwrap();
    buf.push_str(&format!("디바이스: {name}\n날짜: {date}\n\n"));

    // ── KPI ────────────────────────────────────────────
    buf.push_str("## KPI\n");
    if let Some(s) = stats {
        buf.push_str(&format!(
            "- 이동거리 {:.2} km / 운행시간 {} 분\n- 평균속도 {:.1} km/h, 최고속도 {:.1} km/h\n- 정차 {}회\n",
            s.distance_m / 1000.0, s.moving_s / 60,
            s.avg_speed_kmh, s.max_speed_kmh, s.stop_count,
        ));
        if let (Some(a), Some(b)) = (s.first_fix_at, s.last_fix_at) {
            buf.push_str(&format!("- 첫 fix {} / 마지막 fix {}\n",
                a.with_timezone(&kst).format("%H:%M"),
                b.with_timezone(&kst).format("%H:%M"),
            ));
        }
    }
    if signals.night_dist_km > 0.1 {
        buf.push_str(&format!("- 야간(22~06시) 운행: {:.1} km / {} 분\n",
            signals.night_dist_km, signals.night_minutes));
    }
    if signals.signal_gaps > 0 {
        buf.push_str(&format!("- 신호 두절 (>10분 갭): {}건\n", signals.signal_gaps));
    }
    buf.push('\n');

    // ── 자동 감지 이상 신호 ─────────────────────────────
    buf.push_str("## 자동 감지된 이상 신호\n");
    if signals.alerts.is_empty() {
        buf.push_str("- (없음 — 명백한 이상 신호 미검출)\n");
    } else {
        for a in signals.alerts.iter().take(15) {
            buf.push_str(&format!("- {a}\n"));
        }
    }
    buf.push('\n');

    // ── 출발/도착지 ────────────────────────────────────
    buf.push_str("## 출발/도착\n");
    match &geo.start_addr {
        Some(a) => buf.push_str(&format!("- 출발: {}\n", a.short())),
        None    => buf.push_str("- 출발: (주소 해석 불가)\n"),
    }
    match &geo.end_addr {
        Some(a) => buf.push_str(&format!("- 도착: {}\n", a.short())),
        None    => buf.push_str("- 도착: (주소 해석 불가)\n"),
    }
    buf.push('\n');

    // ── 정차 구간 (주소 우선) ──────────────────────────
    buf.push_str("## 정차 구간 상세\n");
    if stops.is_empty() {
        buf.push_str("- 5분 이상 50m 안에 머문 구간 없음\n");
    } else {
        for (i, (a, b, lat, lng)) in stops.iter().take(10).enumerate() {
            let dur_min = (*b - *a).num_seconds() / 60;
            let tag = stop_position_tag(stops.len(), i);
            let loc = match geo.stop_addrs.get(i).and_then(|o| o.as_ref()) {
                Some(r) => r.short(),
                None    => format!("{:.5},{:.5}", lat, lng),
            };
            buf.push_str(&format!(
                "{}. {}~{} ({}분) {}{}\n",
                i + 1,
                a.with_timezone(&kst).format("%H:%M"),
                b.with_timezone(&kst).format("%H:%M"),
                dur_min, loc, tag,
            ));
        }
    }
    buf.push('\n');

    // ── 경유 waypoint (주소만) ─────────────────────────
    if !geo.waypoint_addrs.is_empty() {
        buf.push_str("## 경유 지점 (시간 균등 분포)\n");
        for (t, r) in &geo.waypoint_addrs {
            buf.push_str(&format!(
                "- {} {}\n",
                t.with_timezone(&kst).format("%H:%M"),
                r.short(),
            ));
        }
        buf.push('\n');
    }

    buf.push_str("위 데이터로 시스템 프롬프트의 4개 섹션을 작성해주세요. \
출발/도착/정차 위치는 위에 명시된 주소·건물명을 그대로 인용하고, \
'자동 감지된 이상 신호'는 운영 관점 의미로 풀어 설명해주세요.");
    buf
}

fn stop_position_tag(total: usize, idx: usize) -> &'static str {
    if idx == 0 { "  [출발지로 추정]" }
    else if idx + 1 == total && total >= 2 { "  [도착지로 추정]" }
    else { "" }
}

// ─── 이상 신호 자동 검출 ──────────────────────────────────────
//
// 운영자가 즉시 알아야 할 패턴들을 결정론적으로 미리 뽑아서 GPT에 사실로 제공.
// GPT에 추측을 맡기지 않음.

#[derive(Debug, Default)]
pub struct Signals {
    pub alerts:        Vec<String>,
    pub night_dist_km: f64,
    pub night_minutes: i64,
    pub signal_gaps:   i32,
}

#[derive(Debug, Clone, Copy)]
struct Seg {
    t:     DateTime<Utc>,
    lat:   f64,
    lng:   f64,
    speed: f64,   // km/h, 0 이면 정지로 봄
    dt_s:  i64,
    dist:  f64,   // m, 직전 점에서 이동 거리
}

fn enrich_speeds(points: &[PointRow]) -> Vec<Seg> {
    let mut out = Vec::with_capacity(points.len());
    let mut prev: Option<(DateTime<Utc>, f64, f64)> = None;
    for p in points {
        let Some((lat, lng)) = pll(p) else { continue };
        let (speed, dt, dist) = if let Some((pt, pla, pln)) = prev {
            let dt = (p.recorded_at - pt).num_seconds().max(0);
            let d  = haversine_m(pla, pln, lat, lng);
            let s  = if dt > 0 { (d / dt as f64) * 3.6 } else { 0.0 };
            (s, dt, d)
        } else { (0.0, 0, 0.0) };
        out.push(Seg { t: p.recorded_at, lat, lng, speed, dt_s: dt, dist });
        prev = Some((p.recorded_at, lat, lng));
    }
    out
}

fn detect_anomalies(
    seg: &[Seg],
    stops: &[(DateTime<Utc>, DateTime<Utc>, f64, f64)],
) -> Signals {
    let kst = chrono::FixedOffset::east_opt(9*3600).unwrap();
    let mut s = Signals::default();
    if seg.is_empty() { return s; }

    // ── 과속 의심: 60초 이상 평균 100 km/h 초과 구간
    {
        let mut start: Option<usize> = None;
        let mut acc_d = 0.0;
        let mut acc_t = 0i64;
        for i in 1..seg.len() {
            let g = &seg[i];
            if g.speed > 100.0 && g.dt_s > 0 && g.dt_s < 60 {
                if start.is_none() { start = Some(i); acc_d = 0.0; acc_t = 0; }
                acc_d += g.dist;
                acc_t += g.dt_s;
            } else if let Some(si) = start.take() {
                if acc_t >= 60 {
                    let avg = (acc_d / acc_t as f64) * 3.6;
                    s.alerts.push(format!(
                        "과속 의심 — {} ~ {} ({}분), 평균 {:.0} km/h",
                        seg[si].t.with_timezone(&kst).format("%H:%M"),
                        g.t.with_timezone(&kst).format("%H:%M"),
                        acc_t / 60, avg,
                    ));
                }
                acc_d = 0.0; acc_t = 0;
            }
        }
    }

    // ── 급가속/급감속: 30초 이내 ±30 km/h 변화
    let mut harsh_brake = 0;
    let mut harsh_accel = 0;
    let mut harsh_examples: Vec<String> = vec![];
    for i in 1..seg.len() {
        let a = &seg[i-1];
        let b = &seg[i];
        if b.dt_s == 0 || b.dt_s > 30 { continue; }
        let delta = b.speed - a.speed;
        // 거의 멈춰 있는 상태에서의 변화는 노이즈 — 둘 다 30 km/h 이상에서만 카운트
        if a.speed < 20.0 && b.speed < 20.0 { continue; }
        if delta >= 30.0 {
            harsh_accel += 1;
            if harsh_examples.len() < 3 {
                harsh_examples.push(format!(
                    "급가속 {} — {:.0}→{:.0} km/h ({}초)",
                    b.t.with_timezone(&kst).format("%H:%M"),
                    a.speed, b.speed, b.dt_s,
                ));
            }
        } else if delta <= -30.0 {
            harsh_brake += 1;
            if harsh_examples.len() < 3 {
                harsh_examples.push(format!(
                    "급감속 {} — {:.0}→{:.0} km/h ({}초)",
                    b.t.with_timezone(&kst).format("%H:%M"),
                    a.speed, b.speed, b.dt_s,
                ));
            }
        }
    }
    if harsh_accel + harsh_brake > 0 {
        s.alerts.push(format!(
            "급가속 {}회 / 급감속 {}회 — 예: {}",
            harsh_accel, harsh_brake, harsh_examples.join(", "),
        ));
    }

    // ── 이상 정차: 출발지/도착지가 아닌데 10분 이상 머문 구간
    if stops.len() >= 2 {
        for (i, (a, b, lat, lng)) in stops.iter().enumerate() {
            if i == 0 || i + 1 == stops.len() { continue; }   // 출발/도착은 정상
            let dur_min = (*b - *a).num_seconds() / 60;
            if dur_min >= 10 {
                s.alerts.push(format!(
                    "이동 중 장기 정차 — {} ~ {} ({}분), {:.5},{:.5}",
                    a.with_timezone(&kst).format("%H:%M"),
                    b.with_timezone(&kst).format("%H:%M"),
                    dur_min, lat, lng,
                ));
            }
        }
    }

    // ── 신호 두절: 인접 점 사이 dt > 10분
    {
        let mut gaps: Vec<String> = vec![];
        for i in 1..seg.len() {
            if seg[i].dt_s >= 600 {
                s.signal_gaps += 1;
                if gaps.len() < 3 {
                    gaps.push(format!(
                        "{} ~ {} ({}분)",
                        seg[i-1].t.with_timezone(&kst).format("%H:%M"),
                        seg[i].t.with_timezone(&kst).format("%H:%M"),
                        seg[i].dt_s / 60,
                    ));
                }
            }
        }
        if s.signal_gaps > 0 {
            s.alerts.push(format!(
                "신호 두절 {}건 (>10분 갭) — 예: {}",
                s.signal_gaps, gaps.join(", "),
            ));
        }
    }

    // ── 야간 운행 (22:00~06:00 KST): 거리·시간 누적
    {
        let mut dist_m = 0.0;
        let mut secs   = 0i64;
        for i in 1..seg.len() {
            let h = seg[i].t.with_timezone(&kst).hour();
            if (h >= 22 || h < 6) && seg[i].speed > 5.0 {
                dist_m += seg[i].dist;
                secs   += seg[i].dt_s;
            }
        }
        s.night_dist_km = dist_m / 1000.0;
        s.night_minutes = secs / 60;
        if s.night_dist_km > 1.0 {
            s.alerts.push(format!(
                "야간 운행 (22~06시) — {:.1} km / {}분",
                s.night_dist_km, s.night_minutes,
            ));
        }
    }

    // ── 무휴식 장시간 운행: 10분 이상 정지 없이 2시간 이상 연속 이동
    {
        let mut start: Option<DateTime<Utc>> = None;
        let mut last_move: Option<DateTime<Utc>> = None;
        for g in seg.iter() {
            if g.speed > 5.0 {
                if start.is_none() { start = Some(g.t); }
                last_move = Some(g.t);
            } else if let (Some(st), Some(lm)) = (start, last_move) {
                if (lm - st).num_seconds() >= 7200 {
                    s.alerts.push(format!(
                        "장시간 무휴식 운행 — {} ~ {} ({}분)",
                        st.with_timezone(&kst).format("%H:%M"),
                        lm.with_timezone(&kst).format("%H:%M"),
                        (lm - st).num_seconds() / 60,
                    ));
                }
                start = None;
                last_move = None;
            }
        }
        // 끝까지 운행 중이었던 경우
        if let (Some(st), Some(lm)) = (start, last_move) {
            if (lm - st).num_seconds() >= 7200 {
                s.alerts.push(format!(
                    "장시간 무휴식 운행 — {} ~ {} ({}분)",
                    st.with_timezone(&kst).format("%H:%M"),
                    lm.with_timezone(&kst).format("%H:%M"),
                    (lm - st).num_seconds() / 60,
                ));
            }
        }
    }

    s
}

use chrono::Timelike;

fn extract_stops(
    points: &[PointRow],
    radius_m: f64,
    min_secs: i64,
) -> Vec<(DateTime<Utc>, DateTime<Utc>, f64, f64)> {
    let mut stops = vec![];
    let mut i = 0;
    while i < points.len() {
        let Some((la, ln)) = pll(&points[i]) else { i += 1; continue; };
        let mut j = i + 1;
        while j < points.len() {
            let Some((la2, ln2)) = pll(&points[j]) else { j += 1; continue; };
            if haversine_m(la, ln, la2, ln2) > radius_m { break; }
            j += 1;
        }
        let span = (points[j.saturating_sub(1)].recorded_at - points[i].recorded_at).num_seconds();
        if span >= min_secs && j > i + 1 {
            stops.push((points[i].recorded_at, points[j-1].recorded_at, la, ln));
            i = j;
        } else {
            i += 1;
        }
    }
    stops
}

fn pll(p: &PointRow) -> Option<(f64, f64)> {
    Some((p.lat?, p.lng?))
}

fn haversine_m(la1: f64, lo1: f64, la2: f64, lo2: f64) -> f64 {
    let r = std::f64::consts::PI / 180.0;
    let d_la = (la2 - la1) * r;
    let d_lo = (lo2 - lo1) * r;
    let a = (d_la/2.0).sin().powi(2)
          + (la1*r).cos() * (la2*r).cos() * (d_lo/2.0).sin().powi(2);
    2.0 * 6_371_000.0 * a.sqrt().asin()
}

async fn user_email(state: &AppState, uid: i64) -> AppResult<Option<String>> {
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(uid).fetch_optional(&state.db).await?.flatten();
    Ok(email)
}

async fn today_count(state: &AppState, uid: i64) -> AppResult<i64> {
    // KST 자정 이후 호출 횟수
    let n: Option<i64> = sqlx::query_scalar(
        r#"SELECT count(*) FROM ai_usage_log
            WHERE user_id = $1
              AND used_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'"#,
    )
    .bind(uid)
    .fetch_optional(&state.db).await?.flatten();
    Ok(n.unwrap_or(0))
}
