//! One durable receipt per owner, device, stage and last received heartbeat.
//! A worker restart, elapsed day or event-history deletion cannot re-arm it.
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::{FromRow, PgPool};

#[derive(FromRow)]
struct SilentDevice {
    id: i64,
    owner_id: i64,
    last_seen_at: DateTime<Utc>,
    silence_min: i64,
    signal_min: i32,
    offline_min: i32,
    sleeping: bool,
    sleep_at: Option<DateTime<Utc>>,
}

pub async fn scan(pool: &PgPool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    // Device locks serialize heartbeat/ownership changes with event creation.
    // Multiple workers skip each other's candidates rather than creating duplicates.
    let candidates: Vec<SilentDevice> = sqlx::query_as(
        r#"SELECT d.id,d.owner_id,d.last_seen_at,
           floor(extract(epoch FROM (now()-d.last_seen_at))/60)::bigint AS silence_min,
           COALESCE(ns.signal_loss_minutes,5) AS signal_min,
           COALESCE(ns.offline_minutes,1440) AS offline_min,
           COALESCE(life.kind='sleep_enter',false) AS sleeping,
           life.occurred_at AS sleep_at
         FROM devices d JOIN users u ON u.id=d.owner_id
         LEFT JOIN notification_settings ns ON ns.user_id=d.owner_id
         LEFT JOIN LATERAL (
           SELECT kind,occurred_at FROM events
           WHERE device_id=d.id AND user_id=d.owner_id AND kind IN ('sleep_enter','wake')
           ORDER BY occurred_at DESC,id DESC LIMIT 1
         ) life ON true
         WHERE d.last_seen_at <= now()-interval '1 minute'
         ORDER BY d.id FOR UPDATE OF d SKIP LOCKED"#,
    )
    .fetch_all(&mut *tx)
    .await?;

    for device in candidates {
        let mut stages = Vec::with_capacity(2);
        if device.sleeping {
            if device.silence_min >= 1440
                && device
                    .sleep_at
                    .is_some_and(|at| (Utc::now() - at).num_hours() >= 24)
            {
                stages.push("lost");
            }
        } else {
            stages.push("stuck"); // Internal diagnostic only; not an FCM notification.
            if device.silence_min >= i64::from(device.offline_min) {
                stages.push("offline");
            } else if device.silence_min >= i64::from(device.signal_min) {
                stages.push("signal_loss");
            }
        }
        for kind in stages {
            let claimed = sqlx::query(
                r#"INSERT INTO connection_alert_episodes(device_id,user_id,kind,last_seen_at)
                   VALUES($1,$2,$3,$4)
                   ON CONFLICT(device_id,user_id,kind) DO UPDATE
                   SET last_seen_at=EXCLUDED.last_seen_at,event_id=NULL
                   WHERE connection_alert_episodes.last_seen_at < EXCLUDED.last_seen_at"#,
            )
            .bind(device.id)
            .bind(device.owner_id)
            .bind(kind)
            .bind(device.last_seen_at)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if claimed == 0 {
                continue;
            }
            let data = json!({
                "silence_min": device.silence_min,
                "last_seen_at": device.last_seen_at,
                "reason": "no_data_received",
                "sleep_at": if device.sleeping {device.sleep_at} else {None},
                "hours_since_sleep": device.sleep_at.map(|at| (Utc::now()-at).num_hours()),
            });
            let event: i64 = sqlx::query_scalar(
                "INSERT INTO events(device_id,user_id,kind,occurred_at,data) VALUES($1,$2,$3,now(),$4) RETURNING id",
            ).bind(device.id).bind(device.owner_id).bind(kind).bind(data)
             .fetch_one(&mut *tx).await?;
            sqlx::query("UPDATE connection_alert_episodes SET event_id=$4 WHERE device_id=$1 AND user_id=$2 AND kind=$3")
                .bind(device.id).bind(device.owner_id).bind(kind).bind(event)
                .execute(&mut *tx).await?;
            tracing::info!(
                device_id = device.id,
                kind,
                "connection episode recorded once"
            );
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
pub async fn check_episode_lifecycle(pool: &PgPool) {
    // Called only by the disposable PostgreSQL/fake-FCM integration test.
    sqlx::raw_sql("UPDATE notification_settings SET offline_minutes=1440,signal_loss_minutes=5,offline_alert=true; INSERT INTO devices(id,owner_id,last_seen_at) VALUES(2,1,now()-interval '23 hours'),(3,2,now()-interval '25 hours')")
        .execute(pool).await.unwrap();
    scan(pool).await.unwrap();
    let count = |device: i64| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM events WHERE device_id=$1 AND kind='offline'",
        )
        .bind(device)
        .fetch_one(pool)
        .await
        .unwrap()
    };
    assert_eq!(count(2).await, 0, "default must wait for 24 hours");
    assert_eq!(count(3).await, 1, "missing preferences use 24 hours too");
    sqlx::query("UPDATE devices SET last_seen_at=now()-interval '25 hours' WHERE id=2")
        .execute(pool)
        .await
        .unwrap();
    let (a, b) = tokio::join!(scan(pool), scan(pool));
    a.unwrap();
    b.unwrap();
    assert_eq!(
        count(2).await,
        1,
        "concurrent workers claim the same episode once"
    );
    let event: i64 =
        sqlx::query_scalar("SELECT id FROM events WHERE device_id=2 AND kind='offline'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert!(super::notification_policy::relevant(pool, event)
        .await
        .unwrap());
    let duplicate: i64 = sqlx::query_scalar(
        "INSERT INTO events(device_id,user_id,kind) VALUES(2,1,'offline') RETURNING id",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(!super::notification_policy::relevant(pool, duplicate)
        .await
        .unwrap());
    sqlx::query("DELETE FROM events WHERE id=$1")
        .bind(duplicate)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE events SET occurred_at=now()-interval '30 days' WHERE device_id=2")
        .execute(pool)
        .await
        .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(count(2).await, 1, "receipt outlives a daily dedup window");
    sqlx::query("DELETE FROM events WHERE device_id=2")
        .execute(pool)
        .await
        .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(
        count(2).await,
        0,
        "clearing history does not re-arm an outage"
    );
    sqlx::query("INSERT INTO events(device_id,user_id,kind) VALUES(2,1,'online')")
        .execute(pool)
        .await
        .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(
        count(2).await,
        0,
        "synthetic online event is not a heartbeat"
    );
    sqlx::query("UPDATE devices SET last_seen_at=now() WHERE id=2")
        .execute(pool)
        .await
        .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(count(2).await, 0);
    sqlx::query("UPDATE devices SET last_seen_at=now()-interval '25 hours' WHERE id=2")
        .execute(pool)
        .await
        .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(
        count(2).await,
        1,
        "new received heartbeat re-arms a later outage"
    );
    sqlx::query("UPDATE devices SET owner_id=1 WHERE id=3")
        .execute(pool)
        .await
        .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(
        count(3).await,
        2,
        "previous owner's receipt cannot suppress a new owner"
    );
    sqlx::raw_sql(r#"
        INSERT INTO devices(id,owner_id,last_seen_at) VALUES(4,1,now()-interval '25 hours');
        CREATE FUNCTION reject_connection_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.device_id=4 AND NEW.kind='offline' THEN RAISE EXCEPTION 'rollback test'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_connection BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_connection_test();
    "#).execute(pool).await.unwrap();
    assert!(scan(pool).await.is_err());
    let claimed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM connection_alert_episodes WHERE device_id=4")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(claimed, 0, "event failure must roll back its receipt");
    sqlx::query("DROP TRIGGER reject_connection ON events")
        .execute(pool)
        .await
        .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(count(4).await, 1);
    sqlx::raw_sql(
        r#"
        INSERT INTO devices(id,owner_id,last_seen_at) VALUES(5,1,now()-interval '25 hours');
        INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES
            (5,1,'sleep_enter',now()-interval '25 hours'),(5,1,'battery_diagnostic',now());
    "#,
    )
    .execute(pool)
    .await
    .unwrap();
    scan(pool).await.unwrap();
    scan(pool).await.unwrap();
    assert_eq!(
        count(5).await,
        0,
        "unrelated events cannot turn sleeping into offline"
    );
    let lost: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE device_id=5 AND kind='lost'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(lost, 1);
    sqlx::query("UPDATE notification_settings SET offline_minutes=360 WHERE user_id=1")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO devices(id,owner_id,last_seen_at) VALUES(6,1,now()-interval '7 hours')",
    )
    .execute(pool)
    .await
    .unwrap();
    scan(pool).await.unwrap();
    assert_eq!(count(6).await, 1, "custom threshold is honored");
}
