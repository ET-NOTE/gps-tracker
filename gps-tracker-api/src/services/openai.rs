// OpenAI Chat Completions wrapper — 라우트 분석 전용 (가벼운 호출).
// 환경변수 OPENAI_API_KEY 필요. 모델 OPENAI_MODEL (기본 gpt-4o-mini).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const URL: &str = "https://api.openai.com/v1/chat/completions";

#[derive(Debug, Serialize)]
pub struct ChatMessage<'a> {
    pub role: &'a str, // "system" | "user"
    pub content: &'a str,
}

#[derive(Debug, Deserialize)]
struct ChatResp {
    choices: Vec<Choice>,
    usage: Option<Usage>,
    model: Option<String>,
}
#[derive(Debug, Deserialize)]
struct Choice {
    message: Msg,
    finish_reason: String,
}
#[derive(Debug, Deserialize)]
struct Msg {
    content: Option<String>,
    refusal: Option<String>,
}
#[derive(Debug, Deserialize)]
struct Usage {
    prompt_tokens: i32,
    completion_tokens: i32,
}

pub struct ChatResult {
    pub text: String,
    pub tokens_in: Option<i32>,
    pub tokens_out: Option<i32>,
    pub model: Option<String>,
}

pub async fn chat(messages: &[ChatMessage<'_>], max_tokens: u32) -> anyhow::Result<ChatResult> {
    let key = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("OPENAI_API_KEY not configured"))?;
    let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
    // A day's movement summary leaves for the AI service here.
    super::access_ledger::sent_to("openai", "analysis");

    let body = json!({
        "model": model,
        "messages": messages.iter().map(|m| json!({
            "role": m.role, "content": m.content,
        })).collect::<Vec<_>>(),
        "max_tokens": max_tokens,
        "temperature": 0.4,
    });

    // OpenAI 응답이 prompt 길이/모델 부하에 따라 30초 넘는 경우 종종 발생.
    // 90초로 잡아 timeout 으로 인한 환불-재시도 사이클 줄임.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()?;

    let res = client
        .post(URL)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        anyhow::bail!("openai HTTP {status}");
    }
    let parsed: ChatResp = res.json().await?;
    checked_result(parsed)
}

fn checked_result(parsed: ChatResp) -> anyhow::Result<ChatResult> {
    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("openai returned no choice"))?;
    anyhow::ensure!(
        choice.finish_reason == "stop",
        "openai did not complete: {}",
        choice.finish_reason
    );
    anyhow::ensure!(
        choice.message.refusal.as_deref().unwrap_or("").is_empty(),
        "openai declined analysis"
    );
    let text = choice.message.content.unwrap_or_default().trim().to_owned();
    anyhow::ensure!(!text.is_empty(), "openai returned empty analysis");
    Ok(ChatResult {
        text,
        tokens_in: parsed.usage.as_ref().map(|u| u.prompt_tokens),
        tokens_out: parsed.usage.as_ref().map(|u| u.completion_tokens),
        model: parsed.model,
    })
}

// 디버그용 raw 호출 (현재는 미사용 — 향후 streaming 대비)
#[allow(dead_code)]
pub fn raw_url() -> &'static str {
    URL
}

#[allow(dead_code)]
pub fn dummy_value() -> Value {
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_or_empty_reports_are_not_billable() {
        for (finish, content, refusal) in [
            ("length", "partial", None),
            ("stop", "  ", None),
            ("content_filter", "partial", None),
            ("stop", "text", Some("declined")),
        ] {
            let response = serde_json::from_value(json!({"choices":[{"finish_reason":finish,
                "message":{"content":content,"refusal":refusal}}]}))
            .unwrap();
            assert!(checked_result(response).is_err());
        }
        assert!(checked_result(serde_json::from_value(json!({"choices":[]})).unwrap()).is_err());
        let result = checked_result(
            serde_json::from_value(json!({"choices":[{"finish_reason":"stop",
            "message":{"content":" 보고서 "}}],"model":"test-model"}))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result.text, "보고서");
    }
}
