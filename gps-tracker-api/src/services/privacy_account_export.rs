//! Explicit account-only projections. Never join present SIM ownership into historical transactions.
use super::privacy_location_facts;
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::{Postgres, Transaction};

pub const SECTIONS: [&str; 4] = [
    "contact_settings",
    "transactions",
    "activity_metadata",
    privacy_location_facts::SECTION,
];
pub fn valid_sections(sections: &[String]) -> bool {
    sections.len() <= SECTIONS.len()
        && sections.iter().all(|s| SECTIONS.contains(&s.as_str()))
        && sections
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            == sections.len()
}

fn preferences(raw: &Value) -> Value {
    let mut out = Map::new();
    for key in [
        "lab_phone_tracker",
        "lab_cycle_seeker",
        "lab_first_view_summary",
        "pair_tutorial_seen",
    ] {
        if let Some(value) = raw.get(key).and_then(Value::as_bool) {
            out.insert(key.into(), json!(value));
        }
    }
    if let Some(theme @ ("light" | "dark")) = raw.get("theme").and_then(Value::as_str) {
        out.insert("theme".into(), json!(theme));
    }
    let mut seeker = Map::new();
    for key in ["speed_color", "show_stops"] {
        if let Some(value) = raw
            .get("seeker")
            .and_then(|s| s.get(key))
            .and_then(Value::as_bool)
        {
            seeker.insert(key.into(), json!(value));
        }
    }
    if !seeker.is_empty() {
        out.insert("seeker".into(), Value::Object(seeker));
    }
    Value::Object(out)
}

// LIMIT N+1 is deliberate: oversized sections fail together, never silently truncate.
async fn rows(
    tx: &mut Transaction<'_, Postgres>,
    uid: i64,
    query: &str,
    limit: usize,
) -> AppResult<Value> {
    let values: Vec<Value> = sqlx::query_scalar(query)
        .bind(uid)
        .fetch_all(&mut **tx)
        .await?;
    if values.len() > limit {
        return Err(AppError::Conflict(
            "선택한 자료의 제공 한도를 초과했습니다. 담당자에게 범위를 나눈 제공을 요청해 주세요."
                .into(),
        ));
    }
    Ok(json!(values))
}

pub async fn export(
    tx: &mut Transaction<'_, Postgres>,
    uid: i64,
    sections: &[String],
    facts_period: Option<(DateTime<Utc>, DateTime<Utc>)>,
) -> AppResult<Value> {
    if !valid_sections(sections) {
        return Err(AppError::Conflict("발급 범위를 다시 확인해 주세요.".into()));
    }
    let mut out = Map::new();
    for section in sections {
        let value = match section.as_str() {
            "contact_settings" => {
                let phones = rows(tx,uid,"SELECT jsonb_build_object('phone',phone,'is_verified',is_verified,'is_primary',is_primary,'created_at',created_at,'verified_at',verified_at) FROM user_phones WHERE user_id=$1 ORDER BY id LIMIT 201",200).await?;
                let prefs: Value = sqlx::query_scalar("SELECT prefs FROM users WHERE id=$1")
                    .bind(uid)
                    .fetch_one(&mut **tx)
                    .await?;
                let notification: Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('motion_alert',motion_alert,'low_batt_alert',low_batt_alert,'offline_alert',offline_alert,'geofence_alert',geofence_alert,'low_batt_threshold_mv',low_batt_threshold_mv,'offline_minutes',offline_minutes,'device_health_alert',device_health_alert,'lost_alert',lost_alert,'signal_loss_alert',signal_loss_alert,'online_alert',online_alert,'sleep_alert',sleep_alert,'wake_alert',wake_alert,'signal_loss_minutes',signal_loss_minutes,'cycle_first_fix_alert',cycle_first_fix_alert,'reservation_alert',reservation_alert,'rental_alert',rental_alert,'updated_at',updated_at) FROM notification_settings WHERE user_id=$1").bind(uid).fetch_optional(&mut **tx).await?;
                json!({"phones":phones,"display_preferences":preferences(&prefs),"notification_settings":notification,"notice":"저장된 추가 연락처, 화면·실험실·알림 설정입니다. 장치별 설정, 선택·열람 이력, 알 수 없는 설정은 별도 검토 대상입니다. 없는 값은 미저장을 뜻하며 기본값을 추정하지 않습니다."})
            }
            "transactions" => {
                let credits: i64 = sqlx::query_scalar("SELECT credits FROM users WHERE id=$1")
                    .bind(uid)
                    .fetch_one(&mut **tx)
                    .await?;
                let ledger=rows(tx,uid,"SELECT jsonb_build_object('id',id,'delta_points',delta,'balance_points',balance,'reason',CASE WHEN reason IN ('topup','ai_analysis','sim_topup','sim_topup_consume','refund','admin_grant','manual_grant','subscription') THEN reason ELSE 'other_review_required' END,'created_at',created_at) FROM credit_log WHERE user_id=$1 ORDER BY id LIMIT 1001",1000).await?;
                let payments=rows(tx,uid,"SELECT jsonb_build_object('id',id,'amount',amount,'currency',CASE WHEN currency='KRW' THEN 'KRW' ELSE 'other_review_required' END,'status',status,'created_at',created_at,'issued_at',issued_at,'confirmed_at',confirmed_at) FROM payment_orders WHERE user_id=$1 ORDER BY id LIMIT 1001",1000).await?;
                let topups=rows(tx,uid,"SELECT jsonb_build_object('id',id,'amount_points',amount,'status',status,'requested_at',requested_at,'processed_at',processed_at) FROM credit_topup_requests WHERE user_id=$1 ORDER BY id LIMIT 1001",1000).await?;
                let sims=rows(tx,uid,"SELECT jsonb_build_object('id',id,'data_mb',data_mb,'cost_points',cost_credits,'status',status,'requested_at',requested_at,'processed_at',processed_at) FROM sim_topup_requests WHERE user_id=$1 ORDER BY id LIMIT 1001",1000).await?;
                let subscriptions=rows(tx,uid,"SELECT jsonb_build_object('id',id,'kind',CASE WHEN kind IN ('corporate_report','rentcar','delivery','rental','rentcar_report','delivery_report') THEN kind ELSE 'other_review_required' END,'starts_at',starts_at,'expires_at',expires_at,'paid_points',paid_credits,'created_at',created_at) FROM subscriptions WHERE user_id=$1 ORDER BY id LIMIT 1001",1000).await?;
                json!({"current_balance_points":credits,"point_ledger":ledger,"payments":payments,"point_topup_requests":topups,"sim_topup_requests":sims,"subscriptions":subscriptions,"notice":"본인 계정의 거래 요약입니다. 결제·충전 요청과 포인트 원장은 같은 거래의 처리 단계일 수 있으므로 합산하지 마세요. 결제 비밀값·가상계좌·영수증 링크·내부 메모·현재 단말기 및 SIM 정보는 제외합니다. 분류가 other_review_required인 항목은 별도 확인이 필요합니다."})
            }
            "activity_metadata" => {
                let chat=rows(tx,uid,"SELECT jsonb_build_object('id',m.id,'sender_role',m.sender_role,'created_at',m.created_at) FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.user_id=$1 ORDER BY m.id LIMIT 1001",1000).await?;
                let analyses=rows(tx,uid,"SELECT jsonb_build_object('id',id,'target_date',target_date,'cost_points',cost_credits,'created_at',created_at) FROM ai_analyses WHERE user_id=$1 ORDER BY id LIMIT 1001",1000).await?;
                let usage=rows(tx,uid,"SELECT jsonb_build_object('id',id,'used_at',used_at,'tokens_in',tokens_in,'tokens_out',tokens_out) FROM ai_usage_log WHERE user_id=$1 ORDER BY id LIMIT 1001",1000).await?;
                json!({"chat_message_metadata":chat,"ai_analysis_metadata":analyses,"ai_usage_metadata":usage,"notice":"이용 시각·역할·사용량만 포함합니다. 채팅·AI 본문, 첨부, 관리자·장치 식별자, 원시 요청 및 서버 로그는 별도 검토 대상입니다. 사용량과 분석 기록은 서로 중복될 수 있습니다."})
            }
            privacy_location_facts::SECTION => {
                // A stored grant has the period exactly when it has this section.
                let (from, until) = facts_period
                    .ok_or_else(|| AppError::Conflict("발급 범위를 다시 확인해 주세요.".into()))?;
                privacy_location_facts::export(tx, uid, from, until).await?
            }
            _ => unreachable!(),
        };
        out.insert(section.clone(), value);
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_must_be_explicit_known_and_unique() {
        assert!(valid_sections(&[]));
        assert!(valid_sections(&SECTIONS.map(str::to_string)));
        assert!(!valid_sections(&[
            "transactions".into(),
            "transactions".into()
        ]));
        assert!(!valid_sections(&["raw_user".into()]));
    }
    #[test]
    fn nested_preferences_and_invalid_types_cannot_leak() {
        assert_eq!(
            preferences(
                &json!({"theme":"dark","lab_phone_tracker":true,"lab_cycle_seeker":{"token":"secret"},"seeker":{"show_stops":false,"speed_color":"secret","token":"secret"},"device_colors":{"2":"secret"},"token":"secret"})
            ),
            json!({"theme":"dark","lab_phone_tracker":true,"seeker":{"show_stops":false}})
        );
        assert_eq!(preferences(&json!({"theme":"secret"})), json!({}));
    }
}
