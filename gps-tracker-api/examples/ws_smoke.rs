// WS 엔드투엔드 스모크 테스트.
// 두 유저/두 디바이스 → user1 으로 WS 연결 → 두 device 모두 subscribe 시도
// → 두 device 모두 ingest → user1 이 owned 이벤트만 받는지 검증.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const HTTP_BASE: &str = "https://seriallog.com/gps-tracker";
const WS_BASE: &str = "wss://seriallog.com/gps-tracker";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let http = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    let ts = chrono::Utc::now().timestamp_millis();
    let email1 = format!("ws-u1-{}@seriallog.test", ts);
    let email2 = format!("ws-u2-{}@seriallog.test", ts);
    let uid_owned = format!("ws-owned-{}", ts);
    let uid_stranger = format!("ws-stranger-{}", ts);
    let pw = "hunter2hunter";

    // 두 유저 register
    let r1: Value = http
        .post(format!("{HTTP_BASE}/api/v1/auth/register"))
        .json(&json!({"email": email1, "password": pw}))
        .send()
        .await?
        .json()
        .await?;
    let r2: Value = http
        .post(format!("{HTTP_BASE}/api/v1/auth/register"))
        .json(&json!({"email": email2, "password": pw}))
        .send()
        .await?
        .json()
        .await?;
    let token1 = r1["access_token"].as_str().unwrap().to_string();
    let token2 = r2["access_token"].as_str().unwrap().to_string();
    let user1_id = r1["user_id"].as_i64().unwrap();
    println!("user1_id={user1_id}");

    // 페어링
    let p1: Value = http
        .post(format!("{HTTP_BASE}/api/v1/devices/pair"))
        .bearer_auth(&token1)
        .json(&json!({"device_uid": uid_owned}))
        .send()
        .await?
        .json()
        .await?;
    let p2: Value = http
        .post(format!("{HTTP_BASE}/api/v1/devices/pair"))
        .bearer_auth(&token2)
        .json(&json!({"device_uid": uid_stranger}))
        .send()
        .await?
        .json()
        .await?;
    let did_owned = p1["id"].as_i64().unwrap();
    let did_stranger = p2["id"].as_i64().unwrap();
    println!("owned={did_owned} stranger={did_stranger}");

    // WS 연결
    let url = format!("{WS_BASE}/ws/realtime?token={token1}");
    let (ws_stream, resp) = connect_async(&url).await?;
    println!("ws upgrade status: {}", resp.status());
    let (mut writer, mut reader) = ws_stream.split();

    // hello
    let hello = next_text(&mut reader).await?;
    println!("hello: {hello}");
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["user_id"], user1_id);

    // subscribe 둘 다 (stranger 는 rejected 되어야)
    writer
        .send(Message::Text(
            json!({
                "action":"subscribe",
                "device_ids":[did_owned, did_stranger]
            })
            .to_string(),
        ))
        .await?;

    let ack = next_text(&mut reader).await?;
    println!("ack: {ack}");
    assert_eq!(ack["type"], "ack");
    let accepted: Vec<i64> = ack["accepted"].as_array().unwrap().iter()
        .filter_map(|v| v.as_i64()).collect();
    let rejected: Vec<i64> = ack["rejected"].as_array().unwrap().iter()
        .filter_map(|v| v.as_i64()).collect();
    assert!(accepted.contains(&did_owned), "owned should be accepted");
    assert!(rejected.contains(&did_stranger), "stranger should be rejected");

    // 양쪽 디바이스에 ingest
    for uid in [&uid_owned, &uid_stranger] {
        http.post(format!("{HTTP_BASE}/ingest"))
            .json(&json!({
                "ts":1,"csq":24,"reg":5,"vbat_mv":3970,
                "device_uid": uid,
                "l80": {"fix":true,"lat":35.949,"lng":127.009,"sat":8,"ttff_s":5}
            }))
            .send()
            .await?;
    }

    // 1.5초 안에 들어오는 모든 메시지 수집
    let mut received: Vec<Value> = vec![];
    loop {
        match timeout(Duration::from_millis(1500), reader.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                received.push(serde_json::from_str(&t)?);
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => return Err(e.into()),
            Err(_) => break, // timeout
        }
    }
    println!("received {} events:", received.len());
    for ev in &received {
        println!("  {}", ev);
    }
    assert!(!received.is_empty(), "no events received");
    assert!(
        received.iter().all(|ev| ev["type"] == "location"),
        "non-location event leaked"
    );
    assert!(
        received.iter().all(|ev| ev["device_id"] == did_owned),
        "stranger event leaked!"
    );
    println!("OK");
    Ok(())
}

async fn next_text<S>(reader: &mut S) -> Result<Value, Box<dyn std::error::Error>>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(msg) = reader.next().await {
        let msg = msg?;
        if let Message::Text(t) = msg {
            return Ok(serde_json::from_str(&t)?);
        }
    }
    Err("stream closed".into())
}
