// 1NCE Management API — SIM 잔량/상태 조회.
//
// 두 가지 인증 모드 지원:
//   A) ONCE_API_TOKEN 환경변수 — 사용자가 1NCE 포털 로그인 후 받은 Cognito 토큰
//      (1시간 유효, 만료 후 재발급 필요)
//   B) ONCE_API_CLIENT_ID + ONCE_API_CLIENT_SECRET — OAuth2 client_credentials (영구)
//
// 우선순위: B → A (둘 다 있으면 OAuth 자동 발급 우선).
//
// ICCID 정규화: 1NCE는 19자리 canonical ICCID 사용. 펌웨어가 보낸 20자리(끝 1자리 = Luhn
// 체크디짓) 들어오면 끝 1자리 잘라서 호출.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const TOKEN_URL: &str = "https://api.1nce.com/management-api/oauth/token";
const BASE_URL:  &str = "https://api.1nce.com/management-api/v1";

#[derive(Deserialize)]
struct TokenResp { access_token: String }

async fn obtain_token(client: &reqwest::Client, client_id: &str, client_secret: &str) -> anyhow::Result<String> {
    // 1NCE는 JSON body를 요구. (curl -d '{"grant_type":"client_credentials"}')
    let res: TokenResp = client.post(TOKEN_URL)
        .basic_auth(client_id, Some(client_secret))
        .json(&serde_json::json!({"grant_type": "client_credentials"}))
        .send().await?
        .error_for_status()?
        .json().await?;
    Ok(res.access_token)
}

/// 1NCE는 19자리 canonical ICCID 사용. 20자리 들어오면 끝 1자리(Luhn) 자름.
fn normalize_iccid(iccid: &str) -> String {
    if iccid.len() == 20 { iccid[..19].to_string() } else { iccid.to_string() }
}

/// 환경변수에서 적절한 인증 토큰을 얻는다.
async fn resolve_token(client: &reqwest::Client) -> anyhow::Result<String> {
    if let (Ok(cid), Ok(csec)) = (std::env::var("ONCE_API_CLIENT_ID"), std::env::var("ONCE_API_CLIENT_SECRET")) {
        if !cid.is_empty() && !csec.is_empty() {
            return obtain_token(client, &cid, &csec).await;
        }
    }
    if let Ok(t) = std::env::var("ONCE_API_TOKEN") {
        if !t.is_empty() { return Ok(t); }
    }
    anyhow::bail!("no 1NCE credentials configured (set ONCE_API_TOKEN or ONCE_API_CLIENT_ID/SECRET)")
}

/// SIM 데이터 충전(top-up) — 1NCE Management API 의 표준 endpoint.
///
/// 정확한 명세 (1NCE OpenAPI sim-management.json):
///   POST /v1/sims/{iccid}/topup?payment_method=<method>
///   Body: 없음
///   Success: 201 Created, Location 헤더 = 새 order URL
///   Amount: 호출자 지정 불가 — 그 SIM 의 plan 에 정의된 표준 1회 top-up 분량.
///           우리 UI 의 "500MB" 라벨은 사용자 안내 용도일 뿐 (실제 양은 plan 결정).
///
/// `mb` 파라미터는 우리 audit log 와 사용자 표시용으로만 보존 (실제 호출에 안 들어감).
/// 결제 방식: ONCE_REFILL_PAYMENT_METHOD env 로 변경 가능
/// (default = banktransfer; options = banktransfer | creditcard | monthlyinvoice | boleto).
pub async fn refill_sim(iccid: &str, mb: i32) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;

    let token = resolve_token(&client).await?;
    let id = normalize_iccid(iccid);

    let payment_method = std::env::var("ONCE_REFILL_PAYMENT_METHOD")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "banktransfer".to_string());

    let url = format!("{BASE_URL}/sims/{id}/topup?payment_method={payment_method}");
    tracing::info!(iccid = id, mb, %url, "1nce topup: POST");

    let res = client.post(&url)
        .bearer_auth(&token)
        .send().await?;

    let status = res.status();
    let location = res.headers()
        .get("Location")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let allow = res.headers()
        .get("Allow")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let resp_body = res.text().await.unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&resp_body).ok();

    Ok(json!({
        "status":      status.as_u16(),
        "ok":          status.is_success(),
        "iccid":       id,
        "endpoint":    url,
        "payment_method": payment_method,
        "mb_label":    mb,
        "order_url":   location,
        "allow_header": allow,
        "response":    parsed.unwrap_or(Value::String(resp_body)),
    }))
}

// ─── 캐시 워커 ────────────────────────────────────────────
// 페어링된 모든 device.iccid 를 30분 주기로 갱신.
// 한 번에 하나씩 (1NCE rate limit 보호 — bizmsg 와 별개지만 보수적).
//
// 우선순위:
//   1) sim_info_fetched_at IS NULL (한 번도 안 가져온 디바이스)
//   2) 가장 오래된 fetched_at
const CACHE_REFRESH_INTERVAL: Duration = Duration::from_secs(30 * 60);
const CACHE_PER_DEVICE_DELAY: Duration = Duration::from_millis(500);   // rate limit 완화

pub fn spawn_cache_worker(pool: sqlx::PgPool) {
    tokio::spawn(async move {
        tracing::info!("nce cache worker: started (refresh every 30min)");
        // 처음 한 번 즉시 실행, 그 다음 30분 주기
        loop {
            if let Err(e) = refresh_all(&pool).await {
                tracing::warn!("nce cache worker error: {e:#}");
            }
            tokio::time::sleep(CACHE_REFRESH_INTERVAL).await;
        }
    });
}

async fn refresh_all(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    // 자격증명 미설정이면 통째로 스킵
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    if resolve_token(&client).await.is_err() {
        tracing::debug!("nce cache: credentials missing — skip cycle");
        return Ok(());
    }

    let targets: Vec<(i64, String)> = sqlx::query_as(
        r#"SELECT id, iccid FROM devices
            WHERE iccid IS NOT NULL AND iccid <> ''
              AND owner_id IS NOT NULL
            ORDER BY sim_info_fetched_at NULLS FIRST
            LIMIT 100"#,
    )
    .fetch_all(pool).await?;

    for (device_id, iccid) in targets {
        match fetch_sim_usage(&iccid, "", "").await {
            Ok(v) => {
                let _ = sqlx::query(
                    r#"UPDATE devices
                          SET sim_info_cache      = $2,
                              sim_info_fetched_at = NOW(),
                              sim_info_error      = NULL
                        WHERE id = $1"#,
                )
                .bind(device_id).bind(v)
                .execute(pool).await;
                tracing::debug!(device_id, "nce cache refreshed");
            }
            Err(e) => {
                let msg = format!("{e:#}");
                let _ = sqlx::query(
                    r#"UPDATE devices
                          SET sim_info_fetched_at = NOW(),
                              sim_info_error      = $2
                        WHERE id = $1"#,
                )
                .bind(device_id).bind(&msg)
                .execute(pool).await;
                tracing::warn!(device_id, %iccid, "nce cache fetch failed: {msg}");
            }
        }
        tokio::time::sleep(CACHE_PER_DEVICE_DELAY).await;
    }
    Ok(())
}

/// 1NCE 주문(order) 상세 + 영수증(invoice) 메타 조회.
///
/// `GET /v1/orders/{order_id}` — 우리가 topup 응답에서 받은 order_url 의 핵심 id.
///   응답: order_number, order_type ("TOPUP"), order_date, invoice_number, invoice_amount,
///         currency, sims[{iccid, _links[]}]
///
/// Invoice PDF 자체는 1NCE 가 AWS SigV4 인증 별도 요구해서 Bearer 토큰으로 안 됨 → 못 가져옴.
/// 대신 invoice_number 만 표시. Admin 이 1NCE 포털에서 그 번호로 검색해 PDF 받음.
pub async fn fetch_order(order_id: &str) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let token = resolve_token(&client).await?;
    let url = format!("{BASE_URL}/orders/{order_id}");
    let res = client.get(&url).bearer_auth(&token).send().await?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("1NCE order {status}: {body}");
    }
    Ok(res.json().await?)
}

/// topup 응답의 `order_url` 에서 마지막 path segment (= order id) 만 추출.
pub fn extract_order_id(order_url: &str) -> Option<String> {
    order_url.rsplit('/').next().filter(|s| !s.is_empty()).map(|s| s.to_string())
}

pub async fn fetch_sim_usage(iccid: &str, _client_id: &str, _client_secret: &str) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;

    let token = resolve_token(&client).await?;
    let id = normalize_iccid(iccid);

    // 먼저 SIM 상세 — activation_date 가져와 usage 의 start_dt 로 사용.
    let url = format!("{BASE_URL}/sims/{id}");
    let info: Value = client.get(&url)
        .bearer_auth(&token)
        .send().await?
        .error_for_status()?
        .json().await?;

    // SIM 사용량 — start_dt 명시 안 하면 오늘만 반환되어 "TOTAL" 도 오늘값.
    // 콘솔처럼 활성화 이후 누적이 필요. activation_date 의 yyyy-mm-dd 부분 사용.
    let start_dt = info.get("activation_date")
        .and_then(|v| v.as_str())
        .and_then(|s| s.split('T').next())
        .unwrap_or("2020-01-01");
    let url = format!("{BASE_URL}/sims/{id}/usage?start_dt={start_dt}");
    let res = client.get(&url)
        .bearer_auth(&token)
        .send().await?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("1NCE usage {status}: {body}");
    }
    let usage: Value = res.json().await?;

    Ok(json!({
        "iccid": id,
        "iccid_full": iccid,
        "configured": true,
        "info": info,
        "usage": usage,
    }))
}
