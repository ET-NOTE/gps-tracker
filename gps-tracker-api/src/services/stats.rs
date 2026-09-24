// 일별 운행 통계 집계 워커.
// 매 5분마다 "오늘 + 어제" 두 날짜만 다시 계산 → daily_stats UPSERT.
// 과거 데이터는 변경 없으니 오늘/어제만 집계해도 충분.
//
// 거리 계산: 인접 fix 점 간 haversine.
// 정지 구간 식별: 5분 이상 같은 위치(반경 50m) 머무름.
// 평균 속도: 총거리 / moving_s (s>0 일 때).

use chrono::{DateTime, NaiveDate, Utc};
use sqlx::PgPool;
use std::time::Duration;
use tokio::time::sleep;

const POLL_INTERVAL: Duration = Duration::from_secs(300); // 5분
const STOP_THRESHOLD_M: f64 = 50.0;
const STOP_THRESHOLD_S: i64 = 5 * 60;

const EARTH_R_M: f64 = 6_371_000.0;
fn haversine_m(la1: f64, lo1: f64, la2: f64, lo2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let dla = (la2 - la1) * to_rad;
    let dlo = (lo2 - lo1) * to_rad;
    let a = (dla / 2.0).sin().powi(2)
        + (la1 * to_rad).cos() * (la2 * to_rad).cos() * (dlo / 2.0).sin().powi(2);
    2.0 * EARTH_R_M * a.sqrt().asin()
}

pub fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        tracing::info!("daily_stats worker: started (poll every 5min)");
        loop {
            if let Err(e) = run_aggregation(&pool).await {
                tracing::warn!("daily_stats: {e:#}");
            }
            sleep(POLL_INTERVAL).await;
        }
    });
}

async fn run_aggregation(pool: &PgPool) -> anyhow::Result<()> {
    let queued: Vec<(i64, NaiveDate, i64)> = sqlx::query_as(
        "SELECT device_id,date,generation FROM stats_rebuild_queue ORDER BY date LIMIT 100",
    )
    .fetch_all(pool)
    .await?;
    for (did, date, generation) in queued {
        aggregate_one(pool, did, date).await?;
        sqlx::query(
            "DELETE FROM stats_rebuild_queue WHERE device_id=$1 AND date=$2 AND generation=$3",
        )
        .bind(did)
        .bind(date)
        .bind(generation)
        .execute(pool)
        .await?;
    }
    // 오늘 / 어제 (KST 기준)
    let now_kst = Utc::now() + chrono::Duration::hours(9);
    let today = now_kst.date_naive();
    let yest = today - chrono::Duration::days(1);

    // 활성 디바이스 (최근 36h 내 ingest 있던 것만) — 평소 worker.
    let active_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM devices WHERE last_seen_at > now() - interval '36 hours'",
    )
    .fetch_all(pool)
    .await?;

    for did in active_ids {
        for date in [yest, today] {
            if let Err(e) = aggregate_one(pool, did, date).await {
                tracing::warn!(device_id = did, date = %date, "daily_stats: {e:#}");
            }
        }
    }

    // 레거시 catch-up — location_records 가 있지만 daily_stats 가 한 행도 없는 디바이스.
    // import 후 한 번도 워커가 안 돈 디바이스 (id 135 처럼).
    // 발견되면 그 디바이스의 모든 record 날짜에 대해 한 번씩 aggregate_one 호출.
    let legacy: Vec<i64> = sqlx::query_scalar(
        r#"SELECT DISTINCT lr.device_id
             FROM location_points lr
            WHERE NOT EXISTS (
                  SELECT 1 FROM daily_stats ds WHERE ds.device_id = lr.device_id
            )
            LIMIT 50"#,
    )
    .fetch_all(pool)
    .await?;

    for did in legacy {
        let dates: Vec<NaiveDate> = sqlx::query_scalar(
            r#"SELECT DISTINCT (recorded_at AT TIME ZONE 'Asia/Seoul')::date
                 FROM location_points
                WHERE device_id = $1 AND fix = TRUE"#,
        )
        .bind(did)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        tracing::info!(
            device_id = did,
            dates = dates.len(),
            "daily_stats legacy catchup"
        );
        for date in dates {
            if let Err(e) = aggregate_one(pool, did, date).await {
                tracing::warn!(device_id = did, date = %date, "daily_stats catchup: {e:#}");
            }
        }
    }

    Ok(())
}

pub async fn aggregate_one(pool: &PgPool, device_id: i64, date: NaiveDate) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM devices WHERE id=$1 FOR UPDATE")
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    // KST 날짜 → UTC 범위 (KST = UTC+9)
    let start_kst = date.and_hms_opt(0, 0, 0).unwrap();
    let end_kst = (date + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap();
    // KST → UTC: -9시간
    let start_utc = start_kst - chrono::Duration::hours(9);
    let end_utc = end_kst - chrono::Duration::hours(9);

    // fix=true 점만, 시간순
    let rows: Vec<(DateTime<Utc>, f64, f64)> = sqlx::query_as(
        // [뿌리 B 2026-08-14] 현재 owner 데이터만 집계 — 재페어링된 device 에서 이전 owner 의
        //   fix 까지 합산해 통계 혼입되던 것 차단 (upsert user_id 도 EXCLUDED 로 현재 owner 반영).
        r#"SELECT DISTINCT ON(recorded_at) recorded_at, lat, lng
             FROM location_points
            WHERE device_id = $1
              AND user_id = (SELECT owner_id FROM devices WHERE id = $1)
              AND fix = TRUE
              AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
              AND recorded_at >= $2 AND recorded_at < $3
            ORDER BY recorded_at,CASE source WHEN 'phone' THEN 0 WHEN 'l80' THEN 1 ELSE 2 END"#,
    )
    .bind(device_id)
    .bind(DateTime::<Utc>::from_naive_utc_and_offset(start_utc, Utc))
    .bind(DateTime::<Utc>::from_naive_utc_and_offset(end_utc, Utc))
    .fetch_all(&mut *tx)
    .await?;

    if rows.is_empty() {
        // 기존 row 가 있으면 0으로 갱신 (디바이스가 데이터 0건인 날)
        sqlx::query(
            r#"INSERT INTO daily_stats (device_id, date, fix_count, distance_m, duration_s, moving_s, stop_count, max_speed_kmh, avg_speed_kmh, first_fix_at, last_fix_at, updated_at, user_id)
               VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, now(),
                       (SELECT owner_id FROM devices WHERE id = $1))
               ON CONFLICT (device_id, date) DO UPDATE
                  SET fix_count=0, distance_m=0, duration_s=0, moving_s=0, stop_count=0,
                      max_speed_kmh=0, avg_speed_kmh=0, first_fix_at=NULL, last_fix_at=NULL, updated_at=now(),
                      user_id = EXCLUDED.user_id"#,
        )
        .bind(device_id).bind(date)
        .execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(());
    }

    let n = rows.len();
    let first_at = rows[0].0;
    let last_at = rows[n - 1].0;
    let duration_s = (last_at - first_at).num_seconds().max(0) as i32;

    let Metrics {
        distance_m,
        moving_s,
        stop_count,
        max_speed,
        avg_speed,
    } = calculate_metrics(&rows);

    sqlx::query(
        r#"INSERT INTO daily_stats
             (device_id, date, fix_count, distance_m, duration_s, moving_s, stop_count,
              max_speed_kmh, avg_speed_kmh, first_fix_at, last_fix_at, updated_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(),
                   (SELECT owner_id FROM devices WHERE id = $1))
           ON CONFLICT (device_id, date) DO UPDATE SET
             fix_count     = EXCLUDED.fix_count,
             distance_m    = EXCLUDED.distance_m,
             duration_s    = EXCLUDED.duration_s,
             moving_s      = EXCLUDED.moving_s,
             stop_count    = EXCLUDED.stop_count,
             max_speed_kmh = EXCLUDED.max_speed_kmh,
             avg_speed_kmh = EXCLUDED.avg_speed_kmh,
             first_fix_at  = EXCLUDED.first_fix_at,
             last_fix_at   = EXCLUDED.last_fix_at,
             updated_at    = now(),
             user_id       = EXCLUDED.user_id"#,
    )
    .bind(device_id)
    .bind(date)
    .bind(n as i32)
    .bind(distance_m)
    .bind(duration_s)
    .bind(moving_s as i32)
    .bind(stop_count)
    .bind(max_speed as f32)
    .bind(avg_speed as f32)
    .bind(first_at)
    .bind(last_at)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

#[derive(Default, Debug)]
pub(crate) struct Metrics {
    pub distance_m: f64,
    moving_s: i64,
    stop_count: i32,
    max_speed: f64,
    avg_speed: f64,
}
pub(crate) fn calculate_metrics(rows: &[(DateTime<Utc>, f64, f64)]) -> Metrics {
    let mut out = Metrics::default();
    if rows.len() < 2 {
        return out;
    }
    // A stop is a sustained cluster around a fixed anchor, not a succession of short steps.
    let mut anchor = 0;
    let mut stop_seconds = 0;
    let mut observed_seconds = 0;
    let mut cluster_distance = 0.0;
    for i in 1..rows.len() {
        let (t0, la0, lo0) = rows[i - 1];
        let (t1, la1, lo1) = rows[i];
        let dt = (t1 - t0).num_seconds();
        let d = haversine_m(la0, lo0, la1, lo1);
        let speed = if dt > 0 { d / dt as f64 * 3.6 } else { 0.0 };
        if dt <= 0 || dt > 600 || speed > 250.0 {
            let duration = (rows[i - 1].0 - rows[anchor].0).num_seconds();
            if duration >= STOP_THRESHOLD_S {
                out.stop_count += 1;
                stop_seconds += duration;
                out.distance_m -= cluster_distance;
            }
            anchor = i;
            cluster_distance = 0.0;
            continue;
        }
        observed_seconds += dt;
        out.distance_m += d;
        out.max_speed = out.max_speed.max(speed);
        if haversine_m(rows[anchor].1, rows[anchor].2, la1, lo1) <= STOP_THRESHOLD_M {
            cluster_distance += d;
        } else {
            let duration = (rows[i - 1].0 - rows[anchor].0).num_seconds();
            if duration >= STOP_THRESHOLD_S {
                out.stop_count += 1;
                stop_seconds += duration;
                out.distance_m -= cluster_distance;
            }
            anchor = i;
            cluster_distance = 0.0;
        }
    }
    let duration = (rows.last().unwrap().0 - rows[anchor].0).num_seconds();
    if duration >= STOP_THRESHOLD_S {
        out.stop_count += 1;
        stop_seconds += duration;
        out.distance_m -= cluster_distance;
    }
    out.distance_m = out.distance_m.max(0.0);
    out.moving_s = (observed_seconds - stop_seconds).max(0);
    out.avg_speed = if out.moving_s > 0 {
        out.distance_m / out.moving_s as f64 * 3.6
    } else {
        0.0
    };
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_continuous_travel_is_not_a_stop() {
        let t = DateTime::from_timestamp(1700000000, 0).unwrap();
        let rows: Vec<_> = (0..41)
            .map(|i| {
                (
                    t + chrono::Duration::seconds(i * 15),
                    37.0 + i as f64 * 0.00027,
                    127.0,
                )
            })
            .collect();
        let m = calculate_metrics(&rows);
        assert_eq!(m.stop_count, 0);
        assert_eq!(m.moving_s, 600);
        assert!(m.distance_m > 1100.0);
    }
    #[test]
    fn stationary_jitter_and_unobserved_gaps_do_not_inflate_distance() {
        let t = DateTime::from_timestamp(1700000000, 0).unwrap();
        let mut rows: Vec<_> = (0..21)
            .map(|i| {
                (
                    t + chrono::Duration::seconds(i * 15),
                    37.0 + (i % 2) as f64 * 0.00002,
                    127.0,
                )
            })
            .collect();
        rows.push((t + chrono::Duration::hours(2), 38.0, 128.0));
        let m = calculate_metrics(&rows);
        assert_eq!(m.stop_count, 1);
        assert_eq!(m.moving_s, 0);
        assert!(m.distance_m < 0.1);
    }
}
