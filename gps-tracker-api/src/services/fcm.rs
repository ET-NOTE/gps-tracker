// FCM: transactional event enqueue and durable per-recipient delivery retries.
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

use super::notification_policy as policy;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use rand::Rng;
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
    device_name: Option<String>, // devices.display_name JOIN — 알림 본문 노출용
    kind: String,
    data: Option<Value>,
    user_id: Option<i64>, // 이벤트 생성 시점의 owner — 해당 사용자에게만 푸시
    occurred_at: chrono::DateTime<chrono::Utc>,
}

/// 알림 본문에 노출할 디바이스 라벨. display_name 있으면 우선, 없으면 #ID 폴백.
fn dev_label(ev: &PendingEvent) -> String {
    match ev.device_name.as_deref() {
        Some(s) if !s.trim().is_empty() => policy::compact(s, 28),
        _ => format!("내 장치 #{}", ev.device_id),
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
    send_url: String,
}

impl FcmClient {
    pub fn try_load(path: &str) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        let sa: ServiceAccount = serde_json::from_str(&raw)?;
        EncodingKey::from_rsa_pem(sa.private_key.as_bytes())?;
        let send_url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            sa.project_id
        );
        Ok(Self {
            send_url,
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

    async fn send_to_token(
        &self,
        access: &str,
        token: &str,
        message: Value,
        ticket: super::access_ledger::Ticket,
    ) -> Delivery {
        let body = json!({"message": {"token":token, "notification":message["notification"],
            "data":stringify_data(&message["data"]), "android":message["android"]}});
        let result = self
            .http
            .post(&self.send_url)
            .bearer_auth(access)
            .json(&body)
            .send()
            .await;
        let response = match super::access_ledger::external_response(ticket, result).await {
            Ok(res) => res,
            Err(_) => return Delivery::Retry(60, "transport".into()),
        };
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(retry_after_seconds)
            .unwrap_or(60);
        if status == 401 {
            *self.cached_token.lock().await = None;
        }
        let payload = response.json::<Value>().await.unwrap_or(Value::Null);
        classify_response(status, &payload, retry_after)
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
            Value::Null => String::new(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            other => other.to_string(), // JSON 직렬화
        };
        out.insert(k.clone(), Value::String(s));
    }
    Value::Object(out)
}

#[derive(Debug, PartialEq)]
enum Delivery {
    Sent,
    Unregistered,
    Retry(u64, String),
    Permanent(String),
}

fn retry_after_seconds(value: &str) -> u64 {
    value
        .parse::<u64>()
        .ok()
        .or_else(|| {
            chrono::DateTime::parse_from_rfc2822(value)
                .ok()
                .map(|d| (d.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64)
        })
        .unwrap_or(60)
        .min(86400)
}

fn classify_response(status: u16, body: &Value, retry_after: u64) -> Delivery {
    if (200..300).contains(&status) {
        return Delivery::Sent;
    }
    let unregistered = body["error"]["details"].as_array().is_some_and(|details| {
        details.iter().any(|d| {
            d["@type"] == "type.googleapis.com/google.firebase.fcm.v1.FcmError"
                && d["errorCode"] == "UNREGISTERED"
        })
    });
    if unregistered {
        return Delivery::Unregistered;
    }
    if matches!(status, 401 | 408 | 429 | 500..=599) {
        return Delivery::Retry(retry_after.max(60), format!("http_{status}"));
    }
    Delivery::Permanent(format!("http_{status}"))
}

fn retry_delay(attempt: i32, minimum: u64) -> u64 {
    (60u64.saturating_mul(1 << (attempt.saturating_sub(1).min(8) as u32)))
        .min(21600)
        .max(minimum)
}

/// A configured but invalid key must fail startup, never consume events in dry-run.
pub fn make_client(path: Option<&str>) -> anyhow::Result<Option<Arc<FcmClient>>> {
    path.map(|p| FcmClient::try_load(p).map(Arc::new))
        .transpose()
}

pub fn spawn(pool: PgPool, client: Option<Arc<FcmClient>>) {
    if client.is_none() {
        tracing::info!("fcm worker: dry-run mode (no FCM client)");
    }
    tokio::spawn(async move {
        loop {
            if let Err(e) = process_batch(&pool, client.as_deref()).await {
                tracing::warn!("fcm worker batch deferred: {e:#}");
                sleep(Duration::from_secs(60)).await;
            } else {
                sleep(POLL_INTERVAL).await;
            }
        }
    });
}

/// Event evaluation and per-recipient enqueue commit together. Sending happens
/// after commit, so HTTP failures and restarts cannot consume unsent events.
async fn enqueue_events(pool: &PgPool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    let pending: Vec<PendingEvent> = sqlx::query_as(
        r#"SELECT e.id,e.device_id,d.display_name AS device_name,e.kind,e.data,e.user_id,e.occurred_at
           FROM events e LEFT JOIN devices d ON d.id=e.device_id
           WHERE e.notified_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM privacy_account_controls c WHERE c.restricted AND (c.user_id=e.user_id OR c.user_id=d.owner_id))
           ORDER BY e.occurred_at LIMIT $1
           FOR UPDATE OF e SKIP LOCKED"#,
    )
    .bind(BATCH)
    .fetch_all(&mut *tx)
    .await?;
    for ev in pending {
        if policy::relevant(pool, ev.id).await? {
            let message = event_message(pool, &ev).await;
            sqlx::query(
                r#"INSERT INTO fcm_outbox(event_id,token_id,user_id,binding_hash,message)
                SELECT $1,id,user_id,revocation_hash,$3 FROM fcm_tokens WHERE user_id=$2 AND active
                ON CONFLICT(event_id,token_id) DO NOTHING"#,
            )
            .bind(ev.id)
            .bind(ev.user_id)
            .bind(message)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query("UPDATE events SET notified_at=now() WHERE id=$1")
            .bind(ev.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(FromRow)]
struct QueuedPush {
    id: i64,
    token_id: i64,
    token: String,
    message: Value,
    attempts: i32,
    binding_hash: Option<String>,
    event_id: Option<i64>,
    created_at: chrono::DateTime<chrono::Utc>,
}

async fn process_batch(pool: &PgPool, client: Option<&FcmClient>) -> anyhow::Result<()> {
    let Some(client) = client else {
        sqlx::query("UPDATE events SET notified_at=now() WHERE id IN (SELECT e.id FROM events e LEFT JOIN devices d ON d.id=e.device_id WHERE e.notified_at IS NULL AND NOT EXISTS (SELECT 1 FROM privacy_account_controls c WHERE c.restricted AND (c.user_id=e.user_id OR c.user_id=d.owner_id)) ORDER BY e.occurred_at LIMIT $1)")
            .bind(BATCH).execute(pool).await?;
        return Ok(());
    };
    await_queue_cleanup(pool).await?;
    enqueue_events(pool).await?;
    let access = client.access_token().await?;
    for _ in 0..BATCH {
        let item: Option<QueuedPush> = sqlx::query_as(
            r#"WITH picked AS (
            SELECT id FROM fcm_outbox WHERE status='pending' AND available_at<=now()
              AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id
            LIMIT 1 FOR UPDATE SKIP LOCKED
          ), claimed AS (
            UPDATE fcm_outbox o SET lease_until=now()+interval '90 seconds',attempts=attempts+1
            FROM picked p WHERE o.id=p.id RETURNING o.*)
          SELECT c.id,c.token_id,t.token,c.message,c.attempts,c.binding_hash,c.event_id,c.created_at FROM claimed c
          JOIN fcm_tokens t ON t.id=c.token_id AND t.active AND t.user_id=c.user_id
            AND t.revocation_hash IS NOT DISTINCT FROM c.binding_hash"#,
        )
        .fetch_optional(pool)
        .await?;
        let Some(mut item) = item else { break };
        let mut ledger_access = None;
        if let Some(event) = item.event_id {
            if !policy::relevant(pool, event).await? {
                cancel_delivery(pool, item.id, "no_longer_relevant").await?;
                continue;
            }
            let ev: PendingEvent = sqlx::query_as("SELECT e.id,e.device_id,d.display_name AS device_name,e.kind,e.data,e.user_id,e.occurred_at FROM events e JOIN devices d ON d.id=e.device_id WHERE e.id=$1")
                .bind(event).fetch_one(pool).await?;
            item.message = event_message(pool, &ev).await;
            ledger_access = push_access(&ev);
        } else if !matches!(
            item.message["data"]["kind"].as_str(),
            Some("chat_admin_message" | "chat_user_message")
        ) {
            cancel_delivery(pool, item.id, "unsupported_notification").await?;
            continue;
        } else if item.message["data"]["notification_channel"]
            .as_str()
            .is_none()
        {
            // Also upgrades already queued messages to the new channels/expiry.
            item.message = policy::message(
                item.message["notification"]["title"]
                    .as_str()
                    .unwrap_or("새 상담 메시지"),
                item.message["notification"]["body"]
                    .as_str()
                    .unwrap_or("앱에서 메시지를 확인해 주세요."),
                item.message["data"].clone(),
                item.created_at,
            );
        }
        let expires = chrono::DateTime::parse_from_rfc3339(
            item.message["data"]["expires_at"].as_str().unwrap_or(""),
        )?;
        let seconds = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds();
        if seconds <= 0 {
            cancel_delivery(pool, item.id, "expired").await?;
            continue;
        }
        item.message["android"]["ttl"] = json!(format!("{seconds}s"));
        // Drain an already-authorized send before closure commits. Queued work
        // cannot send after the account barrier and token revocation commit.
        let mut authorization = pool.begin().await?;
        let active: Option<i64> = sqlx::query_scalar("SELECT c.user_id FROM privacy_account_controls c JOIN fcm_outbox o ON o.user_id=c.user_id JOIN fcm_tokens t ON t.id=o.token_id AND t.active WHERE o.id=$1 AND NOT c.restricted AND t.revocation_hash IS NOT DISTINCT FROM o.binding_hash FOR SHARE OF c")
            .bind(item.id).fetch_optional(&mut *authorization).await?;
        if active.is_none() {
            continue;
        }
        let ticket = match ledger_access {
            Some(access) => super::access_ledger::begin(access).await?,
            None => super::access_ledger::Ticket::off(),
        };
        let outcome = client
            .send_to_token(&access, &item.token, item.message, ticket)
            .await;
        authorization.commit().await?;
        let (status, delay, error) = match outcome {
            Delivery::Sent => {
                tracing::info!(delivery_id = item.id, token_id = item.token_id, "fcm: sent");
                ("sent", 0, None)
            }
            Delivery::Unregistered => {
                sqlx::query("UPDATE fcm_tokens SET active=FALSE WHERE id=$1 AND revocation_hash IS NOT DISTINCT FROM $2")
                    .bind(item.token_id).bind(&item.binding_hash).execute(pool).await?;
                ("cancelled", 0, Some("unregistered".to_string()))
            }
            Delivery::Retry(minimum, error) if item.attempts < 10 => {
                let delay =
                    retry_delay(item.attempts, minimum) + rand::thread_rng().gen_range(0..=15);
                tracing::warn!(
                    delivery_id = item.id,
                    attempt = item.attempts,
                    delay,
                    error,
                    "fcm: retry scheduled"
                );
                ("pending", delay as i64, Some(error))
            }
            Delivery::Retry(_, error) | Delivery::Permanent(error) => {
                tracing::error!(delivery_id = item.id, error, "fcm: delivery dead-lettered");
                ("dead", 0, Some(error))
            }
        };
        sqlx::query(r#"UPDATE fcm_outbox SET status=$2, available_at=now()+$3*interval '1 second',
            lease_until=NULL,last_error=$4,finished_at=CASE WHEN $2='pending' THEN NULL ELSE now() END
            WHERE id=$1"#).bind(item.id).bind(status).bind(delay).bind(error).execute(pool).await?;
    }
    Ok(())
}

async fn cancel_delivery(pool: &PgPool, id: i64, reason: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE fcm_outbox SET status='cancelled',finished_at=now(),lease_until=NULL,last_error=$2 WHERE id=$1")
        .bind(id).bind(reason).execute(pool).await?;
    Ok(())
}

async fn await_queue_cleanup(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query(r#"UPDATE fcm_outbox o SET status='cancelled',finished_at=now(),last_error='binding_revoked'
        WHERE status='pending' AND NOT EXISTS (SELECT 1 FROM fcm_tokens t WHERE t.id=o.token_id
          AND t.user_id=o.user_id AND t.active AND t.revocation_hash IS NOT DISTINCT FROM o.binding_hash)"#)
        .execute(pool).await?;
    sqlx::query("UPDATE fcm_outbox SET status='dead',finished_at=now(),last_error='expired' WHERE status='pending' AND created_at<now()-interval '24 hours'")
        .execute(pool).await?;
    sqlx::query("DELETE FROM fcm_outbox WHERE id IN (SELECT id FROM fcm_outbox WHERE finished_at<now()-interval '14 days' LIMIT 200)")
        .execute(pool).await?;
    sqlx::query("DELETE FROM fcm_revocations WHERE secret_hash IN (SELECT secret_hash FROM fcm_revocations WHERE created_at<now()-interval '30 days' LIMIT 200)")
        .execute(pool).await?;
    Ok(())
}

fn notification(title: &str, body: &str, data: Value) -> Value {
    policy::message(title, body, data, chrono::Utc::now())
}

fn title_for_kind(kind: &str) -> &'static str {
    match kind {
        "low_batt" => "배터리 확인 필요",
        "offline" => "연결 확인 필요",
        "signal_loss" => "새 정보 수신 지연",
        "online" => "연결이 복구되었습니다",
        "sleep_enter" => "절전 모드로 전환",
        "wake" => "장치 작동 재개",
        "motion" => "움직임 감지",
        "cycle_first_fix" => "위치가 확인되었습니다",
        "geofence_in" => "설정한 구역에 들어왔습니다",
        "geofence_out" => "설정한 구역을 벗어났습니다",
        "geofence_armed" => "구역 알림 설정 완료",
        "brownout" => "전원 확인 필요",
        "gps_anomaly" => "위치 확인 지연",
        "reservation_starting" => "차량 예약 시작 안내",
        "reservation_ending" => "차량 예약 종료 안내",
        "rental_ending" => "차량 반납 예정 안내",
        "rental_overdue" => "차량 반납 확인 필요",
        _ => "장치 상태 안내", // Unknown events are denied by the policy.
    }
}

async fn resolve_addr(pool: &PgPool, device: i64, lat: f64, lng: f64) -> Option<String> {
    let mut r = super::access_ledger::about(
        super::access_ledger::Target::Device(device),
        super::kakao_geo::reverse_many_cached(pool, &[(lat, lng)]),
    )
    .await;
    r.pop().flatten().map(|x| x.short())
}

/// A push whose text comes from a position (a place name, a zone crossing) is handed to the push service.
fn push_access(ev: &PendingEvent) -> Option<super::access_ledger::Access> {
    if matches!(
        policy::kind(&ev.kind, ev.data.as_ref()),
        "cycle_first_fix" | "geofence_in" | "geofence_out"
    ) {
        Some(super::access_ledger::Access {
            at: chrono::Utc::now(),
            target: match ev.user_id {
                Some(account) => super::access_ledger::Target::ScopedDevice {
                    account,
                    device: ev.device_id,
                },
                None => super::access_ledger::Target::Unattributed,
            },
            recipient: super::access_ledger::Recipient::Processor("fcm"),
            path: "server",
            method: "push",
            route: "fcm",
            range: None,
        })
    } else {
        None
    }
}

fn schedule_time(data: Option<&Value>, field: &str) -> String {
    data.and_then(|d| d[field].as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| {
            t.with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap())
                .format("%m월 %d일 %H:%M (한국 시간)")
                .to_string()
        })
        .unwrap_or_else(|| "앱에 등록된 시간".into())
}

fn silence_duration(minutes: i64) -> String {
    if minutes >= 1440 {
        let days = minutes / 1440;
        let hours = (minutes % 1440) / 60;
        if hours == 0 {
            format!("{days}일")
        } else {
            format!("{days}일 {hours}시간")
        }
    } else if minutes >= 60 {
        let hours = minutes / 60;
        let rest = minutes % 60;
        if rest == 0 {
            format!("{hours}시간")
        } else {
            format!("{hours}시간 {rest}분")
        }
    } else {
        format!("{minutes}분")
    }
}

fn body_for_event(ev: &PendingEvent, address: Option<&str>) -> String {
    let d = ev.data.as_ref();
    let area = d
        .and_then(|d| d["geofence_name"].as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("설정한 구역");
    match policy::kind(&ev.kind, d) {
        "low_batt" => super::battery::alert_body(d.and_then(|d| d["vbat_mv"].as_i64()).and_then(|v| i32::try_from(v).ok())),
        "geofence_armed" => match d.and_then(|d| d["inside"].as_bool()) {
            Some(true) => format!("‘{area}’의 출입 알림을 켰습니다. 현재 구역 안에 있습니다."),
            Some(false) => format!("‘{area}’의 출입 알림을 켰습니다. 현재 구역 밖에 있습니다."),
            None => format!("‘{area}’의 출입 알림을 켰습니다."),
        },
        "geofence_in" => format!("‘{area}’ 안에서 위치가 확인되었습니다."),
        "geofence_out" => format!("‘{area}’ 밖에서 위치가 확인되었습니다. 앱에서 위치를 확인해 주세요."),
        "brownout" => "전압 저하에 따른 재시작 기록이 확인되었습니다. 배터리와 전원 연결을 확인해 주세요.".into(),
        "gps_anomaly" => "최근 위치 확인이 여러 차례 완료되지 않았습니다. 실내·지하에서는 GPS 수신이 어려울 수 있습니다. 장치와 안테나 상태를 확인해 주세요.".into(),
        "offline" | "signal_loss" => {
            let minutes = d.and_then(|d| d["silence_min"].as_i64()).filter(|m| *m > 0);
            let elapsed = minutes.map(|m| format!("최근 {} 동안", silence_duration(m))).unwrap_or_else(|| "최근".into());
            let action = if ev.kind == "offline" { " 전원과 통신 상태를 확인해 주세요. 다시 수신될 때까지 같은 안내를 반복하지 않습니다." } else { " 수신이 재개되면 최신 상태가 표시됩니다." };
            format!("{elapsed} 장치의 새 정보가 도착하지 않았습니다.{action}")
        },
        "online" => "장치에서 정보를 다시 받고 있습니다. 앱에서 최신 상태를 확인할 수 있습니다.".into(),
        "sleep_enter" => "배터리 절약을 위해 절전 모드로 전환했습니다. 절전 중에는 위치 갱신이 잠시 멈춥니다.".into(),
        "wake" => match d.and_then(|d| d["wake_cause"].as_str()) {
            Some("timer") => "정기 확인을 위해 장치가 작동을 재개했습니다. 최신 정보는 앱에서 확인해 주세요.",
            Some("boot") => "장치가 켜졌습니다. 최신 정보는 앱에서 확인해 주세요.",
            _ => "장치가 작동을 재개했습니다. 최신 정보는 앱에서 확인해 주세요.",
        }.into(),
        "reservation_starting" => format!("예약 시작: {}. 앱의 차량 예약에서 이용 일정을 확인해 주세요.", schedule_time(d, "starts_at")),
        "reservation_ending" => format!("예약 종료: {}. 차량 이용을 마치고 다음 일정을 확인해 주세요.", schedule_time(d, "ends_at")),
        "rental_ending" => format!("반납 예정: {}. 앱의 임대 계약에서 반납 일정을 확인해 주세요.", schedule_time(d, "ends_at")),
        "rental_overdue" => format!("반납 예정 시간({})이 지났습니다. 실제 반납 여부를 확인하고 계약 상태를 변경해 주세요.", schedule_time(d, "ends_at")),
        "motion" => "움직임이 감지되어 장치가 깨어났습니다. 실제 이동 여부는 앱에서 위치를 확인해 주세요.".into(),
        "cycle_first_fix" => address.map(|a| format!("새 위치가 확인되었습니다. 위치: {a}")).unwrap_or_else(|| "새 위치가 확인되었습니다. 앱에서 위치를 확인해 주세요.".into()),
        _ => String::new(),
    }
}

async fn event_message(pool: &PgPool, ev: &PendingEvent) -> Value {
    let kind = policy::kind(&ev.kind, ev.data.as_ref());
    let address = if kind == "cycle_first_fix" {
        match ev
            .data
            .as_ref()
            .and_then(|d| Some((d["lat"].as_f64()?, d["lng"].as_f64()?)))
        {
            Some((lat, lng)) => resolve_addr(pool, ev.device_id, lat, lng).await,
            None => None,
        }
    } else {
        None
    };
    let mut data =
        json!({"kind":kind,"device_id":ev.device_id.to_string(),"event_id":ev.id.to_string()});
    for field in ["reservation_id", "contract_id"] {
        if let Some(id) = ev.data.as_ref().and_then(|d| d[field].as_i64()) {
            data[field] = json!(id.to_string());
        }
    }
    let title = if kind == "low_batt" {
        super::battery::alert_title(
            ev.data
                .as_ref()
                .and_then(|d| d["vbat_mv"].as_i64())
                .and_then(|v| i32::try_from(v).ok()),
        )
    } else if kind == "wake"
        && ev.data.as_ref().and_then(|d| d["wake_cause"].as_str()) == Some("timer")
    {
        "정기 상태 보고"
    } else {
        title_for_kind(kind)
    };
    policy::message(
        &format!("{} · {}", dev_label(ev), title),
        &body_for_event(ev, address.as_deref()),
        data,
        ev.occurred_at,
    )
}

// Chat and system notifications use the same durable per-recipient queue.
pub async fn push_to_user(
    client: Option<&FcmClient>,
    pool: &PgPool,
    user_id: i64,
    title: &str,
    body: &str,
    data: Value,
) {
    if client.is_none() {
        return;
    }
    let result = sqlx::query(
        r#"INSERT INTO fcm_outbox(token_id,user_id,binding_hash,message)
        SELECT id,user_id,revocation_hash,$2 FROM fcm_tokens WHERE user_id=$1 AND active"#,
    )
    .bind(user_id)
    .bind(notification(title, body, data))
    .execute(pool)
    .await;
    if let Err(e) = result {
        tracing::error!("fcm chat enqueue failed: {e}");
    }
}

pub async fn push_to_admins(
    client: Option<&FcmClient>,
    pool: &PgPool,
    exclude_user_id: Option<i64>,
    title: &str,
    body: &str,
    data: Value,
) {
    if client.is_none() {
        return;
    }
    let result = sqlx::query(
        r#"INSERT INTO fcm_outbox(token_id,user_id,binding_hash,message)
        SELECT t.id,t.user_id,t.revocation_hash,$2 FROM fcm_tokens t JOIN users u ON u.id=t.user_id
        WHERE u.role='admin' AND t.active AND ($1::bigint IS NULL OR t.user_id<>$1)"#,
    )
    .bind(exclude_user_id)
    .bind(notification(title, body, data))
    .execute(pool)
    .await;
    if let Err(e) = result {
        tracing::error!("fcm admin enqueue failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_copy_uses_readable_units() {
        assert_eq!(silence_duration(5), "5분");
        assert_eq!(silence_duration(90), "1시간 30분");
        assert_eq!(silence_duration(1440), "1일");
        assert_eq!(silence_duration(36035), "25일");
        assert_eq!(silence_duration(1500), "1일 1시간");
    }
    /// Run against a disposable PostgreSQL database on the build runner only.
    #[tokio::test]
    #[ignore = "requires GPS_FCM_TEST_DB on the isolated build runner"]
    async fn durable_queue_recovers_without_cross_account_or_partial_success_replay() {
        use axum::{extract::State, routing::post, Json, Router};
        use std::collections::HashMap;
        let url = std::env::var("GPS_FCM_TEST_DB").expect("dedicated test database required");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .connect(&url)
            .await
            .unwrap();
        // Exercise PostgreSQL's real integer arithmetic over every ADC mV.
        let calibration_sql = format!(
            "SELECT x, {} FROM generate_series(0,65536) x",
            crate::services::battery::sql_calibrated_mv("x")
        );
        let calibrated: Vec<(i32, Option<i32>)> = sqlx::query_as(&calibration_sql)
            .fetch_all(&pool)
            .await
            .unwrap();
        for (raw, actual) in calibrated {
            assert_eq!(
                actual,
                crate::services::battery::calibrated_mv(raw),
                "ADC {raw}"
            );
        }
        sqlx::raw_sql(r#"
          CREATE TABLE users(id bigint PRIMARY KEY,role text);
          CREATE TABLE privacy_account_controls(user_id bigint PRIMARY KEY, restricted boolean DEFAULT false);
          CREATE TABLE devices(id bigint PRIMARY KEY,display_name text,owner_id bigint,last_seen_at timestamptz,last_fix_at timestamptz,last_stationary jsonb);
          CREATE TABLE location_records(device_id bigint,user_id bigint,vbat_mv integer,recorded_at timestamptz DEFAULT now());
          CREATE TABLE events(id bigserial PRIMARY KEY,device_id bigint,user_id bigint,kind text,data jsonb,
                              occurred_at timestamptz DEFAULT now(),notified_at timestamptz);
          CREATE TABLE fcm_tokens(id bigserial PRIMARY KEY,user_id bigint REFERENCES users(id),token text UNIQUE,
                                 active bool DEFAULT true);
          CREATE TABLE notification_settings(user_id bigint PRIMARY KEY,low_batt_alert bool,offline_alert bool,
              signal_loss_alert bool,online_alert bool,sleep_alert bool,wake_alert bool,cycle_first_fix_alert bool,
              geofence_alert bool,device_health_alert bool,motion_alert bool,low_batt_threshold_mv integer,
              signal_loss_minutes integer,offline_minutes integer,updated_at timestamptz DEFAULT now());
          CREATE TABLE vehicle_reservations(id bigint PRIMARY KEY,user_id bigint,device_id bigint,status text,starts_at timestamptz,ends_at timestamptz,fleet_vehicle_id bigint);
          CREATE TABLE fleet_vehicle_bindings(vehicle_id bigint,owner_id bigint,device_id bigint,is_primary boolean,ended_at timestamptz);
          CREATE TABLE rental_contracts(id bigint PRIMARY KEY,user_id bigint,device_id bigint,status text,ends_at timestamptz);
          INSERT INTO users VALUES (1,'user'),(2,'user');
          INSERT INTO privacy_account_controls(user_id) VALUES(1),(2);
          INSERT INTO devices VALUES (1,'test device',1,now(),NULL);
        "#).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0065_fcm_delivery_queue.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/0067_schedule_notification_settings.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/0068_connection_alert_episodes.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(r#"
          INSERT INTO fcm_tokens(user_id,token,revocation_hash) VALUES (1,'good','A'),(1,'retry','B');
          INSERT INTO events(device_id,user_id,kind,data) VALUES(1,1,'low_batt','{"vbat_mv":3200}');
        "#).execute(&pool).await.unwrap();
        // 3510mV raw is below 3500mV after calibration: eligibility must use
        // the displayed voltage, including latest no-GPS/missing samples.
        sqlx::query(r#"UPDATE events SET data='{"vbat_mv":3510}' WHERE id=1"#)
            .execute(&pool)
            .await
            .unwrap();
        assert!(crate::services::notification_policy::relevant(&pool, 1)
            .await
            .unwrap());
        sqlx::query("INSERT INTO location_records(device_id,user_id,vbat_mv) VALUES(1,1,NULL)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!crate::services::notification_policy::relevant(&pool, 1)
            .await
            .unwrap());
        sqlx::query("UPDATE location_records SET vbat_mv=4100")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!crate::services::notification_policy::relevant(&pool, 1)
            .await
            .unwrap());
        sqlx::query("DELETE FROM location_records")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(r#"UPDATE events SET data='{"vbat_mv":3200}' WHERE id=1"#)
            .execute(&pool)
            .await
            .unwrap();
        let counts = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let app = Router::new()
            .route(
                "/send",
                post(
                    |State(counts): State<Arc<Mutex<HashMap<String, usize>>>>,
                     Json(body): Json<Value>| async move {
                        let token = body["message"]["token"].as_str().unwrap().to_owned();
                        let mut counts = counts.lock().await;
                        let count = counts.entry(token.clone()).or_default();
                        *count += 1;
                        if token == "retry" && *count == 1 {
                            (
                                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                                Json(json!({"error":{}})),
                            )
                        } else {
                            (axum::http::StatusCode::OK, Json(json!({"name":"test"})))
                        }
                    },
                ),
            )
            .with_state(counts.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = FcmClient {
            sa: ServiceAccount {
                project_id: "test".into(),
                private_key: String::new(),
                client_email: String::new(),
                token_uri: String::new(),
            },
            http: reqwest::Client::new(),
            send_url: format!("http://{addr}/send"),
            cached_token: Mutex::new(Some((
                "test".into(),
                Instant::now() + Duration::from_secs(3600),
            ))),
        };
        process_batch(&pool, Some(&client)).await.unwrap();
        let states: Vec<String> =
            sqlx::query_scalar("SELECT status FROM fcm_outbox ORDER BY token_id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(states, ["sent", "pending"]);
        sqlx::query("UPDATE fcm_outbox SET available_at=now() WHERE status='pending'")
            .execute(&pool)
            .await
            .unwrap();
        process_batch(&pool, Some(&client)).await.unwrap();
        assert_eq!(counts.lock().await.get("good"), Some(&1));
        assert_eq!(counts.lock().await.get("retry"), Some(&2));
        // A new process can reclaim an expired lease, while a revoked/reassigned
        // binding is cancelled rather than leaking an old owner's notification.
        sqlx::raw_sql(
            r#"
          INSERT INTO fcm_outbox(token_id,user_id,binding_hash,message,lease_until)
            SELECT id,user_id,revocation_hash,'{"data":{"kind":"chat_admin_message"}}',now()-interval '1 second' FROM fcm_tokens;
          UPDATE fcm_tokens SET user_id=2,revocation_hash='new-owner' WHERE token='good';
        "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        process_batch(&pool, Some(&client)).await.unwrap();
        assert_eq!(counts.lock().await.get("good"), Some(&1));
        assert_eq!(counts.lock().await.get("retry"), Some(&3));
        let cancelled: i64 =
            sqlx::query_scalar("SELECT count(*) FROM fcm_outbox WHERE status='cancelled'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cancelled, 1);
        // An offline retry must be cancelled once a heartbeat has recovered it.
        sqlx::raw_sql("UPDATE devices SET last_seen_at=now()-interval '25 hours'")
            .execute(&pool)
            .await
            .unwrap();
        super::super::connection_alerts::scan(&pool).await.unwrap();
        enqueue_events(&pool).await.unwrap();
        sqlx::query("UPDATE devices SET last_seen_at=now() WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        process_batch(&pool, Some(&client)).await.unwrap();
        assert_eq!(counts.lock().await.get("retry"), Some(&3));
        let stale: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM fcm_outbox WHERE last_error='no_longer_relevant'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stale, 1);
        sqlx::query("INSERT INTO notification_settings(user_id,wake_alert,sleep_alert) VALUES(1,false,true)").execute(&pool).await.unwrap();
        let timer: i64=sqlx::query_scalar(r#"INSERT INTO events(device_id,user_id,kind,data) VALUES(1,1,'wake','{"wake_cause":"timer","diag":{"boots":99}}') RETURNING id"#).fetch_one(&pool).await.unwrap();
        assert!(!policy::relevant(&pool, timer).await.unwrap());
        sqlx::query("UPDATE notification_settings SET wake_alert=true")
            .execute(&pool)
            .await
            .unwrap();
        assert!(policy::relevant(&pool, timer).await.unwrap());
        let returned: i64=sqlx::query_scalar(r#"INSERT INTO events(device_id,user_id,kind,data) VALUES(1,1,'sleep_enter','{"sleep_reason":"timer_hb","diag":{"boots":99}}') RETURNING id"#).fetch_one(&pool).await.unwrap();
        assert!(
            policy::relevant(&pool, timer).await.unwrap(),
            "heartbeat remains deliverable after returning to sleep"
        );
        assert!(
            !policy::relevant(&pool, returned).await.unwrap(),
            "heartbeat re-sleep must not send a second notification"
        );
        sqlx::query("UPDATE notification_settings SET wake_alert=false")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            !policy::relevant(&pool, timer).await.unwrap(),
            "disabling before send cancels queued heartbeat"
        );
        sqlx::query("DELETE FROM notification_settings")
            .execute(&pool)
            .await
            .unwrap();
        // Internal diagnostics cannot bypass preferences as generic notifications.
        let stuck: i64 = sqlx::query_scalar(
            "INSERT INTO events(device_id,user_id,kind) VALUES(1,1,'stuck') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(!policy::relevant(&pool, stuck).await.unwrap());
        sqlx::query("INSERT INTO notification_settings(user_id,motion_alert,wake_alert,cycle_first_fix_alert) VALUES(1,false,true,true)").execute(&pool).await.unwrap();
        let motion: i64 = sqlx::query_scalar("INSERT INTO events(device_id,user_id,kind,data) VALUES(1,1,'wake','{\"wake_cause\":\"motion\"}') RETURNING id").fetch_one(&pool).await.unwrap();
        assert!(!policy::relevant(&pool, motion).await.unwrap());
        sqlx::query("UPDATE notification_settings SET motion_alert=true,wake_alert=false")
            .execute(&pool)
            .await
            .unwrap();
        assert!(policy::relevant(&pool, motion).await.unwrap());
        sqlx::query("UPDATE devices SET owner_id=2")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!policy::relevant(&pool, motion).await.unwrap());
        sqlx::query("UPDATE devices SET owner_id=1")
            .execute(&pool)
            .await
            .unwrap();
        let old: i64 = sqlx::query_scalar("INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(1,1,'cycle_first_fix',now()-interval '2 hours') RETURNING id").fetch_one(&pool).await.unwrap();
        assert!(!policy::relevant(&pool, old).await.unwrap());
        sqlx::query("INSERT INTO location_records(device_id,user_id,vbat_mv) VALUES(1,1,3900)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!policy::relevant(&pool, 1).await.unwrap());
        sqlx::query("UPDATE notification_settings SET low_batt_threshold_mv=4000")
            .execute(&pool)
            .await
            .unwrap();
        assert!(policy::relevant(&pool, 1).await.unwrap());
        // Schedule reminders must honor current ownership, opt-outs, and changed dates.
        sqlx::raw_sql("INSERT INTO vehicle_reservations(id,user_id,device_id,status,starts_at,ends_at) VALUES(10,1,1,'planned',now()+interval '20 minutes',now()+interval '25 minutes'),(11,1,1,'planned',now()+interval '21 minutes',now()+interval '26 minutes'); INSERT INTO rental_contracts VALUES(20,1,1,'active',now()+interval '2 hours'),(21,1,1,'overdue',now()-interval '1 hour');").execute(&pool).await.unwrap();
        let mut reminders = Vec::new();
        for (kind, id, table, key, field) in [
            (
                "reservation_starting",
                10,
                "vehicle_reservations",
                "reservation_id",
                "starts_at",
            ),
            (
                "reservation_starting",
                11,
                "vehicle_reservations",
                "reservation_id",
                "starts_at",
            ),
            (
                "reservation_ending",
                10,
                "vehicle_reservations",
                "reservation_id",
                "ends_at",
            ),
            (
                "rental_ending",
                20,
                "rental_contracts",
                "contract_id",
                "ends_at",
            ),
            (
                "rental_overdue",
                21,
                "rental_contracts",
                "contract_id",
                "ends_at",
            ),
        ] {
            let query = format!("INSERT INTO events(device_id,user_id,kind,data) SELECT device_id,user_id,$1,jsonb_build_object('{key}',id,'{field}',{field}) FROM {table} WHERE id=$2 RETURNING id");
            let event: i64 = sqlx::query_scalar(&query)
                .bind(kind)
                .bind(id as i64)
                .fetch_one(&pool)
                .await
                .unwrap();
            reminders.push(event);
        }
        for id in &reminders {
            assert!(policy::relevant(&pool, *id).await.unwrap());
        }
        sqlx::query("UPDATE notification_settings SET reservation_alert=false,rental_alert=false")
            .execute(&pool)
            .await
            .unwrap();
        for id in &reminders {
            assert!(!policy::relevant(&pool, *id).await.unwrap());
        }
        sqlx::query("UPDATE notification_settings SET reservation_alert=true,rental_alert=true")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET owner_id=2")
            .execute(&pool)
            .await
            .unwrap();
        for id in &reminders {
            assert!(!policy::relevant(&pool, *id).await.unwrap());
        }
        sqlx::query("UPDATE devices SET owner_id=1")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE vehicle_reservations SET status='cancelled' WHERE id=10")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!policy::relevant(&pool, reminders[0]).await.unwrap());
        assert!(!policy::relevant(&pool, reminders[2]).await.unwrap());
        sqlx::query(
            "UPDATE vehicle_reservations SET starts_at=starts_at+interval '2 hours' WHERE id=11",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(!policy::relevant(&pool, reminders[1]).await.unwrap());
        sqlx::query("UPDATE rental_contracts SET ends_at=ends_at+interval '1 hour' WHERE id=20")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!policy::relevant(&pool, reminders[3]).await.unwrap());
        sqlx::query("UPDATE rental_contracts SET status='returned' WHERE id=21")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!policy::relevant(&pool, reminders[4]).await.unwrap());
        // Consume these policy fixtures before testing the failed transaction.
        enqueue_events(&pool).await.unwrap();
        // A database failure during enqueue must leave the event unconsumed.
        sqlx::raw_sql(r#"
          CREATE FUNCTION reject_push() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$;
          CREATE TRIGGER fail_push BEFORE INSERT ON fcm_outbox FOR EACH ROW EXECUTE FUNCTION reject_push();
          INSERT INTO events(device_id,user_id,kind,data) VALUES(1,1,'low_batt','{"vbat_mv":3200}');
        "#).execute(&pool).await.unwrap();
        assert!(enqueue_events(&pool).await.is_err());
        let pending: i64 =
            sqlx::query_scalar("SELECT count(*) FROM events WHERE notified_at IS NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(pending, 1);
        super::super::connection_alerts::check_episode_lifecycle(&pool).await;
        super::super::connection_alerts::check_daily_heartbeat_deadline(&pool).await;
        server.abort();
        pool.close().await;
    }
    #[test]
    fn retry_and_token_errors_are_distinct() {
        assert_eq!(
            classify_response(503, &json!({}), 120),
            Delivery::Retry(120, "http_503".into())
        );
        assert_eq!(
            classify_response(429, &json!({}), 0),
            Delivery::Retry(60, "http_429".into())
        );
        assert_eq!(
            classify_response(404, &json!({}), 60),
            Delivery::Permanent("http_404".into())
        );
        assert_eq!(
            classify_response(400, &json!({"error":{"status":"INVALID_ARGUMENT"}}), 60),
            Delivery::Permanent("http_400".into())
        );
        let invalid = json!({"error":{"details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}});
        assert_eq!(classify_response(404, &invalid, 60), Delivery::Unregistered);
        assert_eq!(retry_delay(1, 60), 60);
        assert_eq!(retry_delay(5, 3600), 3600);
        assert_eq!(retry_delay(100, 0), 15360);
    }
    #[test]
    fn channel_data_and_unicode_body_are_preserved() {
        let n = notification(
            "제목",
            &"한".repeat(201),
            json!({"thread_id":42,"kind":"chat_user_message"}),
        );
        assert!(n["notification"]["body"].as_str().unwrap().chars().count() <= 200);
        assert!(n["notification"]["body"].as_str().unwrap().contains('…'));
        assert_eq!(
            n["android"]["notification"]["channel_id"],
            "gps_messages_v1"
        );
        assert_eq!(stringify_data(&n["data"])["thread_id"], "42");
        assert_eq!(retry_after_seconds("120"), 120);
    }
    #[test]
    fn copy_does_not_invent_movement_signal_strength_or_battery_percentage() {
        let mut ev = PendingEvent {
            id: 1,
            device_id: 1,
            device_name: Some("내 차".into()),
            kind: "signal_loss".into(),
            data: Some(json!({"silence_min":1})),
            user_id: Some(1),
            occurred_at: chrono::Utc::now(),
        };
        assert!(body_for_event(&ev, None).starts_with("최근 1분 동안"));
        assert!(!body_for_event(&ev, None).contains("신호가 약"));
        ev.kind = "cycle_first_fix".into();
        assert!(!title_for_kind(&ev.kind).contains("운행"));
        assert!(!body_for_event(&ev, Some("서울 강남구")).contains("출발"));
        ev.kind = "low_batt".into();
        assert!(!body_for_event(&ev, None).contains('%'));
        ev.kind = "sleep_enter".into();
        assert!(body_for_event(&ev, None).contains("위치 갱신이 잠시 멈춥니다"));
        ev.kind = "wake".into();
        ev.data = Some(json!({"wake_cause":"timer"}));
        assert!(body_for_event(&ev, None).starts_with("정기 확인"));
        ev.data = Some(json!({"wake_cause":"boot"}));
        assert!(body_for_event(&ev, None).starts_with("장치가 켜졌습니다"));
        ev.data = None;
        assert!(!body_for_event(&ev, None).contains("거나"));
        ev.kind = "rental_overdue".into();
        ev.data = Some(json!({"ends_at":"2026-10-08T01:00:00Z","renter_phone":"private-phone"}));
        let body = body_for_event(&ev, None);
        assert!(body.contains("10월 08일 10:00 (한국 시간)"));
        assert!(body.contains("실제 반납 여부"));
        assert!(!body.contains("private-phone"));
    }
}
