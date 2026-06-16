// 카카오 알림톡 발송 — bizmsg.kr 통한 템플릿 메시지.
//
// seriallink 프로젝트의 kakaoAlimtalk.ts 와 동일 포맷 (apiUrl / userid / profile).
// 차이: tmplId 가 GPS_MEMBER_SIGNUP 등 GPS 트래커 전용 템플릿코드 사용.
//
// 중요: Bizm 템플릿은 등록 시점의 본문/버튼/강조유형이 모두 매칭되어야 발송 성공.
// 임의 값 (다른 변수명, 다른 버튼 url, 다른 본문 줄) 넣으면 매칭 실패 → 알림톡 안 가고
// SMS 폴백되거나 그냥 실패. 본 함수는 승인된 템플릿 그대로 채움.
//
// ENV:
//   BIZMSG_USERID    (default "etcom262")
//   BIZMSG_PROFILE   (default "40d675c2..." — sms.rs 와 동일 default)
//   BIZMSG_SMS_SENDER(default "01022957774")
//   SMS_DEV_MODE     "1" 이면 실제 발송 안 하고 로그만

use serde_json::{json, Value};
use std::time::Duration;

const API_URL: &str = "https://alimtalk-api.bizmsg.kr/v2/sender/send";
const DEFAULT_USERID: &str  = "etcom262";
const DEFAULT_PROFILE: &str = "40d675c26afbef411fddcd688c88f575668f8651";
const DEFAULT_SENDER: &str  = "01022957774";

/// 회원가입 환영 알림톡 — 비즈엠 승인 템플릿 GPS_MEMBER_SIGNUP.
///
/// 본문 (등록된 그대로):
///   시리얼링크 회원가입을 환영합니다!
///
///   안녕하세요, #{이름}님.
///   회원가입이 정상 완료되었습니다.
///
///   단말기를 등록하고 위치추적 서비스를 시작해 보세요.
///
/// 광고성: "채널 추가하고 이 채널의 마케팅 메시지 등을 카카오톡으로 받기"
/// 강조유형: 선택안함
/// 버튼1: 채널추가형 (name="채널 추가", type=AC)
/// 버튼2: 웹링크    (name="단말기 등록하기", url_mobile=url_pc=https://gps.serial.kr/devices/pair)
pub async fn send_signup_welcome(phone: &str, display_name: &str) -> anyhow::Result<()> {
    // 본문 — 승인된 템플릿 그대로. #{이름} 자리만 치환.
    let message = format!(
        "시리얼링크 회원가입을 환영합니다!\n\n\
         안녕하세요, {}님.\n\
         회원가입이 정상 완료되었습니다.\n\n\
         단말기를 등록하고 위치추적 서비스를 시작해 보세요.",
        display_name,
    );

    // SMS 폴백 — 알림톡 발송 실패 시 LMS 로 재발송. 본문 그대로.
    let sms_title = "[시리얼링크] 회원가입 환영";

    // 버튼 — 등록된 정의 그대로. 임의 값 넣으면 템플릿 매칭 실패.
    let button1 = json!({
        "name": "채널 추가",
        "type": "AC",
    });
    let button2 = json!({
        "name":       "단말기 등록하기",
        "type":       "WL",
        "url_mobile": "https://gps.serial.kr/devices/pair",
        "url_pc":     "https://gps.serial.kr/devices/pair",
    });

    send_template(SendArgs {
        phone,
        tmpl_id: "GPS_MEMBER_SIGNUP",
        message: &message,
        sms_title,
        buttons: vec![button1, button2],
    }).await
}

struct SendArgs<'a> {
    phone:     &'a str,
    tmpl_id:   &'a str,
    message:   &'a str,
    sms_title: &'a str,
    buttons:   Vec<Value>,
}

async fn send_template(args: SendArgs<'_>) -> anyhow::Result<()> {
    let dev = std::env::var("SMS_DEV_MODE").ok().as_deref() == Some("1");
    let userid  = std::env::var("BIZMSG_USERID").unwrap_or_else(|_| DEFAULT_USERID.into());
    let profile = std::env::var("BIZMSG_PROFILE").unwrap_or_else(|_| DEFAULT_PROFILE.into());
    let sender  = std::env::var("BIZMSG_SMS_SENDER").unwrap_or_else(|_| DEFAULT_SENDER.into());

    if dev {
        tracing::warn!(phone = args.phone, tmpl = args.tmpl_id,
            "SMS_DEV_MODE=1 — actual alimtalk skipped");
        return Ok(());
    }

    let mut body_obj = serde_json::Map::new();
    body_obj.insert("message_type".into(), json!("at"));
    body_obj.insert("phn".into(),       json!(args.phone));
    body_obj.insert("profile".into(),   json!(profile));
    body_obj.insert("tmplId".into(),    json!(args.tmpl_id));
    body_obj.insert("msg".into(),       json!(args.message));
    body_obj.insert("smsKind".into(),   json!("L"));
    body_obj.insert("msgSms".into(),    json!(args.message));
    body_obj.insert("smsSender".into(), json!(sender));
    body_obj.insert("smsLmsTit".into(), json!(args.sms_title));
    body_obj.insert("reserveDt".into(), json!("00000000000000"));
    // button1, button2, ... 동적 키. Bizm 포맷 그대로.
    for (i, btn) in args.buttons.into_iter().enumerate() {
        body_obj.insert(format!("button{}", i + 1), btn);
    }
    let body = json!([body_obj]);

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
        anyhow::bail!("alimtalk send {status}: {text}");
    }
    if text.contains("success") || text.contains("\"code\":\"7000\"") {
        tracing::info!(phone = args.phone, tmpl = args.tmpl_id, "alimtalk ok");
    } else {
        // 200 응답이지만 본문이 의심스러울 때 — 경고만, 막진 않음 (SMS 폴백이 된 케이스 등)
        tracing::warn!(phone = args.phone, tmpl = args.tmpl_id, ?text,
            "alimtalk returned 200 but body suspicious");
    }
    Ok(())
}
