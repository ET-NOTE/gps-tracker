use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use sqlx::PgPool;

pub const DEFAULT_SLEEP_REPORT_S: i32 = 86400;
pub const PREF_KEY: &str = "device_runtime";
pub fn valid_seconds(seconds: i32) -> bool {
    (60..=86400).contains(&seconds) && seconds % 60 == 0
}
pub fn from_prefs(prefs: &Value, device: i64) -> i32 {
    prefs[PREF_KEY][device.to_string()]["sleep_report_interval_s"]
        .as_i64()
        .and_then(|s| i32::try_from(s).ok())
        .filter(|s| valid_seconds(*s))
        .unwrap_or(DEFAULT_SLEEP_REPORT_S)
}
pub async fn prefs(db: &PgPool, user: i64) -> AppResult<Value> {
    Ok(sqlx::query_scalar("SELECT prefs FROM users WHERE id=$1")
        .bind(user)
        .fetch_one(db)
        .await?)
}
pub async fn save(db: &PgPool, device: i64, user: i64, seconds: i32) -> AppResult<()> {
    if !valid_seconds(seconds) {
        return Err(AppError::BadRequest(
            "정기 보고 주기는 1분~24시간 사이의 분 단위로 설정해 주세요.".into(),
        ));
    }
    let mut tx = db.begin().await?;
    let kind: Option<Option<String>> = sqlx::query_scalar(
        "SELECT device_kind FROM gps_read_devices WHERE id=$1 AND owner_id=$2 FOR UPDATE",
    )
    .bind(device)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(kind) = kind else {
        return Err(AppError::NotFound);
    };
    if kind.as_deref() == Some("phone") {
        return Err(AppError::BadRequest(
            "GPS 단말기에서만 설정할 수 있습니다.".into(),
        ));
    }
    // Lock only this owner's preferences, preserving concurrent edits to other devices.
    let mut value: Value = sqlx::query_scalar("SELECT prefs FROM users WHERE id=$1 FOR UPDATE")
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
    if !value.is_object() {
        value = json!({});
    }
    if !value[PREF_KEY].is_object() {
        value[PREF_KEY] = json!({});
    }
    value[PREF_KEY][device.to_string()] = json!({"sleep_report_interval_s":seconds});
    sqlx::query("UPDATE users SET prefs=$2 WHERE id=$1")
        .bind(user)
        .bind(value)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_whole_minutes_are_accepted_and_preferences_are_device_scoped() {
        for s in [-1, 0, 59, 61, 86401, i32::MAX] {
            assert!(!valid_seconds(s));
        }
        for s in [60, 600, 3600, 86400] {
            assert!(valid_seconds(s));
        }
        let p = json!({"device_runtime":{"7":{"sleep_report_interval_s":600},"8":{"sleep_report_interval_s":90000}}});
        assert_eq!(from_prefs(&p, 7), 600);
        assert_eq!(from_prefs(&p, 8), 86400);
        assert_eq!(from_prefs(&p, 9), 86400);
        assert_eq!(
            from_prefs(
                &json!({"device_runtime":{"7":{"sleep_report_interval_s":"600"}}}),
                7
            ),
            86400
        );
    }
}
