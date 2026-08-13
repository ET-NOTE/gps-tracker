// FCM 워커 — events 테이블의 미통보 행을 폴링해 사용자의 활성 fcm_tokens로 발송한다.
//
// 두 가지 모드:
//   - dry-run : FCM_SERVICE_ACCOUNT_PATH 미설정. 발송 없이 notified_at만 마킹 (큐 적체 방지).
//   - live    : 서비스 계정 JSON 경로 설정. JWT(RS256) 자기 서명 → OAuth2 access_token 교환 →
//               FCM HTTP v1 (https://fcm.googleapis.com/v1/projects/{project_id}/messages:send) 호출.
//
// access_token은 ~1시간 유효. 캐시해서 동일 만료까지 재사용.
// 단말 토큰이 invalid면 fcm_tokens.active=false 처리.

use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use tokio::sync::Mutex;
use tokio::time::sleep;

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const BATCH: i64 = 50;
const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

#[derive(Debug, FromRow)]
struct PendingEvent {
    id: i64,
    device_id: i64,
    device_name: Option<String>,   // devices.display_name JOIN — 알림 본문 노출용
    kind: String,
    data: Option<Value>,
    user_id: Option<i64>,    // 이벤트 생성 시점의 owner — 해당 사용자에게만 푸시
}

/// 알림 본문에 노출할 디바이스 라벨. display_name 있으면 우선, 없으면 #ID 폴백.
fn dev_label(ev: &PendingEvent) -> String {
    match ev.device_name.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => format!("디바이스 #{}", ev.device_id),
    }
}

#[derive(Debug, Deserialize)]
struct ServiceAccount {
    project_id: String,
    private_key: String,
    client_email: String,
    token_uri: String,
}

#[derive(Serialize)]
struct OauthClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

#[derive(Deserialize)]
struct OauthTokenResponse {
    access_token: String,
    expires_in: u64,
}

pub struct FcmClient {
    sa: ServiceAccount,
    http: reqwest::Client,
    cached_token: Mutex<Option<(String, Instant)>>,
}

impl FcmClient {
    pub fn try_load(path: &str) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        let sa: ServiceAccount = serde_json::from_str(&raw)?;
        Ok(Self {
            sa,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()?,
            cached_token: Mutex::new(None),
        })
    }

    pub async fn access_token(&self) -> anyhow::Result<String> {
        {
            let cache = self.cached_token.lock().await;
            if let Some((tok, exp)) = cache.as_ref() {
                if Instant::now() < *exp {
                    return Ok(tok.clone());
                }
            }
        }

        let now = chrono::Utc::now().timestamp();
        let claims = OauthClaims {
            iss: &self.sa.client_email,
            scope: FCM_SCOPE,
            aud: &self.sa.token_uri,
            iat: now,
            exp: now + 3600,
        };

        let key = EncodingKey::from_rsa_pem(self.sa.private_key.as_bytes())?;
        let jwt = encode(&Header::new(Algorithm::RS256), &claims, &key)?;

        let res = self
            .http
            .post(&self.sa.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", jwt.as_str()),
            ])
            .send()
            .await?
            .error_for_status()?
            .json::<OauthTokenResponse>()
            .await?;

        let exp = Instant::now() + Duration::from_secs(res.expires_in.saturating_sub(60));
        let mut cache = self.cached_token.lock().await;
        *cache = Some((res.access_token.clone(), exp));
        Ok(res.access_token)
    }

    /// returns Ok(true) on 200, Ok(false) ONLY on token-invalid (UNREGISTERED).
    /// INVALID_ARGUMENT 는 페이로드 버그 — Err 로 올려서 호출자가 인지하게.
    /// (예전엔 INVALID_ARGUMENT 도 Ok(false) 처리하면서 멀쩡한 토큰을
    ///  비활성화하는 버그가 있었음.)
    pub async fn send_to_token(&self, access_token: &str, fcm_token: &str, message: Value) -> anyhow::Result<bool> {
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.sa.project_id
        );

        // FCM HTTP v1 의 data 필드는 모든 값이 string 이어야 함.
        // 호출자가 number/bool 을 넣어도 자동 변환.
        let data = stringify_data(&message["data"]);

        let body = json!({
            "message": {
                "token":        fcm_token,
                "notification": message["notification"],
                "data":         data,
                "android":      message["android"],
            }
        });
        let res = self
            .http
            .post(&url)
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await?;

        let status = res.status();
        if status.is_success() {
            return Ok(true);
        }

        let text = res.text().await.unwrap_or_default();
        // UNREGISTERED / NOT_FOUND 만 토큰 invalid 로 처리.
        // INVALID_ARGUMENT 은 페이로드 잘못 — 토큰 그대로 둠.
        if status.as_u16() == 404 || text.contains("UNREGISTERED") {
            tracing::info!(
                token_prefix = &fcm_token[..16.min(fcm_token.len())],
                status=%status,
                "fcm: token unregistered, will deactivate"
            );
            return Ok(false);
        }
        anyhow::bail!("fcm send {status}: {text}");
    }
}

/// FCM data 필드 sanitize — 모든 value 를 string 으로 강제.
/// number/bool 은 그대로 stringify, 그 외(객체/배열/null)는 JSON 문자열로.
fn stringify_data(v: &Value) -> Value {
    let Value::Object(map) = v else {
        return Value::Object(Default::default());
    };
    let mut out = serde_json::Map::with_capacity(map.len());
    for (k, val) in map {
        let s = match val {
            Value::String(s) => s.clone(),
            Value::Null      => String::new(),
            Value::Bool(b)   => b.to_string(),
            Value::Number(n) => n.to_string(),
            other            => other.to_string(),  // JSON 직렬화
        };
        out.insert(k.clone(), Value::String(s));
    }
    Value::Object(out)
}

/// 공통 client 빌드 — main 에서 한 번 호출, worker / chat push 에 공유.
pub fn make_client(service_account_path: Option<&str>) -> Option<Arc<FcmClient>> {
    let path = service_account_path?;
    match FcmClient::try_load(path) {
        Ok(c) => {
            tracing::info!(project = %c.sa.project_id, "fcm: live mode");
            Some(Arc::new(c))
        }
        Err(e) => {
            tracing::error!("fcm: failed to load service account at {path}: {e:#} — dry-run");
            None
        }
    }
}

/// OAuth 실패 시 사용할 backoff 계단 (sec). Google API down 시 5s 마다 hammer 하지 않도록.
const OAUTH_BACKOFF_SEC: &[u64] = &[30, 60, 300, 1800];

/// Spawn the polling worker. client None 이면 dry-run.
pub fn spawn(pool: PgPool, client: Option<Arc<FcmClient>>) {
    if client.is_none() {
        tracing::info!("fcm worker: dry-run mode (no FCM client)");
    }

    tokio::spawn(async move {
        let mut oauth_fails: u32 = 0;
        loop {
            match process_batch(&pool, client.as_deref()).await {
                Ok(BatchOutcome::OAuthFail) => {
                    // 연속 실패 시 점진적 backoff: 30s → 60s → 5min → 30min 유지.
                    let idx = (oauth_fails as usize).min(OAUTH_BACKOFF_SEC.len() - 1);
                    let delay = OAUTH_BACKOFF_SEC[idx];
                    tracing::warn!(consecutive_fails = oauth_fails + 1, delay_sec = delay,
                        "fcm worker: OAuth failure backoff");
                    oauth_fails = oauth_fails.saturating_add(1);
                    sleep(Duration::from_secs(delay)).await;
                }
                Ok(_) => {
                    if oauth_fails > 0 {
                        tracing::info!(prev_fails = oauth_fails, "fcm worker: OAuth recovered");
                        oauth_fails = 0;
                    }
                    sleep(POLL_INTERVAL).await;
                }
                Err(e) => {
                    tracing::warn!("fcm worker batch error: {e:#}");
                    sleep(POLL_INTERVAL).await;
                }
            }
        }
    });
}

enum BatchOutcome {
    Done,
    OAuthFail,
}

async fn process_batch(pool: &PgPool, client: Option<&FcmClient>) -> anyhow::Result<BatchOutcome> {
    // OAuth 토큰을 먼저 확보 — 실패하면 claim 자체를 안 함 (다음 폴링에서 재시도).
    // 이렇게 안 하면 claim 후 토큰 fetch 실패 시 marked 행이 발송 없이 손실.
    let access = if let Some(c) = client {
        match c.access_token().await {
            Ok(t) => Some(t),
            Err(e) => {
                tracing::error!("fcm: failed to get access token: {e:#} — skipping batch (rows untouched)");
                return Ok(BatchOutcome::OAuthFail);
            }
        }
    } else {
        None
    };

    // 원자적 claim — notified_at 을 발송 전 미리 마킹하고 RETURNING 으로 페이로드 회수.
    // FOR UPDATE SKIP LOCKED 로 동시에 떠 있을 수 있는 다른 워커/재시작과 충돌 없이 잠금.
    //
    // 트레이드오프: 발송 직후 크래시 시 옛 코드는 무한 재발송 → 사용자 스팸 폭우.
    // 새 코드는 발송 전 마킹 → 매우 드문 크래시 직전 1건 발송 실패 가능성 (수용).
    //  · "스팸 1000번" >> "1건 누락" — 후자 선택.
    //  · 정말 critical alert 면 별도 retry 컬럼 도입 필요 (지금 범주 아님).
    let pending: Vec<PendingEvent> = sqlx::query_as(
        r#"WITH claimed AS (
              SELECT id FROM events
               WHERE notified_at IS NULL
               ORDER BY occurred_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED
           ),
           marked AS (
              UPDATE events e
                 SET notified_at = now()
                WHERE id IN (SELECT id FROM claimed)
            RETURNING e.id, e.device_id, e.kind, e.data, e.user_id
           )
           SELECT m.id, m.device_id,
                  d.display_name AS device_name,
                  m.kind, m.data, m.user_id
             FROM marked m
        LEFT JOIN devices d ON d.id = m.device_id"#,
    )
    .bind(BATCH)
    .fetch_all(pool)
    .await?;

    if pending.is_empty() {
        return Ok(BatchOutcome::Done);
    }

    for ev in pending {
        // ─ 알림 설정 체크: 이벤트의 user_id 기준 (이벤트 생성 시점 owner 의 설정).
        //   현재 owner 가 바뀐 경우에도 원래 owner 가 그들의 설정대로 받음.
        let allowed: bool = if let Some(uid) = ev.user_id {
            sqlx::query_scalar(
                r#"SELECT
                     CASE $2
                       WHEN 'low_batt'       THEN COALESCE(ns.low_batt_alert,    TRUE)
                       WHEN 'motion'         THEN COALESCE(ns.motion_alert,      TRUE)
                       WHEN 'offline'        THEN COALESCE(ns.offline_alert,     TRUE)
                       WHEN 'signal_loss'    THEN COALESCE(ns.signal_loss_alert, FALSE)
                       -- [2026-08-14] stuck = signal_loss(5분) 전 1분 무응답 조기단계. 같은 계열이라
                       --   signal_loss_alert 설정에 종속(기본 OFF). 누락 시 ELSE TRUE 로 강제푸시되던 버그 수정.
                       WHEN 'stuck'          THEN COALESCE(ns.signal_loss_alert, FALSE)
                       WHEN 'online'         THEN COALESCE(ns.online_alert,      TRUE)
                       WHEN 'sleep_enter'    THEN COALESCE(ns.sleep_alert,       FALSE)
                       WHEN 'wake'           THEN COALESCE(ns.wake_alert,        FALSE)
                       WHEN 'cycle_first_fix' THEN COALESCE(ns.cycle_first_fix_alert, FALSE)
                       WHEN 'geofence_in'    THEN COALESCE(ns.geofence_alert,    TRUE)
                       WHEN 'geofence_out'   THEN COALESCE(ns.geofence_alert,    TRUE)
                       WHEN 'geofence_armed' THEN COALESCE(ns.geofence_alert,    TRUE)
                       WHEN 'brownout'       THEN COALESCE(ns.device_health_alert, TRUE)
                       WHEN 'gps_anomaly'    THEN COALESCE(ns.device_health_alert, TRUE)
                       WHEN 'lost'           THEN COALESCE(ns.lost_alert,        TRUE)
                       ELSE TRUE
                     END
                  FROM (SELECT 1) _
             LEFT JOIN notification_settings ns ON ns.user_id = $1"#,
            )
            .bind(uid).bind(&ev.kind)
            .fetch_optional(pool).await.ok().flatten().unwrap_or(true)
        } else {
            // legacy event without user_id — skip (unsafe to push)
            false
        };

        // (2026-07-29) 24시간 무응답 'lost' 알림 제거 — 사용자 스팸 리포트.
        // event 자체는 여전히 events 테이블에 기록 (진단용, /diagnostic 에서 확인 가능).
        // 단지 push 만 skip. lost_alert notification_setting 무시.
        let allowed = allowed && ev.kind != "lost";

        if !allowed {
            tracing::debug!(event_id = ev.id, kind = %ev.kind, "fcm: muted");
            // notified_at 은 batch claim 단계에서 이미 마킹됨 — 별도 UPDATE 불필요.
            continue;
        }

        // 푸시 대상: 이벤트 발생 시점의 user_id (== device.owner_id at insert time).
        // 이 사용자가 unpair 했더라도 그들의 다른 디바이스용 토큰으로 알림 도달 — 정상.
        // 신규 owner 가 받는 알림은 "그들의" 이벤트 (user_id 본인 일치) 만.
        let tokens: Vec<(i64, String)> = match ev.user_id {
            Some(uid) => sqlx::query_as(
                r#"SELECT id, token FROM fcm_tokens
                    WHERE user_id = $1 AND active = TRUE"#,
            )
            .bind(uid).fetch_all(pool).await.unwrap_or_default(),
            None => vec![],   // user_id 없는 이벤트 (legacy) — 푸시 안 보냄
        };

        let title = title_for_kind(&ev.kind, ev.device_id);
        let body  = body_for_event(pool, &ev).await;
        let message = json!({
            "notification": { "title": title, "body": body },
            "data": {
                "kind":      ev.kind,
                "device_id": ev.device_id.to_string(),
                "event_id":  ev.id.to_string(),
            },
            "android": { "priority": "HIGH" },
        });

        if let (Some(c), Some(at)) = (client, access.as_deref()) {
            for (token_id, token) in &tokens {
                match c.send_to_token(at, token, message.clone()).await {
                    Ok(true) => {
                        tracing::info!(event_id = ev.id, token_id, "fcm: sent");
                    }
                    Ok(false) => {
                        // mark inactive
                        let _ = sqlx::query("UPDATE fcm_tokens SET active = FALSE WHERE id = $1")
                            .bind(token_id)
                            .execute(pool)
                            .await;
                    }
                    Err(e) => {
                        tracing::warn!(event_id = ev.id, token_id, "fcm: send error: {e:#}");
                    }
                }
            }
        } else {
            tracing::debug!(
                event_id = ev.id,
                device_id = ev.device_id,
                kind = %ev.kind,
                token_count = tokens.len(),
                "fcm: dry-run skip"
            );
        }
        // notified_at 은 batch claim 단계에서 이미 마킹됨.
    }
    Ok(BatchOutcome::Done)
}

fn title_for_kind(kind: &str, _device_id: i64) -> String {
    match kind {
        "low_batt"        => "🔋 배터리 부족".into(),
        "offline"         => "📡 통신 두절".into(),
        "signal_loss"     => "📶 통신 약함".into(),
        "online"          => "✅ 통신 복구".into(),
        "sleep_enter"     => "🌙 정지".into(),
        "wake"            => "☀️ 활성".into(),
        "cycle_first_fix" => "🚗 운행 시작".into(),
        "geofence_in"     => "📍 지오펜스 진입".into(),
        "geofence_out"    => "📍 지오펜스 이탈".into(),
        "geofence_armed"  => "📍 지오펜스 활성화".into(),
        "brownout"        => "⚡ 전원 불안정".into(),
        "gps_anomaly"     => "🛰️ GPS 신호 불안정".into(),
        "lost"            => "❗ 장치 미응답".into(),   // (2026-07-29) push 는 skip, title 은 in-app 로그용
        _                 => "🔔 시리얼링크 위치추적기".into(),
    }
}

/// 배터리 mV → 대략적인 % 환산. LiPo 3.4V(0%) ~ 4.2V(100%) 선형 근사.
/// 사용자에게 mV 는 무의미 — % 로 안내.
fn vbat_to_pct(mv: i64) -> i32 {
    let pct = ((mv - 3400) as f64 / 800.0 * 100.0).round() as i32;
    pct.clamp(0, 100)
}

async fn resolve_addr(pool: &PgPool, lat: f64, lng: f64) -> Option<String> {
    let mut r = super::kakao_geo::reverse_many_cached(pool, &[(lat, lng)]).await;
    r.pop().flatten().map(|x| x.short())
}

async fn body_for_event(pool: &PgPool, ev: &PendingEvent) -> String {
    let dev = dev_label(ev);
    match ev.kind.as_str() {
        "low_batt" => {
            let v = ev.data.as_ref()
                .and_then(|d| d.get("vbat_mv"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let pct = vbat_to_pct(v);
            format!("{dev} 배터리 약 {pct}% 남았습니다 — 충전이 필요합니다")
        }
        "geofence_armed" => {
            let d      = ev.data.as_ref();
            let name   = d.and_then(|x| x.get("geofence_name")).and_then(|v| v.as_str()).unwrap_or("펜스");
            let inside = d.and_then(|x| x.get("inside")).and_then(|v| v.as_bool()).unwrap_or(false);
            if inside {
                format!("{dev}: '{name}' 감시 시작 — 현재 펜스 안에 있습니다")
            } else {
                format!("{dev}: '{name}' 감시 시작 — 현재 펜스 밖에 있습니다")
            }
        }
        "geofence_in" | "geofence_out" => {
            let name = ev.data.as_ref()
                .and_then(|x| x.get("geofence_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("펜스");
            let action = if ev.kind == "geofence_in" { "진입" } else { "이탈" };
            format!("{dev}: '{name}' {action}")
        }
        "brownout" => {
            format!("{dev}: 전원이 불안정합니다 — 배터리·연결 상태를 확인해 주세요")
        }
        "gps_anomaly" => {
            format!("{dev}: GPS 신호가 약합니다 — 지하 · 실내 · 터널 통과 가능성")
        }
        // (2026-07-29) 'lost' 는 push allowed 에서 skip 되지만 방어적으로 body 도 정리.
        "lost" => {
            let hrs = ev.data.as_ref().and_then(|x| x.get("hours_since_sleep")).and_then(|v| v.as_i64()).unwrap_or(24);
            format!("{dev}: {hrs}시간 넘게 응답 없음")
        }
        "offline" => {
            let m = ev.data.as_ref().and_then(|x| x.get("silence_min")).and_then(|v| v.as_i64()).unwrap_or(0);
            if m >= 60 {
                let hrs = m / 60;
                format!("{dev}: {hrs}시간 이상 통신이 끊겼습니다")
            } else if m > 0 {
                format!("{dev}: {m}분간 통신이 끊겼습니다")
            } else {
                format!("{dev}: 통신이 끊겼습니다")
            }
        }
        "signal_loss" => {
            let m = ev.data.as_ref().and_then(|x| x.get("silence_min")).and_then(|v| v.as_i64()).unwrap_or(0);
            format!("{dev}: {}분간 신호가 약합니다", m.max(5))
        }
        "online" => {
            format!("{dev}: 통신이 복구되었습니다")
        }
        "sleep_enter" => {
            format!("{dev}: 정지 상태로 전환되었습니다")
        }
        "wake" => {
            format!("{dev}: 다시 활성 상태입니다")
        }
        // (2026-07-29) 좌표 · 위성수 대신 주소 — Kakao reverse-geo 캐시 사용.
        "cycle_first_fix" => {
            let lat = ev.data.as_ref().and_then(|x| x.get("lat")).and_then(|v| v.as_f64());
            let lng = ev.data.as_ref().and_then(|x| x.get("lng")).and_then(|v| v.as_f64());
            match (lat, lng) {
                (Some(lat), Some(lng)) => {
                    match resolve_addr(pool, lat, lng).await {
                        Some(addr) => format!("{dev} 운행을 시작했습니다 — 출발지: {addr}"),
                        None       => format!("{dev} 운행을 시작했습니다"),
                    }
                }
                _ => format!("{dev} 운행을 시작했습니다"),
            }
        }
        _ => format!("{dev} 알림"),
    }
}

// ─── 채팅/시스템 푸시 (events 워커와 별개, on-demand) ──────────────
//
// chat_messages INSERT 직후 호출. 본 트랜잭션과 무관하게 best-effort 로 송신.
// FcmClient 가 None (dry-run 또는 미설정) 이면 곧장 종료.

/// 특정 사용자의 활성 fcm_tokens 로 푸시
pub async fn push_to_user(
    client: Option<&FcmClient>,
    pool: &PgPool,
    user_id: i64,
    title: &str,
    body: &str,
    data: Value,
) {
    let Some(c) = client else { return };
    let tokens: Vec<(i64, String)> = sqlx::query_as(
        r#"SELECT id, token FROM fcm_tokens
            WHERE user_id = $1 AND active = TRUE"#,
    )
    .bind(user_id).fetch_all(pool).await.unwrap_or_default();
    if tokens.is_empty() { return; }
    send_to_tokens(c, pool, tokens, title, body, data).await;
}

/// 모든 admin 의 활성 fcm_tokens 로 푸시 (제외 사용자: 발신자 자신)
pub async fn push_to_admins(
    client: Option<&FcmClient>,
    pool: &PgPool,
    exclude_user_id: Option<i64>,
    title: &str,
    body: &str,
    data: Value,
) {
    let Some(c) = client else { return };
    let tokens: Vec<(i64, String)> = sqlx::query_as(
        r#"SELECT t.id, t.token
             FROM fcm_tokens t
             JOIN users u ON u.id = t.user_id
            WHERE u.role = 'admin' AND t.active = TRUE
              AND ($1::BIGINT IS NULL OR t.user_id <> $1)"#,
    )
    .bind(exclude_user_id).fetch_all(pool).await.unwrap_or_default();
    if tokens.is_empty() { return; }
    send_to_tokens(c, pool, tokens, title, body, data).await;
}

async fn send_to_tokens(
    client: &FcmClient,
    pool: &PgPool,
    tokens: Vec<(i64, String)>,
    title: &str,
    body: &str,
    data: Value,
) {
    let access = match client.access_token().await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("fcm push: token fail: {e:#}");
            return;
        }
    };
    // notification body 200자 cap (FCM size limit + UI 가독성)
    let body_short: String = body.chars().take(200).collect();
    let message = json!({
        "notification": { "title": title, "body": body_short },
        "data": data,
        "android": { "priority": "HIGH" },
    });
    for (token_id, token) in tokens {
        match client.send_to_token(&access, &token, message.clone()).await {
            Ok(true)  => tracing::debug!(token_id, "fcm push: sent"),
            Ok(false) => {
                let _ = sqlx::query("UPDATE fcm_tokens SET active = FALSE WHERE id = $1")
                    .bind(token_id).execute(pool).await;
            }
            Err(e) => tracing::warn!(token_id, "fcm push: {e:#}"),
        }
    }
}
