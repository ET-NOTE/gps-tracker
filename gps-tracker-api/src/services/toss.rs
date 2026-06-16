// Toss Payments REST 래퍼.
//
// 현재는 confirm 만 사용. cancel/inquiry 는 추후 환불 기능 시 추가.
//
// 인증: HTTP Basic. user = SECRET_KEY, password = "" (빈 값).
//   Authorization: Basic base64(secret_key + ":")
//
// ENV:
//   TOSS_CLIENT_KEY  (frontend 가 받음)
//   TOSS_SECRET_KEY  (backend 만 사용)
//
// 테스트 키: test_ck_/test_sk_ prefix. 라이브 키: live_ck_/live_sk_.

use base64::Engine;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

const CONFIRM_URL: &str = "https://api.tosspayments.com/v1/payments/confirm";

pub fn client_key() -> Option<String> {
    std::env::var("TOSS_CLIENT_KEY").ok().filter(|s| !s.is_empty())
}

fn secret_key() -> anyhow::Result<String> {
    std::env::var("TOSS_SECRET_KEY")
        .ok().filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("TOSS_SECRET_KEY not configured"))
}

fn auth_header() -> anyhow::Result<String> {
    let sk = secret_key()?;
    let raw = format!("{sk}:");
    let enc = base64::engine::general_purpose::STANDARD.encode(raw);
    Ok(format!("Basic {enc}"))
}

/// 결제 confirm — Toss 가 successUrl 로 redirect 했을 때 우리가 직접 호출.
/// 성공 시 결제 완료. 실패 시 anyhow::Error 로 사유 포함.
pub async fn confirm_payment(
    payment_key: &str,
    order_id: &str,
    amount: i64,
) -> anyhow::Result<Value> {
    let auth = auth_header()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;

    let body = json!({
        "paymentKey": payment_key,
        "orderId":    order_id,
        "amount":     amount,
    });

    let res = client.post(CONFIRM_URL)
        .header("Authorization", &auth)
        .header("Content-Type",  "application/json")
        .json(&body)
        .send().await?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));

    if status.is_success() {
        Ok(parsed)
    } else {
        let msg = parsed.get("message")
            .and_then(|v| v.as_str())
            .unwrap_or(&text)
            .to_string();
        anyhow::bail!("toss confirm {status}: {msg}")
    }
}
