// ESP32 디바이스 위치 업로드 엔드포인트 (레거시 호환).
//
// 호환 페이로드 (현재 11_final_tracker.ino):
// {
//   "ts": 180,
//   "boot": 3, "awake": 2,
//   "csq": 24, "reg": 5, "vbat_mv": 3970,
//   "at_ms": 11051,
//   "l80": { "fix": true, "lat": ..., "lng": ..., "sat": 8, "ttff_s": 15 },
//   "lte": { ... }            // optional
// }
//
// 향후 ESP 펌웨어 업데이트 시 device_uid + api_key 필드 추가 → 인증 활성화.
// 지금은 익명 ingest (서버 측 device row 자동 생성/매칭).

use axum::{extract::State, http::HeaderMap, Json};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{
    error::{AppError, AppResult},
    events::Event,
    state::AppState,
};

const LOW_BATT_THRESHOLD_MV: i32 = 3500;

#[derive(Debug, Deserialize)]
pub struct IngestPayload {
    pub ts: Option<i32>,
    pub boot: Option<i64>,
    pub awake: Option<i64>,
    pub csq: Option<i32>,
    pub reg: Option<i32>,
    pub vbat_mv: Option<i32>,
    pub at_ms: Option<i32>,
    pub l80: Option<GpsFix>,
    pub lte: Option<GpsFix>,

    // 미래 호환: ESP가 자기 식별자 보낼 때
    pub device_uid: Option<String>,

    // Phase C: SIM 식별자 (ICCID/IMEI/IMSI) — 디바이스 안정 식별용
    pub iccid: Option<String>,
    pub imei:  Option<String>,
    pub imsi:  Option<String>,

    // Round 4: sleep/wake 관찰 가능성
    pub event:        Option<String>,    // "wake" | "sleep_enter"
    pub wake:         Option<String>,    // "motion" | "switch" | "boot" | "timer" | ...
    pub sleep_reason: Option<String>,    // "switch" / "motion_idle" 등 (event=sleep_enter 일 때)
    pub diag:         Option<serde_json::Value>,  // RTC + 사이클 카운터
    // 진짜 정지 시각 — sleep_enter 페이로드 보낼 때 펌웨어가 마지막 모션 후 경과 초 첨부.
    // 백엔드: occurred_at - offset = stopped_at. (펌웨어가 epoch 시각 못 가져도 보낼 수 있음)
    pub stopped_offset_s: Option<i64>,
    // 14_* 진단 sketch 식별자 — events.data 에 저장 → /diagnostic 페이지가 사이클별 분류.
    pub build_tag: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct GpsFix {
    pub fix: bool,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub sat: Option<i32>,
    pub sat_used: Option<i32>,
    pub sat_view: Option<i32>,
    pub ttff_s: Option<i32>,
    /// NMEA $GPRMC course over ground, 0~360°. 정지 시/no-fix 시 None.
    pub heading: Option<f32>,
}

impl GpsFix {
    fn sat_count(&self) -> Option<i32> {
        self.sat.or(self.sat_used).or(self.sat_view)
    }
}

pub async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> AppResult<Json<Value>> {
    // 클라이언트 IP (X-Real-IP, X-Forwarded-For, fallback)
    let remote_ip = headers
        .get("x-real-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    // 명시적 device_uid가 없으면 IP 기반 임시 식별자
    let parsed: IngestPayload = serde_json::from_value(payload.clone())
        .map_err(|e| AppError::BadRequest(format!("invalid payload: {e}")))?;

    let device_uid = parsed
        .device_uid
        .clone()
        .unwrap_or_else(|| format!("anon-{}", remote_ip));

    // 식별자 우선순위 (production-ready):
    //   1) ICCID 일치 (= SIM 정체성. 동일 SIM은 어떤 모뎀에 있든 같은 logical device)
    //   2) device_uid 일치 (legacy 디바이스 호환)
    //   3) 새로 INSERT (anon)
    //
    // ※ IMEI는 매칭 키로 쓰지 않음. 모뎀이 같아도 SIM이 바뀌면 다른 디바이스로 취급.
    //   IMEI는 fingerprint로만 저장 (도난 추적, 모뎀 식별 보조).
    let mut device_id: Option<i64> = None;
    if let Some(iccid) = parsed.iccid.as_deref() {
        device_id = sqlx::query_scalar("SELECT id FROM devices WHERE iccid = $1 LIMIT 1")
            .bind(iccid).fetch_optional(&state.db).await?;
    }
    if device_id.is_none() {
        device_id = sqlx::query_scalar("SELECT id FROM devices WHERE device_uid = $1")
            .bind(&device_uid).fetch_optional(&state.db).await?;
    }

    // 매칭된 행이 있으면 갱신, 없으면 INSERT. IMEI 변경 감지 시 audit 기록.
    let device_id: i64 = match device_id {
        Some(id) => {
            // 갱신 전 기존 IMEI 조회 (변경 여부 비교용)
            let prev_imei: Option<String> =
                sqlx::query_scalar("SELECT imei FROM devices WHERE id = $1")
                    .bind(id).fetch_one(&state.db).await?;

            sqlx::query(
                r#"UPDATE devices
                      SET last_seen_at = now(),
                          device_uid   = $2,
                          iccid        = COALESCE(devices.iccid, $3),
                          imei         = COALESCE($4, imei),
                          imsi         = COALESCE($5, imsi)
                    WHERE id = $1"#,
            )
            .bind(id)
            .bind(&device_uid)
            .bind(&parsed.iccid)
            .bind(&parsed.imei)
            .bind(&parsed.imsi)
            .execute(&state.db)
            .await?;

            // IMEI 가 바뀌었으면 = SIM 카드가 다른 모뎀으로 옮겨감 → swap 기록
            if let (Some(old), Some(new)) = (prev_imei.as_deref(), parsed.imei.as_deref()) {
                if !old.is_empty() && old != new {
                    let _ = sqlx::query(
                        r#"INSERT INTO device_audit_log (device_id, event_type, actor, data)
                           VALUES ($1, 'sim_swap', 'system', $2)"#,
                    )
                    .bind(id)
                    .bind(json!({
                        "from_imei": old,
                        "to_imei": new,
                        "iccid": parsed.iccid,
                    }))
                    .execute(&state.db)
                    .await;
                    tracing::info!(device_id = id, from = old, to = new, "audit: imei changed");
                }
            }

            id
        }
        None => sqlx::query_scalar(
            // ON CONFLICT 로 동시 ingest race 방어. 동일 device_uid 두 ingest 가
            // 동시에 INSERT 시도 → 한쪽은 UPDATE 경로로 진입해 id 반환.
            r#"INSERT INTO devices (device_uid, api_key_hash, last_seen_at, iccid, imei, imsi)
               VALUES ($1, '', now(), $2, $3, $4)
               ON CONFLICT (device_uid) DO UPDATE
                  SET last_seen_at = now(),
                      iccid = COALESCE(devices.iccid, EXCLUDED.iccid),
                      imei  = COALESCE(EXCLUDED.imei, devices.imei),
                      imsi  = COALESCE(EXCLUDED.imsi, devices.imsi)
               RETURNING id"#,
        )
        .bind(&device_uid)
        .bind(&parsed.iccid)
        .bind(&parsed.imei)
        .bind(&parsed.imsi)
        .fetch_one(&state.db)
        .await?,
    };

    // l80 / lte 각각 location_records로 INSERT (있는 것만)
    let recorded_at = Utc::now();

    if let Some(l80) = &parsed.l80 {
        insert_location(&state, device_id, recorded_at, "l80", l80, &parsed, &payload).await?;
        broadcast_location(&state, device_id, recorded_at, "l80", l80, &parsed);
        if let (true, Some(lat), Some(lng)) = (l80.fix, l80.lat, l80.lng) {
            let _ = crate::services::geofence::check_after_ingest(&state.db, device_id, lat, lng).await;
        }
    }
    if let Some(lte) = &parsed.lte {
        insert_location(&state, device_id, recorded_at, "lte_gnss", lte, &parsed, &payload).await?;
        broadcast_location(&state, device_id, recorded_at, "lte_gnss", lte, &parsed);
        if let (true, Some(lat), Some(lng)) = (lte.fix, lte.lat, lte.lng) {
            let _ = crate::services::geofence::check_after_ingest(&state.db, device_id, lat, lng).await;
        }
    }

    // 디바이스가 직전에 offline / signal_loss 로 마킹돼 있었다면 'online' (recovery) 발행.
    // 한 번만 — 이후 ingest 에선 last_event = 'online' 이라 다시 안 탐.
    {
        let last_event_kind: Option<String> = sqlx::query_scalar(
            "SELECT kind FROM events WHERE device_id = $1 \
             AND user_id = (SELECT owner_id FROM devices WHERE id = $1) \
             ORDER BY occurred_at DESC LIMIT 1",
        )
        .bind(device_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
        if matches!(last_event_kind.as_deref(), Some("offline") | Some("signal_loss")) {
            let recovered_from = last_event_kind.unwrap();
            let _ = sqlx::query(
                "INSERT INTO events (device_id, occurred_at, kind, data, user_id) VALUES ($1, $2, 'online', $3, (SELECT owner_id FROM devices WHERE id = $1))",
            )
            .bind(device_id)
            .bind(recorded_at)
            .bind(serde_json::json!({ "recovered_from": recovered_from }))
            .execute(&state.db).await;
            tracing::info!(device_id, %recovered_from, "online recovery event inserted");
        }
    }

    // 이벤트 분류기: low_batt
    // 디바운스 — 24시간 내에 이미 low_batt 이벤트 있으면 스킵 (푸시 스팸 방지).
    // 24h 후에도 여전히 임계 미만이면 다시 한 번 발송 (리마인더).
    if let Some(v) = parsed.vbat_mv {
        if v < LOW_BATT_THRESHOLD_MV {
            let recent: Option<bool> = sqlx::query_scalar(
                r#"SELECT TRUE FROM events
                    WHERE device_id = $1
                      AND user_id = (SELECT owner_id FROM devices WHERE id = $1)
                      AND kind = 'low_batt'
                      AND occurred_at > now() - interval '24 hours'
                    ORDER BY occurred_at DESC LIMIT 1"#,
            )
            .bind(device_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

            if recent.is_none() {
                let data = json!({ "vbat_mv": v, "threshold_mv": LOW_BATT_THRESHOLD_MV });
                let _ = sqlx::query(
                    "INSERT INTO events (device_id, occurred_at, kind, data, user_id) VALUES ($1, $2, $3, $4, (SELECT owner_id FROM devices WHERE id = $1))",
                )
                .bind(device_id)
                .bind(recorded_at)
                .bind("low_batt")
                .bind(&data)
                .execute(&state.db)
                .await;
                let _ = state.events.send(Event::DeviceEvent {
                    device_id,
                    kind: "low_batt".into(),
                    data,
                });
                tracing::info!(device_id, vbat_mv = v, "low_batt event inserted");
            } else {
                tracing::debug!(device_id, vbat_mv = v, "low_batt suppressed (24h debounce)");
            }
        }
    }

    // last_lat/lng 업데이트 (l80 우선, fix=true일 때만)
    if let Some(l80) = parsed.l80.as_ref().filter(|x| x.fix) {
        if let (Some(lat), Some(lng)) = (l80.lat, l80.lng) {
            sqlx::query(
                "UPDATE devices SET last_lat = $1, last_lng = $2, last_fix_at = now() WHERE id = $3",
            )
            .bind(lat)
            .bind(lng)
            .bind(device_id)
            .execute(&state.db)
            .await?;
        }
    }

    // 펌웨어 13_1+ stationary 블록 — deep sleep 카운트다운 + GPS drift + LIS 헬스.
    // 매 POST 마다 덮어쓰기 (events 안 쌓아 행 폭주 방지). 도착 시각 함께 기록.
    if let Some(stat) = payload.get("stationary").cloned() {
        if stat.is_object() {
            let mut obj = stat.as_object().cloned().unwrap_or_default();
            obj.insert("updated_at".into(), Value::String(Utc::now().to_rfc3339()));
            let _ = sqlx::query("UPDATE devices SET last_stationary = $1 WHERE id = $2")
                .bind(Value::Object(obj))
                .bind(device_id)
                .execute(&state.db)
                .await;
        }
    }

    // Round 4: sleep_enter / wake 이벤트 — 모든 진단 정보 함께 저장
    if let Some(kind) = parsed.event.as_deref() {
        if kind == "sleep_enter" || kind == "wake" {
            let mut data = serde_json::Map::new();
            if let Some(d) = &parsed.diag { data.insert("diag".into(), d.clone()); }
            if let Some(w) = &parsed.wake { data.insert("wake_cause".into(), Value::String(w.clone())); }
            if let Some(r) = &parsed.sleep_reason { data.insert("sleep_reason".into(), Value::String(r.clone())); }
            if let Some(v) = parsed.vbat_mv { data.insert("vbat_mv".into(), v.into()); }
            if let Some(c) = parsed.csq { data.insert("csq".into(), c.into()); }
            if let Some(t) = parsed.ts { data.insert("uptime_s".into(), t.into()); }
            if let Some(off) = parsed.stopped_offset_s {
                data.insert("stopped_offset_s".into(), off.into());
            }
            if let Some(bt) = &parsed.build_tag {
                data.insert("build_tag".into(), Value::String(bt.clone()));
            }
            let _ = sqlx::query(
                "INSERT INTO events (device_id, occurred_at, kind, data, user_id) VALUES ($1, $2, $3, $4, (SELECT owner_id FROM devices WHERE id = $1))",
            )
            .bind(device_id)
            .bind(recorded_at)
            .bind(kind)
            .bind(Value::Object(data))
            .execute(&state.db)
            .await;
            // 진단 핵심 필드 같이 찍기 — server log 만 봐도 sleep cycle 분석 가능.
            let wake_cause = parsed.wake.as_deref().unwrap_or("-");
            let sleep_reason = parsed.sleep_reason.as_deref().unwrap_or("-");
            let stopped_offset_s = parsed.stopped_offset_s.unwrap_or(-1);
            let uptime_s = parsed.ts.unwrap_or(-1);
            let vbat_mv = parsed.vbat_mv.unwrap_or(-1);
            let (boots, wakes, motion_wakes, brownouts, last_sleep_uptime_s) = parsed.diag.as_ref()
                .map(|d| (
                    d.get("boots").and_then(|v| v.as_i64()).unwrap_or(-1),
                    d.get("wakes").and_then(|v| v.as_i64()).unwrap_or(-1),
                    d.get("motion_wakes").and_then(|v| v.as_i64()).unwrap_or(-1),
                    d.get("brownouts").and_then(|v| v.as_i64()).unwrap_or(-1),
                    d.get("last_sleep_uptime_s").and_then(|v| v.as_i64()).unwrap_or(-1),
                ))
                .unwrap_or((-1, -1, -1, -1, -1));
            let build_tag = parsed.build_tag.as_deref().unwrap_or("-");
            let gps_fix = parsed.l80.as_ref().map(|l| l.fix).unwrap_or(false);
            let gps_sat = parsed.l80.as_ref().and_then(|l| l.sat_count()).unwrap_or(-1);
            tracing::info!(
                device_id, kind, build_tag,
                wake_cause, sleep_reason,
                uptime_s, vbat_mv,
                gps_fix, gps_sat,
                boots, wakes, motion_wakes, brownouts, last_sleep_uptime_s, stopped_offset_s,
                "lifecycle event ingested"
            );
        }
    }

    // Round 4: diag 카운터 비교 → 새로 발생한 brownout / gps_anomaly 분류
    // 누락 필드는 -1 sentinel — 비교에서 skip, UPDATE 에서도 기존 값 보존 (COALESCE)
    if let Some(diag) = parsed.diag.as_ref() {
        let new_brownouts     = diag.get("brownouts").and_then(|v| v.as_i64()).unwrap_or(-1);
        let new_no_fix_cycles = diag.get("no_fix_cycles").and_then(|v| v.as_i64()).unwrap_or(-1);

        if new_brownouts >= 0 || new_no_fix_cycles >= 0 {
            // 직전 캐시값 조회 (devices 테이블)
            let prev: Option<(i32, i32)> = sqlx::query_as(
                "SELECT rtc_brownouts, rtc_no_fix_cycles FROM devices WHERE id = $1"
            ).bind(device_id).fetch_optional(&state.db).await?;
            let (prev_brown, prev_no_fix) = prev.unwrap_or((0, 0));

            // brownout 증가분 → 이벤트 + 캐시 갱신
            if new_brownouts > prev_brown as i64 {
                let delta = new_brownouts - prev_brown as i64;
                let _ = sqlx::query(
                    "INSERT INTO events (device_id, occurred_at, kind, data, user_id) VALUES ($1, $2, 'brownout', $3, (SELECT owner_id FROM devices WHERE id = $1))",
                ).bind(device_id).bind(recorded_at).bind(json!({
                    "delta": delta, "total": new_brownouts, "vbat_mv": parsed.vbat_mv,
                })).execute(&state.db).await;
                tracing::warn!(device_id, delta, total=new_brownouts, "brownout event");
            }

            // gps_anomaly — no_fix_cycles 가 직전 대비 +2 이상 증가 시 (노이즈 1회는 무시)
            if new_no_fix_cycles >= prev_no_fix as i64 + 2 {
                let delta = new_no_fix_cycles - prev_no_fix as i64;
                let _ = sqlx::query(
                    "INSERT INTO events (device_id, occurred_at, kind, data, user_id) VALUES ($1, $2, 'gps_anomaly', $3, (SELECT owner_id FROM devices WHERE id = $1))",
                ).bind(device_id).bind(recorded_at).bind(json!({
                    "delta": delta, "total": new_no_fix_cycles,
                })).execute(&state.db).await;
                tracing::info!(device_id, delta, "gps_anomaly event");
            }

            // 캐시 갱신 — diag 에 누락된 카운터는 기존 값 보존 (sentinel -1 이면 NULL bind).
            // 펨웨어 RTC 가 POWERON 으로 0 으로 리셋되어 새 값이 더 작아질 수 있는데 그건 정상.
            let _ = sqlx::query(
                "UPDATE devices
                    SET rtc_brownouts     = COALESCE($1, rtc_brownouts),
                        rtc_no_fix_cycles = COALESCE($2, rtc_no_fix_cycles)
                  WHERE id = $3"
            )
            .bind(if new_brownouts     >= 0 { Some(new_brownouts     as i32) } else { None })
            .bind(if new_no_fix_cycles >= 0 { Some(new_no_fix_cycles as i32) } else { None })
            .bind(device_id)
            .execute(&state.db).await;
        }
    }

    // ── 부저 원격 트리거 atomic claim ──
    // UI 가 set 한 beep_pending=true 를 atomic 으로 FALSE 로 클리어하면서 응답에 cmd 실어 보냄.
    // RETURNING 으로 진짜 한 번만 claim — 동시에 들어온 ingest 두 개가 둘 다 cmd 받는 일 없음.
    let beep_claimed: Option<(i64,)> = sqlx::query_as(
        r#"UPDATE devices
              SET beep_pending = FALSE
            WHERE id = $1 AND beep_pending = TRUE
        RETURNING id"#,
    )
    .bind(device_id)
    .fetch_optional(&state.db).await
    .ok().flatten();

    let mut resp = json!({ "ok": true });
    if beep_claimed.is_some() {
        resp["cmd"] = json!("beep");
        tracing::info!(device_id, "ingest: dispatched beep cmd");
    }
    Ok(Json(resp))
}

fn broadcast_location(
    state: &AppState,
    device_id: i64,
    recorded_at: chrono::DateTime<Utc>,
    source: &str,
    fix: &GpsFix,
    parsed: &IngestPayload,
) {
    let _ = state.events.send(Event::Location {
        device_id,
        recorded_at,
        source: source.to_string(),
        fix: fix.fix,
        lat: fix.lat,
        lng: fix.lng,
        sat: fix.sat_count().map(|v| v as i16),
        ttff_s: fix.ttff_s,
        vbat_mv: parsed.vbat_mv,
        heading: fix.heading,
    });
}

async fn insert_location(
    state: &AppState,
    device_id: i64,
    recorded_at: chrono::DateTime<Utc>,
    source: &str,
    fix: &GpsFix,
    parsed: &IngestPayload,
    raw: &Value,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO location_records (
            device_id, recorded_at, device_uptime_s, source,
            fix, lat, lng, sat, ttff_s,
            csq, reg, vbat_mv, raw, heading, user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                (SELECT owner_id FROM devices WHERE id = $1))
        ON CONFLICT (device_id, recorded_at, source) DO NOTHING
        "#,
    )
    .bind(device_id)
    .bind(recorded_at)
    .bind(parsed.ts)
    .bind(source)
    .bind(fix.fix)
    .bind(fix.lat)
    .bind(fix.lng)
    .bind(fix.sat_count())
    .bind(fix.ttff_s)
    .bind(parsed.csq)
    .bind(parsed.reg)
    .bind(parsed.vbat_mv)
    .bind(raw)
    .bind(fix.heading)
    .execute(&state.db)
    .await?;
    Ok(())
}
