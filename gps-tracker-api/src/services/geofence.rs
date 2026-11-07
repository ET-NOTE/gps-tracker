// 지오펜스 진입/이탈 감지 + 통신 두절 백그라운드 워커.
//
// check_after_ingest: 위치 ingest 직후 호출. 해당 디바이스가 모든 활성 지오펜스에
//   대해 in/out 인지 판정 → 상태 변화 시 events 테이블에 'geofence_in'/'geofence_out' 삽입.
//
// spawn_offline_worker: 30초마다 미수신 상태를 검사한다.
// connection_alerts가 마지막 실제 수신 시각별로 한 번만 이벤트를 기록한다.

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
pub async fn check_after_ingest(
    pool: &PgPool,
    device_id: i64,
    lat: f64,
    lng: f64,
) -> anyhow::Result<()> {
    // owner의 활성 지오펜스 중 device_id 일치하거나 NULL(전체 적용)
    let fences: Vec<(i64, f64, f64, i32, String)> = sqlx::query_as(
        r#"SELECT g.id, g.center_lat, g.center_lng, g.radius_m, g.name
             FROM geofences g
             JOIN gps_read_devices  d ON d.owner_id = g.owner_id
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
        // [2026-08-14] 적응형 hysteresis — 고정 10m 는 반경 ≤20m 펜스의 진입(dist<=radius-10)을
        //   수학적으로 불가능하게 만들었음(radius=15 → 진입 threshold 5m, radius=10 → 0m).
        //   반경의 30% 와 10m 중 작은 값 → 소형 펜스도 진입 가능하고 대형은 기존 10m 유지.
        let hyst = (radius_f * 0.3).min(GEOFENCE_HYSTERESIS_M);
        let inside_now = match prev {
            None => dist <= radius_f,
            Some(true) => dist <= radius_f + hyst,
            Some(false) => dist <= radius_f - hyst,
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
            let kind = if inside_now {
                "geofence_in"
            } else {
                "geofence_out"
            };
            sqlx::query(
                r#"INSERT INTO events (device_id, kind, occurred_at, data, user_id)
                   VALUES ($1, $2, now(), $3,
                           (SELECT owner_id FROM gps_read_devices WHERE id = $1))"#,
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

            tracing::info!(
                device_id,
                gid,
                kind,
                dist_m = dist as i64,
                "geofence transition"
            );
        }

        tx.commit().await?;
    }
    Ok(())
}

/// 통신 두절 워커. 사용자 설정 offline_minutes 보다 오래 무소식인 디바이스에
/// 실제 수신이 재개되기 전까지 일일 반복 알림을 만들지 않는다.
pub fn spawn_offline_worker(pool: PgPool) {
    tokio::spawn(async move {
        tracing::info!("offline worker: started (poll every 30s)");
        loop {
            if let Err(e) = super::connection_alerts::scan(&pool).await {
                tracing::warn!("offline worker error: {e:#}");
            }
            sleep(OFFLINE_POLL_INTERVAL).await;
        }
    });
}
