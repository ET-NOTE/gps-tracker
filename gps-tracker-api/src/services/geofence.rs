// 지오펜스 진입/이탈 감지 + 통신 두절 백그라운드 워커.
//
// check_after_ingest: 위치 ingest 직후 호출. 해당 디바이스가 모든 활성 지오펜스에
//   대해 in/out 인지 판정 → 상태 변화 시 events 테이블에 'geofence_in'/'geofence_out' 삽입.
//
// spawn_offline_worker: 30초 주기로 실행. 사용자별 offline_minutes 임계 넘긴 디바이스에
//   'offline' 이벤트를 한 번만 (직전 events 가 'offline' 아닐 때만) 삽입. FCM 워커가 발송.

use std::time::Duration;

use serde_json::json;
use sqlx::PgPool;
use tokio::time::sleep;

const EARTH_R_M: f64 = 6_371_000.0;
const OFFLINE_POLL_INTERVAL: Duration = Duration::from_secs(30);
// 펜스 경계 hysteresis — GPS noise 로 인한 in/out 플래핑 방지.
// inside 진입: dist <= radius - 10m (확실히 안쪽)
// outside 이탈: dist > radius + 10m (확실히 바깥)
// 그 사이는 이전 상태 유지.
const GEOFENCE_HYSTERESIS_M: f64 = 10.0;

pub fn haversine_m(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let dlat = (lat2 - lat1) * to_rad;
    let dlng = (lng2 - lng1) * to_rad;
    let a = (dlat / 2.0).sin().powi(2)
        + (lat1 * to_rad).cos() * (lat2 * to_rad).cos() * (dlng / 2.0).sin().powi(2);
    2.0 * EARTH_R_M * a.sqrt().asin()
}

/// ingest 직후 호출. 이 디바이스에 적용되는 모든 활성 지오펜스를 검사하고
/// in/out 트랜지션 발생 시 events 삽입.
pub async fn check_after_ingest(pool: &PgPool, device_id: i64, lat: f64, lng: f64) -> anyhow::Result<()> {
    // owner의 활성 지오펜스 중 device_id 일치하거나 NULL(전체 적용)
    let fences: Vec<(i64, f64, f64, i32, String)> = sqlx::query_as(
        r#"SELECT g.id, g.center_lat, g.center_lng, g.radius_m, g.name
             FROM geofences g
             JOIN devices  d ON d.owner_id = g.owner_id
            WHERE d.id = $1
              AND g.active
              AND (g.device_id IS NULL OR g.device_id = $1)"#,
    )
    .bind(device_id)
    .fetch_all(pool)
    .await?;

    for (gid, clat, clng, radius, gname) in fences {
        let dist = haversine_m(lat, lng, clat, clng);

        // 펜스 단위 트랜잭션 — SELECT FOR UPDATE 로 동시 ingest race 차단.
        // 한 펜스의 state 행을 잠가두고 prev → new 계산 → event/upsert 까지 원자.
        let mut tx = pool.begin().await?;

        let prev: Option<bool> = sqlx::query_scalar(
            r#"SELECT inside FROM geofence_states
                WHERE geofence_id = $1 AND device_id = $2
                  FOR UPDATE"#,
        )
        .bind(gid)
        .bind(device_id)
        .fetch_optional(&mut *tx)
        .await?;

        // Hysteresis 적용된 새 상태:
        //   첫 측정: 단순 반경 비교 (이전 상태가 없으므로 buffer 의미 X)
        //   이전 inside : dist > radius + 10m 일 때만 outside (그 외 inside 유지)
        //   이전 outside: dist <= radius - 10m 일 때만 inside  (그 외 outside 유지)
        let radius_f = radius as f64;
        let inside_now = match prev {
            None        => dist <= radius_f,
            Some(true)  => dist <= radius_f + GEOFENCE_HYSTERESIS_M,
            Some(false) => dist <= radius_f - GEOFENCE_HYSTERESIS_M,
        };

        // 첫 측정 — 상태만 기록 (이미 안에 있었던 건지 모르므로 이벤트 없음).
        // ON CONFLICT 는 동시 INSERT race 방어 (FOR UPDATE 가 NULL 결과엔 잠금 못 걺).
        if prev.is_none() {
            sqlx::query(
                r#"INSERT INTO geofence_states (geofence_id, device_id, inside)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (geofence_id, device_id) DO NOTHING"#,
            )
            .bind(gid)
            .bind(device_id)
            .bind(inside_now)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            continue;
        }

        // 트랜지션 발생 — 이벤트 + 상태 갱신 한 트랜잭션 안에.
        if prev != Some(inside_now) {
            let kind = if inside_now { "geofence_in" } else { "geofence_out" };
            sqlx::query(
                r#"INSERT INTO events (device_id, kind, occurred_at, data, user_id)
                   VALUES ($1, $2, now(), $3,
                           (SELECT owner_id FROM devices WHERE id = $1))"#,
            )
            .bind(device_id)
            .bind(kind)
            .bind(json!({
                "geofence_id":   gid,
                "geofence_name": gname,
                "lat":           lat,
                "lng":           lng,
                "distance_m":    dist as i64,
            }))
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                r#"UPDATE geofence_states
                      SET inside = $1, last_transition_at = now()
                    WHERE geofence_id = $2 AND device_id = $3"#,
            )
            .bind(inside_now)
            .bind(gid)
            .bind(device_id)
            .execute(&mut *tx)
            .await?;

            tracing::info!(device_id, gid, kind, dist_m=dist as i64, "geofence transition");
        }

        tx.commit().await?;
    }
    Ok(())
}

/// 통신 두절 워커. 사용자 설정 offline_minutes 보다 오래 무소식인 디바이스에
/// 'offline' 이벤트를 한 번만 삽입 (직전 미통보 이벤트 중 동일 kind 있으면 skip).
pub fn spawn_offline_worker(pool: PgPool) {
    tokio::spawn(async move {
        tracing::info!("offline worker: started (poll every 30s)");
        loop {
            if let Err(e) = scan_offline(&pool).await {
                tracing::warn!("offline worker error: {e:#}");
            }
            sleep(OFFLINE_POLL_INTERVAL).await;
        }
    });
}

async fn scan_offline(pool: &PgPool) -> anyhow::Result<()> {
    // 페어링된 디바이스 + 사용자 설정 (signal_loss_minutes / offline_minutes) join.
    // signal_loss_minutes (default 5) 보다 오래 무소식인 모든 디바이스를 가져와서
    // 두 임계점 (signal_loss / offline) 을 한 루프에서 평가.
    let candidates: Vec<(i64, i32, i32, i64)> = sqlx::query_as(
        r#"SELECT d.id,
                  COALESCE(ns.signal_loss_minutes, 5)  AS signal_min,
                  COALESCE(ns.offline_minutes, 30)     AS offline_min,
                  EXTRACT(EPOCH FROM (now() - d.last_seen_at))::BIGINT AS silence_sec
             FROM devices d
             JOIN users u ON u.id = d.owner_id
        LEFT JOIN notification_settings ns ON ns.user_id = d.owner_id
            WHERE d.last_seen_at IS NOT NULL
              AND d.last_seen_at < now() - (COALESCE(ns.signal_loss_minutes, 5) || ' minutes')::interval"#,
    )
    .fetch_all(pool)
    .await?;

    for (device_id, signal_min, offline_min, silence_sec) in candidates {
        let silence_min = silence_sec / 60;

        // 의도적 sleep 상태이면 통신 알림 스킵 — 'lost' 워커가 24h 후 처리
        // user_id 격리: 현재 owner 의 이벤트만 봄 (이전 owner 의 sleep_enter 가
        // 새 owner 의 통신 알림을 막지 않도록)
        let last_event: Option<String> = sqlx::query_scalar(
            r#"SELECT kind FROM events
                WHERE device_id = $1
                  AND user_id = (SELECT owner_id FROM devices WHERE id = $1)
                ORDER BY occurred_at DESC LIMIT 1"#,
        ).bind(device_id).fetch_optional(pool).await?;
        if last_event.as_deref() == Some("sleep_enter") { continue; }

        // 어떤 단계 알림을 발사할지 결정
        if silence_min >= offline_min as i64 {
            // OFFLINE 단계 (30분+) — 직전 24h 내 offline 없을 때만 한 번 발사
            let recent_offline: Option<bool> = sqlx::query_scalar(
                r#"SELECT TRUE FROM events
                    WHERE device_id = $1
                      AND user_id = (SELECT owner_id FROM devices WHERE id = $1)
                      AND kind = 'offline'
                      AND occurred_at > now() - interval '24 hours'
                    ORDER BY occurred_at DESC LIMIT 1"#,
            )
            .bind(device_id).fetch_optional(pool).await?;
            if recent_offline.is_some() { continue; }

            sqlx::query(
                r#"INSERT INTO events (device_id, kind, occurred_at, data, user_id)
                   VALUES ($1, 'offline', now(), $2,
                           (SELECT owner_id FROM devices WHERE id = $1))"#,
            )
            .bind(device_id)
            .bind(json!({ "reason": "no_data_received", "silence_min": silence_min }))
            .execute(pool).await?;
            tracing::info!(device_id, silence_min, "offline event inserted");
        } else if silence_min >= signal_min as i64 {
            // SIGNAL_LOSS 단계 (5~30분) — 직전 24h 내 signal_loss/offline 없을 때만
            let recent_either: Option<bool> = sqlx::query_scalar(
                r#"SELECT TRUE FROM events
                    WHERE device_id = $1
                      AND user_id = (SELECT owner_id FROM devices WHERE id = $1)
                      AND kind IN ('signal_loss', 'offline')
                      AND occurred_at > now() - interval '24 hours'
                    ORDER BY occurred_at DESC LIMIT 1"#,
            )
            .bind(device_id).fetch_optional(pool).await?;
            if recent_either.is_some() { continue; }

            sqlx::query(
                r#"INSERT INTO events (device_id, kind, occurred_at, data, user_id)
                   VALUES ($1, 'signal_loss', now(), $2,
                           (SELECT owner_id FROM devices WHERE id = $1))"#,
            )
            .bind(device_id)
            .bind(json!({ "silence_min": silence_min }))
            .execute(pool).await?;
            tracing::info!(device_id, silence_min, "signal_loss event inserted");
        }
    }

    // ── 'lost' 디바이스 — 마지막 이벤트가 sleep_enter 이고 24h 넘게 무응답 ──
    // last_event_kind = 'sleep_enter' AND occurred_at < now() - 24h AND last_seen_at < now() - 24h
    let lost_candidates: Vec<(i64, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        r#"SELECT d.id, le.occurred_at
             FROM devices d
        JOIN LATERAL (
              SELECT kind, occurred_at
                FROM events
               WHERE device_id = d.id AND user_id = d.owner_id
            ORDER BY occurred_at DESC LIMIT 1
        ) le ON le.kind = 'sleep_enter'
            WHERE le.occurred_at < now() - interval '24 hours'
              AND d.last_seen_at < now() - interval '24 hours'"#,
    ).fetch_all(pool).await.unwrap_or_default();

    for (device_id, sleep_at) in lost_candidates {
        // 이미 lost 이벤트가 있고 그게 sleep_at 보다 최신이면 스킵
        let recent_lost: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
            r#"SELECT occurred_at FROM events
                WHERE device_id = $1 AND kind = 'lost'
                  AND user_id = (SELECT owner_id FROM devices WHERE id = $1)
                ORDER BY occurred_at DESC LIMIT 1"#,
        ).bind(device_id).fetch_optional(pool).await?;
        if let Some(t) = recent_lost {
            if t > sleep_at { continue; }
        }

        let hours = (chrono::Utc::now() - sleep_at).num_hours().max(24);
        sqlx::query(
            r#"INSERT INTO events (device_id, kind, occurred_at, data, user_id)
               VALUES ($1, 'lost', now(), $2,
                       (SELECT owner_id FROM devices WHERE id = $1))"#,
        )
        .bind(device_id)
        .bind(json!({ "hours_since_sleep": hours, "sleep_at": sleep_at }))
        .execute(pool).await?;
        tracing::warn!(device_id, hours, "lost event inserted");
    }
    Ok(())
}
