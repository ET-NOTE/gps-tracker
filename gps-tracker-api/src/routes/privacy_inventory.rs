//! Metadata-only review of records whose collection-time account is absent.
//! Current device ownership is context, never evidence of historical ownership.
use crate::{
    auth::AdminUser,
    error::{AppError, AppResult},
    services::{admin_security, location_read_budget::ReadQuery},
    state::AppState,
};
use axum::{
    extract::{Query, State},
    routing::get,
    Extension, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/privacy/unattributed", get(list))
        .layer(axum::middleware::from_fn(super::privacy_delivery::no_store))
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Location,
    Event,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Filters {
    kind: Kind,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
    device_id: Option<i64>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    kind: Kind,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
    filter_device_id: Option<i64>,
    day: NaiveDate,
    device_id: i64,
    category: String,
}

impl Filters {
    fn validate(&self) -> AppResult<Option<Cursor>> {
        if self.until <= self.from
            || self.until - self.from > Duration::days(31)
            || self.device_id.is_some_and(|id| id <= 0)
            || !(1..=100).contains(&self.limit.unwrap_or(50))
        {
            return Err(AppError::BadRequest(
                "조회 기간은 최대 31일, 장치 번호는 양수, 페이지 크기는 1~100으로 지정해 주세요."
                    .into(),
            ));
        }
        let Some(encoded) = &self.cursor else {
            return Ok(None);
        };
        let invalid = || {
            AppError::BadRequest("조회 조건이 바뀌었거나 다음 페이지 정보가 올바르지 않습니다. 처음부터 조회해 주세요.".into())
        };
        if encoded.len() > 1024 {
            return Err(invalid());
        }
        let cursor: Cursor =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if cursor.kind != self.kind
            || cursor.from != self.from
            || cursor.until != self.until
            || cursor.filter_device_id != self.device_id
            || cursor.device_id <= 0
            || !matches!(
                cursor.category.as_str(),
                "l80" | "lte_gnss" | "phone" | "wake" | "sleep_enter" | "other"
            )
        {
            return Err(invalid());
        }
        Ok(Some(cursor))
    }
}

#[derive(Serialize, sqlx::FromRow)]
struct Group {
    day: NaiveDate,
    device_id: i64,
    category: String,
    records: i64,
    first_at: DateTime<Utc>,
    last_at: DateTime<Utc>,
    current_link: String,
}

async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
    verified: Option<Extension<admin_security::Verified>>,
    Query(filters): Query<Filters>,
) -> AppResult<Json<Value>> {
    // Unlike legacy admin routes, this cross-account inventory is unavailable
    // until individual roles, IP controls, step-up and audit are all enabled.
    if !admin_security::enabled()
        || !verified.is_some_and(|v| matches!(v.principal.role.as_str(), "officer" | "operator"))
    {
        return Err(AppError::Forbidden);
    }
    let cursor = filters.validate()?;
    let limit = filters.limit.unwrap_or(50);
    let (table, at, category) = match filters.kind {
        Kind::Location => (
            "location_records",
            "recorded_at",
            "CASE WHEN source IN ('l80','lte_gnss','phone') THEN source ELSE 'other' END",
        ),
        Kind::Event => (
            "events",
            "occurred_at",
            "CASE WHEN kind IN ('wake','sleep_enter') THEN kind ELSE 'other' END",
        ),
    };
    // Only fixed SQL identifiers above are interpolated. Read physical metadata;
    // never use decrypted views, raw bodies, coordinates or arbitrary source text.
    let sql = format!("WITH grouped AS (
      SELECT ({at} AT TIME ZONE 'Asia/Seoul')::date AS day, device_id,
        {category} AS category, count(*)::bigint AS records, min({at}) AS first_at, max({at}) AS last_at
      FROM {table} WHERE user_id IS NULL AND {at}>=$1 AND {at}<$2
        AND ($3::bigint IS NULL OR device_id=$3)
      GROUP BY 1,2,3
    ) SELECT g.*, CASE WHEN d.id IS NULL THEN 'device_missing' WHEN d.owner_id IS NULL THEN 'unlinked' ELSE 'linked' END AS current_link
      FROM grouped g LEFT JOIN devices d ON d.id=g.device_id
      WHERE ($4::date IS NULL OR (g.day,g.device_id,g.category)<($4,$5,$6))
      ORDER BY g.day DESC,g.device_id DESC,g.category DESC LIMIT $7");
    let mut read = ReadQuery::start(&state.db).await?;
    let mut rows: Vec<Group> = sqlx::query_as(&sql)
        .bind(filters.from)
        .bind(filters.until)
        .bind(filters.device_id)
        .bind(cursor.as_ref().map(|c| c.day))
        .bind(cursor.as_ref().map(|c| c.device_id))
        .bind(cursor.as_ref().map(|c| &c.category))
        .bind(limit + 1)
        .fetch_all(read.connection())
        .await
        .map_err(crate::services::location_read_budget::query_error)?;
    read.finish().await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next = if more {
        let last = rows.last().expect("positive page size");
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    kind: filters.kind,
                    from: filters.from,
                    until: filters.until,
                    filter_device_id: filters.device_id,
                    day: last.day,
                    device_id: last.device_id,
                    category: last.category.clone(),
                })
                .map_err(anyhow::Error::from)?,
            ),
        )
    } else {
        None
    };
    Ok(Json(
        json!({"items":rows,"next_cursor":next,"kind":filters.kind,"from":filters.from,"until":filters.until,
        "day_timezone":"Asia/Seoul","attribution":"unknown","read_only":true,"deletion_ready":false,
        "notice":"수집 당시 계정이 없는 자료입니다. 현재 장치 연결로 과거 소유자나 실제 정보주체를 확정할 수 없습니다. 가입 전 수신·과거 계정 삭제 등 발생 원인은 별도 확인이 필요합니다. 자동 귀속·파기는 수행하지 않습니다."}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn filters() -> Filters {
        serde_json::from_value(
            json!({"kind":"location","from":"2026-10-01T00:00:00Z","until":"2026-10-02T00:00:00Z"}),
        )
        .unwrap()
    }
    #[test]
    fn bounds_and_cursor_scope_are_enforced() {
        let mut f = filters();
        assert!(f.validate().unwrap().is_none());
        f.until = f.from + Duration::days(31);
        assert!(f.validate().is_ok());
        f.until += Duration::seconds(1);
        assert!(f.validate().is_err());
        f = filters();
        f.limit = Some(0);
        assert!(f.validate().is_err());
        f.limit = Some(101);
        assert!(f.validate().is_err());
        f.limit = None;
        f.device_id = Some(-1);
        assert!(f.validate().is_err());
        f = filters();
        f.cursor = Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    kind: f.kind,
                    from: f.from,
                    until: f.until,
                    filter_device_id: None,
                    day: f.from.date_naive(),
                    device_id: 1,
                    category: "l80".into(),
                })
                .unwrap(),
            ),
        );
        assert!(f.validate().is_ok());
        f.device_id = Some(1);
        assert!(f.validate().is_err());
        f.device_id = None;
        f.kind = Kind::Event;
        assert!(f.validate().is_err());
        f = filters();
        f.cursor = Some("!".repeat(1025));
        assert!(f.validate().is_err());
    }
}
