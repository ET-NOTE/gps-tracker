use crate::error::{AppError, AppResult};
use sqlx::PgPool;

/// 1NCE's 19 digit canonical number and the 20 digit printed variant identify one SIM.
pub fn canonical(value: &str) -> AppResult<String> {
    let value = value.trim();
    if !matches!(value.len(), 19 | 20) || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::BadRequest(
            "SIM 전체 번호 19~20자리를 확인해 주세요.".into(),
        ));
    }
    Ok(value[..19].to_owned())
}

pub async fn find(db: &PgPool, input: &str) -> AppResult<Option<i64>> {
    let value = input.trim();
    if !(8..=20).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::BadRequest(
            "SIM 번호는 숫자 8~20자리로 입력해 주세요.".into(),
        ));
    }
    let rows: Vec<i64> = if value.len() >= 19 {
        sqlx::query_scalar("SELECT id FROM devices WHERE left(iccid,19)=$1 AND device_kind IS DISTINCT FROM 'phone'")
            .bind(canonical(value)?).fetch_all(db).await?
    } else {
        sqlx::query_scalar("SELECT id FROM devices WHERE (iccid LIKE $1 OR left(iccid,19) LIKE $1) AND device_kind IS DISTINCT FROM 'phone'")
            .bind(format!("%{value}")).fetch_all(db).await?
    };
    match rows.as_slice() {
        [] => Ok(None),
        [id] => Ok(Some(*id)),
        _ => Err(AppError::BadRequest(
            "SIM 끝번호가 중복됩니다. SIM 전체 번호를 입력해 주세요.".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_sim_identity_ignores_only_printed_twentieth_digit() {
        assert_eq!(
            canonical("12345678901234567890").unwrap(),
            canonical("1234567890123456789").unwrap()
        );
        assert!(canonical("12345678").is_err());
        assert!(canonical("123456789012345678x").is_err());
    }
}
