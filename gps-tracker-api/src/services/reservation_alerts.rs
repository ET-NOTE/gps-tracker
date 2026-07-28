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
const LEAD_MINUTES: i64 = 30;      // 시작 30분 전 알림
const END_LEAD_MINUTES: i64 = 30;  // (4H-2) 종료 30분 전 반납 알림

pub fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(POLL_INTERVAL);
        loop {
            tick.tick().await;
            if let Err(e) = run_once(&pool).await {
                tracing::warn!("reservation_alerts start: {e}");
            }
            if let Err(e) = run_end_alerts(&pool).await {
                tracing::warn!("reservation_alerts end: {e}");
            }
            if let Err(e) = auto_transition_status(&pool).await {
                tracing::warn!("reservation_alerts auto-status: {e}");
            }
            // (Stage-R3) 렌트카 반납 임박 + 연체 알림 (owner FCM 대상)
            if let Err(e) = run_rental_ending_alerts(&pool).await {
                tracing::warn!("rental_ending_alerts: {e}");
            }
            if let Err(e) = run_rental_overdue_alerts(&pool).await {
                tracing::warn!("rental_overdue_alerts: {e}");
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

// (2026-07-28 Stage-4H-2) 반납 임박 (ends_at 30분 전) 알림.
async fn run_end_alerts(db: &PgPool) -> anyhow::Result<()> {
    let now = Utc::now();
    let lead_until = now + chrono::Duration::minutes(END_LEAD_MINUTES);
    #[derive(sqlx::FromRow)]
    struct Row {
        id:            i64, user_id: i64, device_id: i64,
        ends_at:       DateTime<Utc>, purpose: Option<String>,
        device_name:   Option<String>, license_plate: Option<String>,
        driver_name:   Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT r.id, r.user_id, r.device_id, r.ends_at, r.purpose,
                  d.display_name AS device_name, d.license_plate,
                  s.name AS driver_name
             FROM vehicle_reservations r
        LEFT JOIN devices d ON d.id = r.device_id
        LEFT JOIN staff   s ON s.id = r.driver_staff_id
            WHERE r.status IN ('planned','in_progress')
              AND r.ended_alerted_at IS NULL
              AND r.ends_at BETWEEN $1 AND $2"#,
    )
    .bind(now).bind(lead_until).fetch_all(db).await?;
    if rows.is_empty() { return Ok(()); }
    tracing::info!("reservation_alerts: {} ending reservation(s)", rows.len());
    for r in rows {
        let mins = ((r.ends_at - now).num_seconds() / 60).max(0);
        let data = json!({
            "type": "reservation_ending",
            "reservation_id": r.id, "device_id": r.device_id,
            "device_name": r.device_name, "license_plate": r.license_plate,
            "ends_at": r.ends_at, "purpose": r.purpose, "driver_name": r.driver_name,
            "minutes_until": mins,
        });
        let mut tx = db.begin().await?;
        sqlx::query(
            r#"INSERT INTO events (device_id, user_id, occurred_at, kind, data)
               VALUES ($1, $2, NOW(), 'reservation_ending', $3)"#,
        )
        .bind(r.device_id).bind(r.user_id).bind(&data)
        .execute(&mut *tx).await?;
        sqlx::query("UPDATE vehicle_reservations SET ended_alerted_at = NOW() WHERE id = $1")
            .bind(r.id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}

// (2026-07-28 Stage-4H-2) 시간 기반 자동 status 전환.
async fn auto_transition_status(db: &PgPool) -> anyhow::Result<()> {
    let n1 = sqlx::query(
        r#"UPDATE vehicle_reservations SET status = 'in_progress', updated_at = NOW()
            WHERE status = 'planned' AND starts_at <= NOW() AND ends_at > NOW()"#,
    ).execute(db).await?.rows_affected();
    let n2 = sqlx::query(
        r#"UPDATE vehicle_reservations SET status = 'completed', updated_at = NOW()
            WHERE status = 'in_progress' AND ends_at <= NOW()"#,
    ).execute(db).await?.rows_affected();
    let n3 = sqlx::query(
        r#"UPDATE vehicle_reservations SET status = 'completed', updated_at = NOW()
            WHERE status = 'planned' AND ends_at <= NOW()"#,
    ).execute(db).await?.rows_affected();

    // (Stage-R1) 렌트카 계약 자동 전환:
    //   draft/active → overdue: ends_at 지났고 아직 returned/cancelled 아님
    //   draft → active: starts_at 이 지났고 아직 draft
    let r1 = sqlx::query(
        r#"UPDATE rental_contracts SET status = 'active', updated_at = NOW()
            WHERE status = 'draft' AND starts_at <= NOW() AND ends_at > NOW()"#,
    ).execute(db).await?.rows_affected();
    let r2 = sqlx::query(
        r#"UPDATE rental_contracts SET status = 'overdue', updated_at = NOW()
            WHERE status IN ('draft','active') AND ends_at <= NOW()"#,
    ).execute(db).await?.rows_affected();
    if n1 + n2 + n3 + r1 + r2 > 0 {
        tracing::info!("auto-status: reservations {n1}/{n2}/{n3}, rentals {r1}/{r2}");
    }
    Ok(())
}

// (2026-07-28 Stage-R3) 렌트카 계약 알림 — 반납 임박 + 연체.
// events(kind='rental_ending'|'rental_overdue') insert.
// 기존 FCM 워커가 notified_at IS NULL 폴링 → owner user 에게 push.
// 임차인 (renter_phone) 문자는 Bizmsg 템플릿 사전 등록 필요 → 별도 후속.
const RENTAL_ENDING_LEAD_HOURS: i64 = 24;

async fn run_rental_ending_alerts(db: &PgPool) -> anyhow::Result<()> {
    let now = Utc::now();
    let lead_until = now + chrono::Duration::hours(RENTAL_ENDING_LEAD_HOURS);
    #[derive(sqlx::FromRow)]
    struct Row {
        id: i64,
        user_id: i64,
        device_id: i64,
        ends_at: DateTime<Utc>,
        renter_name: String,
        renter_phone: Option<String>,
        device_name: Option<String>,
        license_plate: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT r.id, r.user_id, r.device_id, r.ends_at, r.renter_name, r.renter_phone,
                  d.display_name AS device_name, d.license_plate
             FROM rental_contracts r
        LEFT JOIN devices d ON d.id = r.device_id
            WHERE r.status IN ('draft','active')
              AND r.ending_alerted_at IS NULL
              AND r.ends_at BETWEEN $1 AND $2"#,
    )
    .bind(now)
    .bind(lead_until)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    tracing::info!("rental_ending_alerts: {} contract(s) ending soon", rows.len());
    for r in rows {
        let hours = (r.ends_at - now).num_hours().max(0);
        let data = json!({
            "type": "rental_ending",
            "contract_id":   r.id,
            "device_id":     r.device_id,
            "device_name":   r.device_name,
            "license_plate": r.license_plate,
            "renter_name":   r.renter_name,
            "renter_phone":  r.renter_phone,
            "ends_at":       r.ends_at,
            "hours_until":   hours,
        });
        let mut tx = db.begin().await?;
        sqlx::query(
            r#"INSERT INTO events (device_id, user_id, occurred_at, kind, data)
               VALUES ($1, $2, NOW(), 'rental_ending', $3)"#,
        )
        .bind(r.device_id)
        .bind(r.user_id)
        .bind(&data)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE rental_contracts SET ending_alerted_at = NOW() WHERE id = $1")
            .bind(r.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(())
}

async fn run_rental_overdue_alerts(db: &PgPool) -> anyhow::Result<()> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: i64,
        user_id: i64,
        device_id: i64,
        ends_at: DateTime<Utc>,
        renter_name: String,
        renter_phone: Option<String>,
        device_name: Option<String>,
        license_plate: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT r.id, r.user_id, r.device_id, r.ends_at, r.renter_name, r.renter_phone,
                  d.display_name AS device_name, d.license_plate
             FROM rental_contracts r
        LEFT JOIN devices d ON d.id = r.device_id
            WHERE r.status = 'overdue' AND r.overdue_alerted_at IS NULL"#,
    )
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    tracing::info!("rental_overdue_alerts: {} overdue contract(s)", rows.len());
    let now = Utc::now();
    for r in rows {
        let hours_over = (now - r.ends_at).num_hours().max(0);
        let data = json!({
            "type": "rental_overdue",
            "contract_id":   r.id,
            "device_id":     r.device_id,
            "device_name":   r.device_name,
            "license_plate": r.license_plate,
            "renter_name":   r.renter_name,
            "renter_phone":  r.renter_phone,
            "ends_at":       r.ends_at,
            "hours_over":    hours_over,
        });
        let mut tx = db.begin().await?;
        sqlx::query(
            r#"INSERT INTO events (device_id, user_id, occurred_at, kind, data)
               VALUES ($1, $2, NOW(), 'rental_overdue', $3)"#,
        )
        .bind(r.device_id)
        .bind(r.user_id)
        .bind(&data)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE rental_contracts SET overdue_alerted_at = NOW() WHERE id = $1")
            .bind(r.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(())
}
