// 데이터 정합 housekeeping — 24시간 주기.
// 정리 대상:
//   연결 해제 때 보관을 선택한 사용자 기록은 자동 삭제하지 않는다.
//   2) share_tokens — revoked / expired 30일 이상 지난 것
//
// 보관 후 연결 해제한 기록은 명시적 삭제 또는 회원탈퇴로만 제거한다.
// 소유자가 바뀌어 조회할 수 없는 기록도 이전 사용자의 보관 선택을 존중한다.
use sqlx::PgPool;
use std::time::Duration;

const RUN_INTERVAL: Duration = Duration::from_secs(24 * 3600);
const STARTUP_DELAY: Duration = Duration::from_secs(60); // 부팅 직후 안정화 후 시작

pub fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        tracing::info!("housekeeping worker: started (every 24h)");
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if let Err(e) = run_once(&pool).await {
                tracing::warn!("housekeeping error: {e:#}");
            }
            tokio::time::sleep(RUN_INTERVAL).await;
        }
    });
}

async fn run_once(pool: &PgPool) -> anyhow::Result<()> {
    // 2) share_tokens — revoke / expire 후 30일 지난 것
    let r = sqlx::query(
        "DELETE FROM share_tokens \
          WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') \
             OR (expires_at < now() - interval '30 days')",
    )
    .execute(pool)
    .await?;
    if r.rows_affected() > 0 {
        tracing::info!(
            deleted = r.rows_affected(),
            "housekeeping: stale share tokens cleaned"
        );
    }

    // 3) refresh_tokens — 만료 후 7일 지난 것 (revoke 됐든 안 됐든).
    // stateless rotation 특성상 abandoned 세션의 마지막 토큰이 revoke 없이
    // 만료까지 남는데, 그 후로 영구히 적재되지 않도록 정리.
    // 7일 grace — 시계 어긋남이나 디버깅용 history 짧게 보존.
    let r = sqlx::query(
        "DELETE FROM refresh_tokens \
          WHERE expires_at < now() - interval '7 days'",
    )
    .execute(pool)
    .await?;
    if r.rows_affected() > 0 {
        tracing::info!(
            deleted = r.rows_affected(),
            "housekeeping: stale refresh tokens cleaned"
        );
    }

    // 4) geofence_states — 펜스가 삭제되거나 사용자가 디바이스 unpair 한 후 남는 stale row.
    // FK CASCADE 가 펜스 삭제는 잡지만 device 와의 관계는 없어서 device unpair 만으론 안 지워짐.
    // 90일 안에 transition 없고 펜스/디바이스 한쪽이 사라졌으면 정리.
    let r = sqlx::query(
        "DELETE FROM geofence_states s \
          WHERE (NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = s.device_id) \
              OR NOT EXISTS (SELECT 1 FROM geofences g WHERE g.id = s.geofence_id)) \
            AND (s.last_transition_at IS NULL OR s.last_transition_at < now() - interval '90 days')"
    ).execute(pool).await?;
    if r.rows_affected() > 0 {
        tracing::info!(
            deleted = r.rows_affected(),
            "housekeeping: orphan geofence_states cleaned"
        );
    }

    // 5) device_audit_log — wipe 시 명시적으로 비우지만, 디바이스 자체가 사라진 경우
    // CASCADE 가 잡음. 그 외에 너무 오래된 (1년+) 감사 기록은 디스크 절약 차원에서 정리.
    let r =
        sqlx::query("DELETE FROM device_audit_log WHERE occurred_at < now() - interval '365 days'")
            .execute(pool)
            .await?;
    if r.rows_affected() > 0 {
        tracing::info!(
            deleted = r.rows_affected(),
            "housekeeping: ancient device audit cleaned"
        );
    }

    // 6) (R6 PIPA) 렌트카 임차인 개인정보 자동 파기.
    //   반납 완료 (returned) 이후 6개월 초과 → renter_id_last4 NULL (신분증 뒤4)
    //   반납 완료 이후 3년 초과 → renter_phone NULL (연락처)
    //   계약·매출 통계 자체는 유지. PII 만 최소화.
    let r = sqlx::query(
        "UPDATE rental_contracts
            SET renter_id_last4 = NULL
          WHERE status = 'returned'
            AND settled_at IS NOT NULL
            AND settled_at < NOW() - interval '180 days'
            AND renter_id_last4 IS NOT NULL",
    )
    .execute(pool)
    .await?;
    if r.rows_affected() > 0 {
        tracing::info!(
            purged = r.rows_affected(),
            "housekeeping: PIPA renter_id_last4 purged (>=180d after return)"
        );
    }
    let r = sqlx::query(
        "UPDATE rental_contracts
            SET renter_phone = NULL
          WHERE status = 'returned'
            AND settled_at IS NOT NULL
            AND settled_at < NOW() - interval '1095 days'
            AND renter_phone IS NOT NULL",
    )
    .execute(pool)
    .await?;
    if r.rows_affected() > 0 {
        tracing::info!(
            purged = r.rows_affected(),
            "housekeeping: PIPA renter_phone purged (>=3y after return)"
        );
    }

    // 7) login_attempts — brute-force 카운트용. 창(15분) 훨씬 지난 것 정리 (1일 grace).
    let r = sqlx::query("DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'")
        .execute(pool)
        .await?;
    if r.rows_affected() > 0 {
        tracing::info!(
            deleted = r.rows_affected(),
            "housekeeping: old login_attempts cleaned"
        );
    }

    Ok(())
}
