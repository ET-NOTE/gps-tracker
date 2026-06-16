// OTP 검증 헬퍼 — 모든 인증 흐름 (register / phone_add / find_id / password_reset) 이 공유.
//
// 두 가지 보안 속성을 한 번에 보장:
//   1) constant-time 비교 — DB 에서 받은 code 와 사용자 제출 code 를 `subtle::ConstantTimeEq` 로
//      비교해서 timing-leak 차단. 4자리 OTP brute force 가 ~10 시도/자리 로 좁혀지는 것 방지.
//   2) atomic consume — SELECT FOR UPDATE 로 행 잠금 + 한 트랜잭션 안에서 검증·소모.
//      동시에 같은 OTP 로 두 요청이 들어와도 한쪽만 통과 (다른 쪽은 lock 대기 후 consumed 확인 → 거부).
//
// 트레이드오프: 호출자의 tx 와 분리됨. 호출자의 후속 DB 작업이 실패해도 OTP 는 이미 소모.
// → 사용자는 OTP 재발급 필요. 이전엔 호출자 tx 안에서 같이 묶여 자연 rollback 됐지만, race 노출.
// 보안 우선.

use sqlx::PgPool;
use subtle::ConstantTimeEq;

use crate::error::{AppError, AppResult};

/// 가장 최근의 미소모/미만료 OTP 와 사용자 제출 코드를 atomic + constant-time 으로 비교.
///
/// 성공 시 `Ok(otp_id)` — OTP 는 이미 consumed 마킹됨. 호출자가 별도 UPDATE 할 필요 없음.
/// 실패 시 사용자 친화적 메시지로 `AppError::BadRequest`.
///
/// `purposes` — 같은 phone 으로 여러 목적 (예: register/phone_add) 의 OTP 를 발급할 수 있어
/// 허용 목적 리스트를 받음.
pub async fn verify_and_consume(
    pool: &PgPool,
    phone: &str,
    purposes: &[&str],
    submitted_code: &str,
) -> AppResult<i64> {
    let mut tx = pool.begin().await?;

    // FOR UPDATE 로 행 잠금 → 동시 검증 시도 직렬화.
    let otp: Option<(i64, String, i32)> = sqlx::query_as(
        r#"SELECT id, code, attempts FROM otp_codes
            WHERE phone = $1 AND purpose = ANY($2)
              AND consumed_at IS NULL
              AND expires_at > NOW()
            ORDER BY created_at DESC LIMIT 1
            FOR UPDATE"#,
    )
    .bind(phone)
    .bind(purposes)
    .fetch_optional(&mut *tx)
    .await?;

    let (otp_id, code, attempts) = otp.ok_or_else(|| {
        AppError::BadRequest("인증번호를 먼저 요청해주세요 (만료된 경우 재발급)".into())
    })?;

    if attempts >= 5 {
        tx.commit().await?;
        return Err(AppError::BadRequest(
            "인증 시도 횟수 초과 — 인증번호를 다시 받아주세요".into(),
        ));
    }

    // constant-time 비교 — bytes 길이가 달라도 ct_eq 가 false 를 반환 (constant-time 적용).
    let submitted = submitted_code.trim();
    let matches: bool = code
        .as_bytes()
        .ct_eq(submitted.as_bytes())
        .unwrap_u8()
        == 1;

    if !matches {
        sqlx::query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1")
            .bind(otp_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(AppError::BadRequest("인증번호가 일치하지 않습니다".into()));
    }

    // 일치 — 같은 tx 안에서 consume. FOR UPDATE 잠금 덕에 race 없음.
    sqlx::query("UPDATE otp_codes SET consumed_at = NOW(), verified = TRUE WHERE id = $1")
        .bind(otp_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(otp_id)
}
