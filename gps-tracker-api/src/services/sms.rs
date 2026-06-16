// bizmsg.kr 의 AlimTalk/SMS API — 4자리 OTP 발송.
//
// seriallink 프로젝트와 동일 엔드포인트/포맷 사용.
// smsOnly="Y" 로 강제 SMS 분기 (AlimTalk 템플릿 매칭 실패 시도 그냥 SMS 로).
//
// ENV:
//   BIZMSG_USERID      (default "etcom262")
//   BIZMSG_PROFILE     (default "40d675c2..." — 사용자가 설정한 profile key)
//   BIZMSG_SMS_SENDER  (default "01022957774")
//   SMS_DEV_MODE       "1" 이면 실제 발송 안 하고 로그에만 — 개발/테스트용

use serde_json::json;
use std::time::Duration;

const API_URL: &str = "https://alimtalk-api.bizmsg.kr/v2/sender/send";
const DEFAULT_USERID: &str  = "etcom262";
const DEFAULT_PROFILE: &str = "40d675c26afbef411fddcd688c88f575668f8651";
const DEFAULT_SENDER: &str  = "01022957774";

pub async fn send_otp(phone: &str, code: &str) -> anyhow::Result<()> {
    let dev = std::env::var("SMS_DEV_MODE").ok().as_deref() == Some("1");
    let userid  = std::env::var("BIZMSG_USERID").unwrap_or_else(|_| DEFAULT_USERID.into());
    let profile = std::env::var("BIZMSG_PROFILE").unwrap_or_else(|_| DEFAULT_PROFILE.into());
    let sender  = std::env::var("BIZMSG_SMS_SENDER").unwrap_or_else(|_| DEFAULT_SENDER.into());

    let message = format!("[Seriallog GPS] 인증번호 {} 을(를) 입력해주세요.", code);

    if dev {
        tracing::warn!(phone, code, "SMS_DEV_MODE=1 — actual SMS skipped, code in log");
        return Ok(());
    }

    let body = serde_json::json!([{
        "phn":       phone,
        "profile":   profile,
        "reserveDt": "00000000000000",
        "smsOnly":   "Y",
        "smsKind":   "S",
        "msgSms":    message,
        "smsSender": sender,
    }]);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    let res = client.post(API_URL)
        .header("Content-Type", "application/json")
        .header("userid", userid)
        .json(&body)
        .send().await?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("bizmsg send {status}: {text}");
    }
    // bizmsg 는 200 이어도 body 안의 result 필드로 실패를 알리는 경우 있음.
    // 일단 200 = 성공으로 간주, 의심스러운 경우 본문 로그.
    if !text.contains("success") && !text.contains("\"code\":\"7000\"") {
        // 엄격하게 막진 않고 경고만
        tracing::warn!(?text, "bizmsg returned 200 but body suspicious");
    } else {
        tracing::info!(phone, "bizmsg sms ok");
    }
    let _ = json!(text);   // 미사용 import 회피용
    Ok(())
}

/// 한국 휴대폰 정규화 — 010XXXXXXXX 또는 010-XXXX-XXXX → 010XXXXXXXX
/// 유효하지 않으면 None.
pub fn normalize_phone(s: &str) -> Option<String> {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() == 10 || digits.len() == 11 {
        if digits.starts_with("010") || digits.starts_with("011")
        || digits.starts_with("016") || digits.starts_with("017")
        || digits.starts_with("018") || digits.starts_with("019") {
            return Some(digits);
        }
    }
    None
}

/// 4자리 OTP 생성 (1000~9999)
pub fn generate_code() -> String {
    use rand::Rng;
    let n: u32 = rand::thread_rng().gen_range(1000..=9999);
    format!("{:04}", n)
}
