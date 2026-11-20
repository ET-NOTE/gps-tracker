use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

fn transport() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os("GPS_FLEET_NOTIFICATION_SENDMAIL")?);
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.metadata().ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path)
}

pub fn mode() -> &'static str {
    match std::env::var("APP_ENV").as_deref() {
        Ok("development" | "test") => "preview",
        _ if transport().is_some() => "sendmail",
        _ => "unavailable",
    }
}

fn label(category: &str) -> &'static str {
    match category {
        "reservation" => "차량 예약",
        "expense" => "지출 처리",
        "trip" => "예약 차량 운행",
        "maintenance" => "점검 일정",
        "connection" => "단말 수신",
        _ => "업무",
    }
}

fn address_ok(address: &str) -> bool {
    address.len() <= 254
        && !address.starts_with('-')
        && address
            .split_once('@')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && !b.contains('@'))
        && address
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~@".contains(&b))
}

// No addresses, locations, vehicle names or submitted documents appear in the body.
async fn deliver(address: &str, category: &str, id: i64) -> anyhow::Result<()> {
    let path = transport().ok_or_else(|| anyhow::anyhow!("mail transport unavailable"))?;
    let subject = STANDARD.encode(format!("[시리얼링크] {} 알림", label(category)));
    let body = STANDARD.encode(format!(
        "새 {} 알림이 있습니다. 시리얼링크 법인차 운영 화면에서 확인해 주세요.",
        label(category)
    ));
    let message=format!("To: {address}\r\nSubject: =?UTF-8?B?{subject}?=\r\nMessage-ID: <fleet-notice-{id}@serial.kr>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{body}\r\n");
    let mut child = Command::new(path)
        .args(["-i", "--", address])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    tokio::time::timeout(Duration::from_secs(6), async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("mail input unavailable"))?;
        stdin.write_all(message.as_bytes()).await?;
        drop(stdin);
        anyhow::ensure!(child.wait().await?.success(), "mail submission failed");
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}

async fn scheduled(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query(r#"INSERT INTO fleet_notification_mail(owner_id,recipient_id,category,source_key,vehicle_id)
        SELECT v.owner_id,v.owner_id,'maintenance','schedule-'||v.id||'-'||d.key||'-'||d.due,v.id
        FROM fleet_notification_policy p JOIN fleet_vehicles v ON v.owner_id=p.owner_id
        CROSS JOIN LATERAL (VALUES ('service',v.profile->>'next_service_date'),('insurance',v.profile->>'insurance_expiry'),
                                  ('inspection',v.profile->>'inspection_expiry')) d(key,due)
        WHERE v.enabled AND (p.settings->>'email')::boolean AND coalesce((p.settings->>'maintenance')::boolean,true)
          AND d.due BETWEEN to_char(now() AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD')
                        AND to_char((now() AT TIME ZONE 'Asia/Seoul')+interval '30 days','YYYY-MM-DD')
        ON CONFLICT(owner_id,recipient_id,category,source_key) DO NOTHING"#).execute(pool).await?;
    sqlx::query("DELETE FROM fleet_notification_mail WHERE created_at<now()-interval '45 days'")
        .execute(pool)
        .await?;
    Ok(())
}

async fn next(pool: &PgPool, mode: &str) -> anyhow::Result<bool> {
    let Some((id,owner))=sqlx::query_as::<_,(i64,i64)>("SELECT id,owner_id FROM fleet_notification_mail WHERE finished_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT 1")
        .fetch_optional(pool).await? else {return Ok(false)};
    let mut tx = pool.begin().await?;
    // Match the policy editor's lock order. A successful opt-out never races
    // a later send using an old copy of the preferences.
    sqlx::query("SELECT owner_id FROM fleet_notification_policy WHERE owner_id=$1 FOR SHARE")
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((category, address, eligible)) =
        sqlx::query_as::<_, (String, String, bool)>(include_str!("fleet_mail_delivery.sql"))
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
    else {
        return Ok(true);
    };
    let eligible = eligible && address_ok(&address);
    let preview = eligible && mode == "preview";
    if !eligible || preview || deliver(&address, &category, id).await.is_ok() {
        sqlx::query("UPDATE fleet_notification_mail SET finished_at=now(),preview=$2 WHERE id=$1")
            .bind(id)
            .bind(preview)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE fleet_notification_mail SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute'*least(60,1<<least(attempts,6)) WHERE id=$1")
            .bind(id).execute(&mut *tx).await?;
        tracing::warn!(notice_id = id, "fleet notification mail will retry");
    }
    tx.commit().await?;
    Ok(true)
}

pub fn spawn(pool: PgPool) {
    let mode = mode();
    if mode == "unavailable" {
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut sweep = std::time::Instant::now();
        loop {
            ticker.tick().await;
            if std::time::Instant::now() >= sweep {
                if let Err(err) = scheduled(&pool).await {
                    tracing::warn!(%err,"fleet notification schedule");
                }
                sweep = std::time::Instant::now() + Duration::from_secs(600);
            }
            for _ in 0..32 {
                match next(&pool, mode).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(err) => {
                        tracing::warn!(%err,"fleet notification delivery");
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn header_or_recipient_injection_is_rejected() {
        assert!(address_ok("fleet+review@example.org"));
        for input in [
            "-o@example.org",
            "ok@example.org\r\nBcc: other@example.org",
            "a@b@c",
            "a,b@example.org",
            "",
        ] {
            assert!(!address_ok(input));
        }
    }
}
