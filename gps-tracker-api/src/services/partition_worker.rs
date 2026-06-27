// Monthly partition 자동 생성 — 24시간 주기.
//
// location_records 가 RANGE (recorded_at) 로 partitioned. 매월 새 partition 이 필요한데,
// 누락되면 default partition 으로 fallback → 옛 데이터와 섞여 분할 효과 사라짐.
//
// 이 worker 가 매일 한 번 다음 N개월 partition 이 모두 있는지 확인 + 없으면 생성.
// CREATE TABLE IF NOT EXISTS 라 안전 (이미 있으면 skip).
//
// 이름 규칙: location_records_y{YYYY}m{MM} (예: location_records_y2026m07).
use sqlx::PgPool;
use std::time::Duration;

const RUN_INTERVAL: Duration = Duration::from_secs(24 * 3600);
const STARTUP_DELAY:  Duration = Duration::from_secs(120);   // 부팅 직후 안정화 후 시작
const AHEAD_MONTHS: i32 = 3;   // 미래 N개월 미리 생성

pub fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        tracing::info!("partition worker: started (every 24h, ahead={AHEAD_MONTHS}mo)");
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if let Err(e) = run_once(&pool).await {
                tracing::warn!("partition worker error: {e:#}");
            }
            tokio::time::sleep(RUN_INTERVAL).await;
        }
    });
}

async fn run_once(pool: &PgPool) -> anyhow::Result<()> {
    let mut created: Vec<String> = Vec::new();
    for i in 0..=AHEAD_MONTHS {
        let sql = format!(
            r#"DO $$
                DECLARE
                    m_start DATE := date_trunc('month', CURRENT_DATE + interval '{i} month')::date;
                    m_end   DATE := m_start + interval '1 month';
                    pname   TEXT := format('location_records_y%sm%s',
                                            to_char(m_start, 'YYYY'),
                                            to_char(m_start, 'MM'));
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_class WHERE relname = pname
                    ) THEN
                        EXECUTE format(
                            'CREATE TABLE %I PARTITION OF location_records FOR VALUES FROM (%L) TO (%L)',
                            pname, m_start, m_end
                        );
                        RAISE NOTICE 'partition created: %', pname;
                    END IF;
                END $$"#
        );
        match sqlx::query(&sql).execute(pool).await {
            Ok(_)  => created.push(format!("+{i}mo")),
            Err(e) => tracing::warn!("partition worker: month +{i} skip ({e:#})"),
        }
    }
    tracing::debug!(months = ?created, "partition worker: tick complete");
    Ok(())
}
