// 일별 운행 통계 집계 워커.
// 현재 날짜와 수신 시 무효화된 날짜를 다시 계산한다.
// 과거 집계 누락은 소유자별 원본을 조금씩 살펴 durable queue에 먼저 기록한다.
//
// 거리 계산: 인접 fix 점 간 haversine.
// 정지 구간 식별: 5분 이상 같은 위치(반경 50m) 머무름.
// 평균 속도: 총거리 / moving_s (s>0 일 때).

use chrono::{DateTime, NaiveDate, Utc};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::time::sleep;

const STOP_THRESHOLD_M: f64 = 50.0;
const STOP_THRESHOLD_S: i64 = 5 * 60;
const REPAIR_DEVICES_PER_POLL: i64 = 10;
const REPAIR_RECORDS_PER_DEVICE: i64 = 1000;

#[cfg(test)]
#[path = "stats_repair_tests.rs"]
mod repair_tests;

#[derive(Default)]
struct RepairScan {
    after_device: i64,
    pages: HashMap<i64, RepairCursor>,
}

struct RepairCursor {
    owner_id: i64,
    after: (DateTime<Utc>, String),
}

const EARTH_R_M: f64 = 6_371_000.0;
pub(crate) fn haversine_m(la1: f64, lo1: f64, la2: f64, lo2: f64) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let dla = (la2 - la1) * to_rad;
    let dlo = (lo2 - lo1) * to_rad;
    let a = (dla / 2.0).sin().powi(2)
        + (la1 * to_rad).cos() * (la2 * to_rad).cos() * (dlo / 2.0).sin().powi(2);
    2.0 * EARTH_R_M * a.sqrt().asin()
}

pub fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        let interval = Duration::from_secs(
            std::env::var("GPS_STATS_POLL_SECONDS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(300)
                .clamp(5, 3600),
        );
        tracing::info!(seconds = interval.as_secs(), "daily_stats worker started");
        let mut repair = RepairScan::default();
        loop {
            if let Err(e) = run_aggregation(&pool, &mut repair).await {
                tracing::warn!("daily_stats: {e:#}");
            }
            sleep(interval).await;
        }
    });
}

async fn run_aggregation(pool: &PgPool, repair: &mut RepairScan) -> anyhow::Result<()> {
    // Discovery failure must not stop existing durable jobs or current-day updates.
    if let Err(error) = discover_missing(pool, repair).await {
        tracing::warn!("daily_stats repair discovery: {error:#}");
    }
    process_queue(pool).await?;
    // 오늘 / 어제 (KST 기준)
    let now_kst = Utc::now() + chrono::Duration::hours(9);
    let today = now_kst.date_naive();
    let yest = today - chrono::Duration::days(1);

    let active_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM gps_read_devices WHERE owner_id IS NOT NULL AND last_seen_at > now() - interval '36 hours'",
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
    Ok(())
}

async fn process_queue(pool: &PgPool) -> anyhow::Result<()> {
    let queued: Vec<(i64, NaiveDate, i64)> = sqlx::query_as(
        "SELECT device_id,date,generation FROM stats_rebuild_queue WHERE next_attempt_at<=now() ORDER BY date,device_id LIMIT 100",
    )
    .fetch_all(pool)
    .await?;
    for (did, date, generation) in queued {
        if let Err(error) = aggregate_one(pool, did, date).await {
            tracing::warn!(device_id=did, date=%date, "daily_stats queued job: {error:#}");
            sqlx::query("UPDATE stats_rebuild_queue SET attempts=attempts+1,
                last_error=left($4,500),next_attempt_at=now()+LEAST(1800,60*(attempts+1))*interval '1 second'
                WHERE device_id=$1 AND date=$2 AND generation=$3")
                .bind(did).bind(date).bind(generation).bind(error.to_string())
                .execute(pool).await?;
            continue;
        }
        sqlx::query(
            "DELETE FROM stats_rebuild_queue WHERE device_id=$1 AND date=$2 AND generation=$3",
        )
        .bind(did)
        .bind(date)
        .bind(generation)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn discover_missing(pool: &PgPool, scan: &mut RepairScan) -> anyhow::Result<()> {
    let select =
        "SELECT id FROM gps_read_devices WHERE owner_id IS NOT NULL AND id>$1 ORDER BY id LIMIT $2";
    let mut ids: Vec<i64> = sqlx::query_scalar(select)
        .bind(scan.after_device)
        .bind(REPAIR_DEVICES_PER_POLL)
        .fetch_all(pool)
        .await?;
    if ids.is_empty() {
        scan.after_device = 0;
        // Drop cursors for removed/unlinked devices; cursor storage is bounded by owned devices.
        let retained: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM gps_read_devices WHERE owner_id IS NOT NULL AND id=ANY($1)",
        )
        .bind(scan.pages.keys().copied().collect::<Vec<_>>())
        .fetch_all(pool)
        .await?;
        let retained: HashSet<_> = retained.into_iter().collect();
        scan.pages.retain(|id, _| retained.contains(id));
        ids = sqlx::query_scalar(select)
            .bind(0_i64)
            .bind(REPAIR_DEVICES_PER_POLL)
            .fetch_all(pool)
            .await?;
    }
    for did in ids {
        // Rotate even on failure so one paused/locked/bad device cannot starve later devices.
        scan.after_device = did;
        match discover_page(pool, did, scan.pages.get(&did)).await {
            Ok(Some(cursor)) => {
                scan.pages.insert(did, cursor);
            }
            Ok(None) => {
                scan.pages.remove(&did);
            }
            Err(error) => tracing::warn!(device_id = did, "daily_stats repair page: {error:#}"),
        }
    }
    Ok(())
}

async fn discover_page(
    pool: &PgPool,
    device_id: i64,
    cursor: Option<&RepairCursor>,
) -> anyhow::Result<Option<RepairCursor>> {
    let _privacy = super::privacy_lifecycle::background(
        super::access_ledger::Target::Device(device_id),
        false,
    )
    .await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='1s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let owner: Option<i64> =
        sqlx::query_scalar("SELECT owner_id FROM gps_read_devices WHERE id=$1 FOR UPDATE")
            .bind(device_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    let Some(owner_id) = owner else {
        return Ok(None);
    };
    let after = cursor.filter(|c| c.owner_id == owner_id).map(|c| &c.after);
    // Materialize only a bounded source page BEFORE decrypting its batch dates.
    // The two-column cursor preserves sources sharing an anchor timestamp.
    let rows: Vec<(DateTime<Utc>, String, Vec<NaiveDate>)> = sqlx::query_as(
        r#"WITH page AS MATERIALIZED (
            SELECT recorded_at,source,fix,fixes_jsonb FROM gps_read_location_records
            WHERE device_id=$1 AND user_id=$2
              AND ($3::timestamptz IS NULL OR (recorded_at,source)>($3,$4::text))
            ORDER BY recorded_at,source LIMIT $5
        ) SELECT recorded_at,source,location_fix_dates(recorded_at,fixes_jsonb,fix)
          FROM page ORDER BY recorded_at,source"#,
    )
    .bind(device_id)
    .bind(owner_id)
    .bind(after.map(|a| a.0))
    .bind(after.map(|a| a.1.as_str()))
    .bind(REPAIR_RECORDS_PER_DEVICE)
    .fetch_all(&mut *tx)
    .await?;
    let dates: HashSet<NaiveDate> = rows.iter().flat_map(|r| r.2.iter().copied()).collect();
    let added = sqlx::query(
        r#"INSERT INTO stats_rebuild_queue(device_id,date)
        SELECT $1,d FROM unnest($3::date[]) dates(d)
        WHERE NOT EXISTS(SELECT 1 FROM daily_stats s WHERE s.device_id=$1 AND s.user_id=$2 AND s.date=d)
        ON CONFLICT(device_id,date) DO NOTHING"#)
        .bind(device_id).bind(owner_id).bind(dates.into_iter().collect::<Vec<_>>())
        .execute(&mut *tx).await?.rows_affected();
    // Queue commit precedes the in-memory cursor. Restart re-scans safely, never loses jobs.
    tx.commit().await?;
    tracing::debug!(
        device_id,
        records = rows.len(),
        queued = added,
        "daily_stats repair page committed"
    );
    Ok(if rows.len() == REPAIR_RECORDS_PER_DEVICE as usize {
        rows.last().map(|r| RepairCursor {
            owner_id,
            after: (r.0, r.1.clone()),
        })
    } else {
        None
    })
}

pub async fn aggregate_one(pool: &PgPool, device_id: i64, date: NaiveDate) -> anyhow::Result<()> {
    let _privacy = super::privacy_lifecycle::background(
        super::access_ledger::Target::Device(device_id),
        false,
    )
    .await?;
    let mut tx = pool.begin().await?;
    let owner: Option<i64> =
        sqlx::query_scalar("SELECT owner_id FROM gps_read_devices WHERE id=$1 FOR UPDATE")
            .bind(device_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    if owner.is_none() {
        return Ok(());
    }
    // KST 날짜 → UTC 범위 (KST = UTC+9)
    let start_kst = date.and_hms_opt(0, 0, 0).unwrap();
    let end_kst = (date + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap();
    // KST → UTC: -9시간
    let start_utc = start_kst - chrono::Duration::hours(9);
    let end_utc = end_kst - chrono::Duration::hours(9);

    // fix=true 점만, 시간순
    let points: Vec<(DateTime<Utc>, f64, f64, Option<f32>)> = sqlx::query_as(
        // [뿌리 B 2026-08-14] 현재 owner 데이터만 집계 — 재페어링된 device 에서 이전 owner 의
        //   fix 까지 합산해 통계 혼입되던 것 차단 (upsert user_id 도 EXCLUDED 로 현재 owner 반영).
        r#"SELECT DISTINCT ON(recorded_at) recorded_at, lat, lng, speed_kmh
             FROM location_speed_metrics_between($1,(SELECT owner_id FROM gps_read_devices WHERE id=$1),$2,$3)
            WHERE device_id = $1
              AND user_id = (SELECT owner_id FROM gps_read_devices WHERE id = $1)
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

    let rows: Vec<_> = points.iter().map(|p| (p.0, p.1, p.2)).collect();
    if rows.is_empty() {
        // 기존 row 가 있으면 0으로 갱신 (디바이스가 데이터 0건인 날)
        sqlx::query(
            r#"INSERT INTO daily_stats (device_id, date, fix_count, distance_m, duration_s, moving_s, stop_count, max_speed_kmh, avg_speed_kmh, first_fix_at, last_fix_at, updated_at, user_id)
               VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, now(),
                       (SELECT owner_id FROM gps_read_devices WHERE id = $1))
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
        max_speed: _,
        avg_speed,
    } = calculate_metrics(&rows);
    let max_speed = points.iter().filter_map(|p| p.3).fold(0.0_f32, f32::max);

    sqlx::query(
        r#"INSERT INTO daily_stats
             (device_id, date, fix_count, distance_m, duration_s, moving_s, stop_count,
              max_speed_kmh, avg_speed_kmh, first_fix_at, last_fix_at, updated_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(),
                   (SELECT owner_id FROM gps_read_devices WHERE id = $1))
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
    .bind(max_speed)
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
