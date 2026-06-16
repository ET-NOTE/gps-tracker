// 일별 운행 통계 집계 워커.
// 매 5분마다 "오늘 + 어제" 두 날짜만 다시 계산 → daily_stats UPSERT.
// 과거 데이터는 변경 없으니 오늘/어제만 집계해도 충분.
//
// 거리 계산: 인접 fix 점 간 haversine.
// 정지 구간 식별: 5분 이상 같은 위치(반경 50m) 머무름.
// 평균 속도: 총거리 / moving_s (s>0 일 때).

use std::time::Duration;
use chrono::{DateTime, NaiveDate, Utc, Datelike};
use sqlx::PgPool;
use tokio::time::sleep;

const POLL_INTERVAL: Duration = Duration::from_secs(300); // 5분
const STOP_THRESHOLD_M: f64 = 50.0;
const STOP_THRESHOLD_S: i64 = 5 * 60;

const EARTH_R_M: f64 = 6_371_000.0;
fn haversine_m(la1: f64, lo1: f64, la2: f64, lo2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let dla = (la2 - la1) * to_rad;
    let dlo = (lo2 - lo1) * to_rad;
    let a = (dla/2.0).sin().powi(2)
        + (la1*to_rad).cos() * (la2*to_rad).cos() * (dlo/2.0).sin().powi(2);
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
    // 오늘 / 어제 (KST 기준)
    let now_kst = Utc::now() + chrono::Duration::hours(9);
    let today = now_kst.date_naive();
    let yest  = today - chrono::Duration::days(1);

    // 활성 디바이스 (최근 36h 내 ingest 있던 것만) — 평소 worker.
    let active_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM devices WHERE last_seen_at > now() - interval '36 hours'"
    )
    .fetch_all(pool).await?;

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
             FROM location_records lr
            WHERE NOT EXISTS (
                  SELECT 1 FROM daily_stats ds WHERE ds.device_id = lr.device_id
            )
            LIMIT 50"#,
    ).fetch_all(pool).await?;

    for did in legacy {
        let dates: Vec<NaiveDate> = sqlx::query_scalar(
            r#"SELECT DISTINCT (recorded_at AT TIME ZONE 'Asia/Seoul')::date
                 FROM location_records
                WHERE device_id = $1 AND fix = TRUE"#,
        ).bind(did).fetch_all(pool).await.unwrap_or_default();

        tracing::info!(device_id = did, dates = dates.len(), "daily_stats legacy catchup");
        for date in dates {
            if let Err(e) = aggregate_one(pool, did, date).await {
                tracing::warn!(device_id = did, date = %date, "daily_stats catchup: {e:#}");
            }
        }
    }

    Ok(())
}

pub async fn aggregate_one(pool: &PgPool, device_id: i64, date: NaiveDate) -> anyhow::Result<()> {
    // KST 날짜 → UTC 범위 (KST = UTC+9)
    let start_kst = date.and_hms_opt(0, 0, 0).unwrap();
    let end_kst   = (date + chrono::Duration::days(1)).and_hms_opt(0, 0, 0).unwrap();
    // KST → UTC: -9시간
    let start_utc = start_kst - chrono::Duration::hours(9);
    let end_utc   = end_kst   - chrono::Duration::hours(9);

    // fix=true 점만, 시간순
    let rows: Vec<(DateTime<Utc>, f64, f64)> = sqlx::query_as(
        r#"SELECT recorded_at, lat, lng
             FROM location_records
            WHERE device_id = $1
              AND fix = TRUE
              AND lat IS NOT NULL AND lng IS NOT NULL
              AND recorded_at >= $2 AND recorded_at < $3
            ORDER BY recorded_at"#,
    )
    .bind(device_id)
    .bind(DateTime::<Utc>::from_naive_utc_and_offset(start_utc, Utc))
    .bind(DateTime::<Utc>::from_naive_utc_and_offset(end_utc, Utc))
    .fetch_all(pool)
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
                      user_id = COALESCE(daily_stats.user_id, EXCLUDED.user_id)"#,
        )
        .bind(device_id).bind(date)
        .execute(pool).await?;
        return Ok(());
    }

    let n = rows.len();
    let first_at = rows[0].0;
    let last_at  = rows[n-1].0;
    let duration_s = (last_at - first_at).num_seconds().max(0) as i32;

    let mut distance_m  = 0.0_f64;
    let mut moving_s    = 0_i64;
    let mut stop_count  = 0_i32;
    let mut max_speed   = 0.0_f64;
    let mut speed_sum   = 0.0_f64;
    let mut speed_count = 0_u32;
    let mut stop_window_start: Option<DateTime<Utc>> = None;

    for i in 1..n {
        let (t0, la0, lo0) = rows[i-1];
        let (t1, la1, lo1) = rows[i];
        let dt_s = (t1 - t0).num_seconds().max(0);
        if dt_s == 0 { continue; }
        let d_m = haversine_m(la0, lo0, la1, lo1);
        distance_m += d_m;

        // 정지: 두 점이 50m 이내이고 30초+ 떨어져있음
        let is_stop_step = d_m < STOP_THRESHOLD_M;
        if is_stop_step {
            if stop_window_start.is_none() {
                stop_window_start = Some(t0);
            }
        } else {
            if let Some(start) = stop_window_start {
                let stop_dur = (t0 - start).num_seconds();
                if stop_dur >= STOP_THRESHOLD_S {
                    stop_count += 1;
                }
                stop_window_start = None;
            }
            moving_s += dt_s;
            // 속도 km/h
            let v = (d_m / dt_s as f64) * 3.6;
            speed_sum += v;
            speed_count += 1;
            if v > max_speed { max_speed = v; }
        }
    }
    // 마지막 정지구간 마무리
    if let Some(start) = stop_window_start {
        let stop_dur = (last_at - start).num_seconds();
        if stop_dur >= STOP_THRESHOLD_S {
            stop_count += 1;
        }
    }

    let avg_speed = if speed_count > 0 { speed_sum / speed_count as f64 } else { 0.0 };

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
             user_id       = COALESCE(daily_stats.user_id, EXCLUDED.user_id)"#,
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
    .execute(pool)
    .await?;

    let _ = (date.year(), date.month(), date.day());  // suppress unused
    Ok(())
}
