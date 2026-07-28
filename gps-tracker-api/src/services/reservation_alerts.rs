// (2026-07-28) Stage-4H-1: 예약 임박 알림 워커.
//
// 매 5분 주기:
//   1. SELECT vehicle_reservations WHERE status='planned' AND alerted_at IS NULL
//        AND starts_at BETWEEN NOW() AND NOW() + '30 min'
//   2. 각각 events(kind='reservation_starting', device_id, user_id, data) INSERT
//   3. UPDATE alerted_at = NOW()
//
// 기존 FCM 워커 (services/fcm.rs) 가 notified_at IS NULL 인 event 를 5초마다 폴링해
// notification_settings 기준으로 push. 이 워커는 이벤트만 생성하고 종료.
//
// event.data JSONB payload (FCM template 이 참조):
//   { "type": "reservation_starting",
//     "reservation_id": 123,
//     "device_id": 45,
//     "device_name": "소나타",
//     "license_plate": "12가3456",
//     "starts_at": "2026-07-28T10:00:00Z",
//     "purpose": "거래처 방문",
//     "driver_name": "김영업" }

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;

const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
const LEAD_MINUTES: i64 = 30;   // 시작 30분 전 알림

pub fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        // 부팅 직후 즉시 1회 실행 → 이후 5분 주기.
        // 오래 다운되어 있었던 동안 놓친 임박 예약도 커버.
        let mut tick = tokio::time::interval(POLL_INTERVAL);
        loop {
            tick.tick().await;
            if let Err(e) = run_once(&pool).await {
                tracing::warn!("reservation_alerts: {e}");
            }
        }
    });
    tracing::info!("reservation_alerts worker: started (poll every {}s)", POLL_INTERVAL.as_secs());
}

async fn run_once(db: &PgPool) -> anyhow::Result<()> {
    let now = Utc::now();
    let lead_until = now + chrono::Duration::minutes(LEAD_MINUTES);

    // 임박 예약 조회 — JOIN devices+staff 로 이벤트 payload 에 이름 포함.
    #[derive(sqlx::FromRow)]
    struct Row {
        id:            i64,
        user_id:       i64,
        device_id:     i64,
        starts_at:     DateTime<Utc>,
        purpose:       Option<String>,
        device_name:   Option<String>,
        license_plate: Option<String>,
        driver_name:   Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT r.id, r.user_id, r.device_id, r.starts_at, r.purpose,
                  d.display_name AS device_name, d.license_plate,
                  s.name         AS driver_name
             FROM vehicle_reservations r
        LEFT JOIN devices d ON d.id = r.device_id
        LEFT JOIN staff   s ON s.id = r.driver_staff_id
            WHERE r.status = 'planned'
              AND r.alerted_at IS NULL
              AND r.starts_at BETWEEN $1 AND $2"#,
    )
    .bind(now).bind(lead_until)
    .fetch_all(db).await?;

    if rows.is_empty() { return Ok(()); }

    tracing::info!("reservation_alerts: {} upcoming reservation(s) to alert", rows.len());

    for r in rows {
        let mins_until = ((r.starts_at - now).num_seconds() / 60).max(0);
        let data = json!({
            "type": "reservation_starting",
            "reservation_id": r.id,
            "device_id":      r.device_id,
            "device_name":    r.device_name,
            "license_plate":  r.license_plate,
            "starts_at":      r.starts_at,
            "purpose":        r.purpose,
            "driver_name":    r.driver_name,
            "minutes_until":  mins_until,
        });

        // 이벤트 insert + reservation 표시 원자적. FCM 이벤트 발송은 별도 워커.
        let mut tx = db.begin().await?;
        sqlx::query(
            r#"INSERT INTO events (device_id, user_id, occurred_at, kind, data)
               VALUES ($1, $2, NOW(), 'reservation_starting', $3)"#,
        )
        .bind(r.device_id).bind(r.user_id).bind(&data)
        .execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE vehicle_reservations SET alerted_at = NOW() WHERE id = $1",
        )
        .bind(r.id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}
