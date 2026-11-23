//! Company operating policy: expense approval, trip record rules and the
//! reception delay used to mark a terminal as needing attention.
use crate::{
    auth::{
        fleet::{self, FleetScope},
        AuthUser,
    },
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{extract::State, routing::get, Extension, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new().route("/corporate/operating-policy", get(policy).put(save))
}

pub const DEFAULT_OFFLINE_MINUTES: i32 = 10;

#[derive(Clone, Debug, PartialEq, Serialize, sqlx::FromRow)]
pub struct OperatingPolicy {
    pub expense_approval_required: bool,
    pub trip_purpose_required: bool,
    pub personal_use_allowed: bool,
    pub review_after_trip: bool,
    pub offline_minutes: i32,
    pub revision: i64,
    pub updated_at: Option<DateTime<Utc>>,
}

impl Default for OperatingPolicy {
    fn default() -> Self {
        Self {
            expense_approval_required: true,
            trip_purpose_required: false,
            personal_use_allowed: true,
            review_after_trip: true,
            offline_minutes: DEFAULT_OFFLINE_MINUTES,
            revision: 0,
            updated_at: None,
        }
    }
}

impl OperatingPolicy {
    /// Commute is the only stored purpose that is not company business.
    pub fn check_purpose(&self, purpose: Option<&str>) -> AppResult<()> {
        if !self.personal_use_allowed && purpose == Some("commute") {
            return Err(AppError::BadRequest(
                "개인 용도 이용이 허용되지 않은 회사입니다. 업무 또는 기타 용무를 선택해 주세요."
                    .into(),
            ));
        }
        Ok(())
    }
}

pub async fn read<'e>(
    db: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    owner: i64,
) -> AppResult<OperatingPolicy> {
    let stored = sqlx::query_as(
        "SELECT expense_approval_required, trip_purpose_required, personal_use_allowed,
                review_after_trip, offline_minutes, revision, updated_at
         FROM fleet_operating_policy WHERE owner_id = $1",
    )
    .bind(owner)
    .fetch_optional(db)
    .await?;
    Ok(stored.unwrap_or_default())
}

async fn principal(
    state: &AppState,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<FleetScope> {
    match scope {
        Some(Extension(s)) => Ok(s),
        None => fleet::load(state, user.user_id, user.user_id).await,
    }
}

async fn policy(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
) -> AppResult<Json<OperatingPolicy>> {
    let scope = principal(&state, user, scope).await?;
    Ok(Json(read(&state.db, scope.owner).await?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Change {
    expense_approval_required: bool,
    trip_purpose_required: bool,
    personal_use_allowed: bool,
    review_after_trip: bool,
    offline_minutes: i32,
    revision: i64,
}

impl Change {
    fn validate(&self) -> AppResult<()> {
        if !(1..=240).contains(&self.offline_minutes) {
            return Err(AppError::BadRequest(
                "수신 지연 판단 시간은 1분에서 240분 사이로 입력해 주세요.".into(),
            ));
        }
        Ok(())
    }
    fn same_as(&self, p: &OperatingPolicy) -> bool {
        self.expense_approval_required == p.expense_approval_required
            && self.trip_purpose_required == p.trip_purpose_required
            && self.personal_use_allowed == p.personal_use_allowed
            && self.review_after_trip == p.review_after_trip
            && self.offline_minutes == p.offline_minutes
    }
}

async fn save(
    State(state): State<AppState>,
    user: AuthUser,
    scope: Option<Extension<FleetScope>>,
    Json(next): Json<Change>,
) -> AppResult<Json<OperatingPolicy>> {
    let scope = principal(&state, user, scope).await?;
    if scope.actor != scope.owner {
        return Err(AppError::Forbidden);
    }
    next.validate()?;
    let owner = scope.owner;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-operating-policy:{owner}"))
        .execute(&mut *tx)
        .await?;
    let previous = read(&mut *tx, owner).await?;
    if previous.revision != next.revision {
        return Err(AppError::Conflict(
            "다른 곳에서 운영 정책이 변경되었습니다. 다시 조회해 주세요.".into(),
        ));
    }
    if next.same_as(&previous) {
        return Ok(Json(previous));
    }
    let saved: OperatingPolicy = sqlx::query_as(
        "INSERT INTO fleet_operating_policy(owner_id, expense_approval_required, trip_purpose_required,
             personal_use_allowed, review_after_trip, offline_minutes, revision)
         VALUES ($1,$2,$3,$4,$5,$6,1)
         ON CONFLICT(owner_id) DO UPDATE
         SET expense_approval_required=excluded.expense_approval_required,
             trip_purpose_required=excluded.trip_purpose_required,
             personal_use_allowed=excluded.personal_use_allowed,
             review_after_trip=excluded.review_after_trip,
             offline_minutes=excluded.offline_minutes,
             revision=fleet_operating_policy.revision+1,
             updated_at=clock_timestamp()
         RETURNING expense_approval_required, trip_purpose_required, personal_use_allowed,
                   review_after_trip, offline_minutes, revision, updated_at",
    )
    .bind(owner)
    .bind(next.expense_approval_required)
    .bind(next.trip_purpose_required)
    .bind(next.personal_use_allowed)
    .bind(next.review_after_trip)
    .bind(next.offline_minutes)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO fleet_team_audit(owner_id,actor_id,action,before_value,after_value)
         VALUES ($1,$1,'operating_policy',$2,$3)",
    )
    .bind(owner)
    .bind(serde_json::json!(previous))
    .bind(serde_json::json!(saved))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(saved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_migration() {
        let p = OperatingPolicy::default();
        assert!(p.expense_approval_required);
        assert!(!p.trip_purpose_required);
        assert!(p.personal_use_allowed);
        assert!(p.review_after_trip);
        assert_eq!(p.offline_minutes, 10);
        assert_eq!(p.revision, 0);
        let migration = include_str!("../../migrations/0134_fleet_operating_policy.sql");
        assert!(migration.contains("offline_minutes integer NOT NULL DEFAULT 10"));
    }

    #[test]
    fn offline_minutes_are_bounded_and_unknown_fields_rejected() {
        let change = |m: i32| Change {
            expense_approval_required: true,
            trip_purpose_required: false,
            personal_use_allowed: true,
            review_after_trip: true,
            offline_minutes: m,
            revision: 0,
        };
        assert!(change(0).validate().is_err());
        assert!(change(241).validate().is_err());
        assert!(change(1).validate().is_ok());
        assert!(change(240).validate().is_ok());
        assert!(change(10).same_as(&OperatingPolicy::default()));
        assert!(!change(11).same_as(&OperatingPolicy::default()));
        let body = json!({"expense_approval_required":true,"trip_purpose_required":false,
            "personal_use_allowed":true,"review_after_trip":true,"offline_minutes":10,"revision":0,"owner_id":1});
        assert!(serde_json::from_value::<Change>(body).is_err());
    }

    #[test]
    fn commute_is_rejected_only_when_personal_use_is_off() {
        let mut p = OperatingPolicy::default();
        assert!(p.check_purpose(Some("commute")).is_ok());
        p.personal_use_allowed = false;
        assert!(p.check_purpose(Some("commute")).is_err());
        for ok in [Some("business"), Some("other"), Some("unspecified"), None] {
            assert!(p.check_purpose(ok).is_ok());
        }
    }
}
