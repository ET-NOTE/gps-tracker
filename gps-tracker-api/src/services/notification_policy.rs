use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

pub fn kind<'a>(kind: &'a str, data: Option<&Value>) -> &'a str {
    if kind == "wake"
        && data
            .and_then(|v| v.get("wake_cause"))
            .and_then(Value::as_str)
            == Some("motion")
    {
        "motion"
    } else {
        kind
    }
}

pub fn lifetime(kind: &str) -> i64 {
    match kind {
        "chat_user_message" | "chat_admin_message" => 86400,
        "low_batt" | "brownout" | "gps_anomaly" | "geofence_in" | "geofence_out" => 3600,
        _ => 900,
    }
}

pub fn channel(kind: &str) -> &'static str {
    match kind {
        "low_batt" | "offline" | "brownout" | "geofence_out" | "motion" => "gps_alerts_v1",
        "chat_user_message" | "chat_admin_message" => "gps_messages_v1",
        _ => "gps_updates_v1",
    }
}

pub fn compact(text: &str, limit: usize) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= limit {
        return clean;
    }
    clean
        .chars()
        .take(limit.saturating_sub(1))
        .chain(std::iter::once('…'))
        .collect()
}

pub fn message(title: &str, body: &str, mut data: Value, at: DateTime<Utc>) -> Value {
    let kind = data["kind"].as_str().unwrap_or("").to_owned();
    let channel = channel(&kind);
    let category = match kind.as_str() {
        "signal_loss" | "offline" | "online" => "connection",
        "sleep_enter" | "wake" | "motion" | "cycle_first_fix" => "activity",
        other => other,
    };
    let tag = if let Some(device) = data["device_id"].as_str() {
        format!("device-{device}-{category}")
    } else if let Some(thread) = data["thread_id"].as_str() {
        format!("chat-{thread}")
    } else {
        format!("event-{}", at.timestamp_millis())
    };
    data["notification_channel"] = json!(channel);
    data["notification_tag"] = json!(tag);
    data["occurred_at"] = json!(at.to_rfc3339());
    data["expires_at"] = json!((at + chrono::Duration::seconds(lifetime(&kind))).to_rfc3339());
    let stamp = at
        .with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap())
        .format("%m.%d %H:%M")
        .to_string();
    json!({"notification":{"title":compact(title,64),"body":format!("{} · {stamp}",compact(body,180))},
        "data":data,
        "android":{"priority":if channel == "gps_updates_v1" {"NORMAL"} else {"HIGH"},
            "ttl":format!("{}s",lifetime(&kind)),
            "notification":{"channel_id":channel,"icon":"ic_stat_notification","tag":tag,
                "event_time":at.to_rfc3339(),"visibility":"PRIVATE",
                "notification_priority":if channel == "gps_alerts_v1" {"PRIORITY_HIGH"} else if channel == "gps_updates_v1" {"PRIORITY_LOW"} else {"PRIORITY_DEFAULT"},
                "default_sound":channel != "gps_updates_v1","default_vibrate_timings":channel != "gps_updates_v1"}}})
}

/// Re-evaluated at enqueue and immediately before every send, including retries.
/// Diagnostic events remain in the database but are never a generic push fallback.
pub async fn relevant(pool: &PgPool, event: i64) -> anyhow::Result<bool> {
    Ok(
        sqlx::query_scalar(include_str!("notification_relevance.sql"))
            .bind(event)
            .fetch_one(pool)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn truthful_kind_channels_and_bounded_unicode_preview() {
        assert_eq!(
            kind("wake", Some(&json!({"wake_cause":"motion"}))),
            "motion"
        );
        assert_eq!(kind("wake", Some(&json!({"wake_cause":"boot"}))), "wake");
        assert_ne!(channel("online"), channel("offline"));
        assert_ne!(channel("chat_admin_message"), channel("offline"));
        let at = DateTime::parse_from_rfc3339("2026-09-28T03:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let n = message(
            "  내 차 \n 연결 확인 필요 ",
            &"한".repeat(240),
            json!({"kind":"offline","device_id":"1"}),
            at,
        );
        assert_eq!(n["notification"]["title"], "내 차 연결 확인 필요");
        assert!(n["notification"]["body"]
            .as_str()
            .unwrap()
            .ends_with("… · 09.28 12:00"));
        assert_eq!(n["android"]["ttl"], "900s");
        assert_eq!(n["data"]["notification_tag"], "device-1-connection");
    }
}
