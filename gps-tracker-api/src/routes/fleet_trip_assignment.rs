//! Reviewable annotation assignments. Never rewrites SIM records or measured trips.
use crate::{
    auth::{
        fleet::{self, FleetScope},
        AuthUser,
    },
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    routing::{get, post, put},
    Extension, Json, Router,
};
use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use std::collections::HashSet;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/corporate/vehicles/:id/trip-rules",
            get(rules).post(create_rule),
        )
        .route("/corporate/vehicles/:id/trip-rules/:rule", put(update_rule))
        .route("/corporate/vehicles/:id/trips/assign", post(assign))
        .route(
            "/corporate/vehicles/:id/trips/assignment-history",
            get(history),
        )
}
async fn scope(
    state: &AppState,
    user: AuthUser,
    s: Option<Extension<FleetScope>>,
    vehicle: i64,
) -> AppResult<FleetScope> {
    let s = match s {
        Some(Extension(s)) => s,
        None => fleet::load(state, user.user_id, user.user_id).await?,
    };
    s.vehicle(vehicle)?;
    Ok(s)
}
async fn locks(tx: &mut Transaction<'_, Postgres>, owner: i64) -> AppResult<()> {
    super::fleet_expenses::lock(tx, owner).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("fleet-reservations:{owner}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
const RULES:&str="SELECT to_jsonb(r)||jsonb_build_object('driver_name',s.name) FROM fleet_trip_rules r LEFT JOIN staff s ON s.id=r.driver_staff_id AND s.user_id=r.owner_id WHERE r.owner_id=$1 AND r.vehicle_id=$2 ORDER BY r.id";
async fn rules(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    s: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = scope(&state, user, s, id).await?;
    let mut rows: Vec<Value> = sqlx::query_scalar(RULES)
        .bind(s.owner)
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    rows.retain(|r| {
        s.manager() || r["driver_staff_id"].is_null() || r["driver_staff_id"].as_i64() == s.staff
    });
    Ok(Json(rows))
}
#[derive(Deserialize)]
struct RuleInput {
    name: String,
    kind: String,
    #[serde(default)]
    weekdays: Vec<i32>,
    #[serde(default)]
    start_min: i32,
    end_min: i32,
    valid_from: NaiveDate,
    valid_to: Option<NaiveDate>,
    driver_staff_id: Option<i64>,
    purpose: Option<String>,
    purpose_note: Option<String>,
    active: bool,
    updated_at: Option<DateTime<Utc>>,
}
async fn create_rule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    s: Option<Extension<FleetScope>>,
    Json(p): Json<RuleInput>,
) -> AppResult<Json<Value>> {
    let s = scope(&state, user, s, id).await?;
    save_rule(&state, s, id, None, p).await.map(Json)
}
async fn update_rule(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, rid)): Path<(i64, i64)>,
    s: Option<Extension<FleetScope>>,
    Json(p): Json<RuleInput>,
) -> AppResult<Json<Value>> {
    let s = scope(&state, user, s, id).await?;
    save_rule(&state, s, id, Some(rid), p).await.map(Json)
}
async fn save_rule(
    state: &AppState,
    s: FleetScope,
    vehicle: i64,
    rid: Option<i64>,
    mut p: RuleInput,
) -> AppResult<Value> {
    if !s.admin() {
        return Err(AppError::Forbidden);
    }
    p.name = p.name.trim().into();
    p.weekdays.sort();
    p.weekdays.dedup();
    if p.name.is_empty()
        || p.name.chars().count() > 80
        || !matches!(p.kind.as_str(), "default" | "weekly")
        || p.start_min < 0
        || p.end_min > 1440
        || p.end_min <= p.start_min
        || p.valid_to.is_some_and(|d| d < p.valid_from)
        || p.weekdays.iter().any(|d| !(0..=6).contains(d))
        || (p.kind == "weekly" && p.weekdays.is_empty())
        || (p.driver_staff_id.is_none() && p.purpose.is_none())
        || p.purpose
            .as_ref()
            .is_some_and(|v| !matches!(v.as_str(), "commute" | "business" | "other"))
        || p.purpose_note
            .as_ref()
            .is_some_and(|v| v.chars().count() > 500)
    {
        return Err(AppError::BadRequest(
            "규칙의 이름·기간·요일·시간·지정 항목을 확인해 주세요.".into(),
        ));
    }
    if p.kind == "default" {
        p.weekdays.clear();
        p.start_min = 0;
        p.end_min = 1440;
    }
    let mut tx = state.db.begin().await?;
    locks(&mut tx, s.owner).await?;
    let before: Option<Value> = if let Some(rid) = rid {
        Some(sqlx::query_scalar("SELECT to_jsonb(r) FROM fleet_trip_rules r WHERE id=$1 AND owner_id=$2 AND vehicle_id=$3 FOR UPDATE").bind(rid).bind(s.owner).bind(vehicle).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?)
    } else {
        None
    };
    if let Some(ref before) = before {
        if date(&before["updated_at"]) != p.updated_at {
            return Err(stale());
        }
    }
    if let Some(driver) = p.driver_staff_id {
        let own: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM staff WHERE id=$1 AND user_id=$2)")
                .bind(driver)
                .bind(s.owner)
                .fetch_one(&mut *tx)
                .await?;
        if !own {
            return Err(AppError::BadRequest(
                "같은 회사의 사용자를 선택해 주세요.".into(),
            ));
        }
    }
    if p.active {
        super::fleet_team::driver_allowed(&mut tx, s.owner, p.driver_staff_id, vehicle).await?;
    }
    if p.active&&p.kind=="default"&&sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM fleet_trip_rules WHERE owner_id=$1 AND vehicle_id=$2 AND kind='default' AND active AND ($3::bigint IS NULL OR id<>$3))").bind(s.owner).bind(vehicle).bind(rid).fetch_one(&mut *tx).await?{return Err(AppError::Conflict("기본 규칙은 차량당 하나만 사용할 수 있습니다.".into()))}
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM fleet_trip_rules WHERE owner_id=$1 AND vehicle_id=$2",
    )
    .bind(s.owner)
    .bind(vehicle)
    .fetch_one(&mut *tx)
    .await?;
    if rid.is_none() && count >= 100 {
        return Err(AppError::BadRequest(
            "차량당 최대 100개 규칙을 관리할 수 있습니다.".into(),
        ));
    }
    let after:Value=sqlx::query_scalar("INSERT INTO fleet_trip_rules(id,owner_id,vehicle_id,name,kind,weekdays,start_min,end_min,valid_from,valid_to,driver_staff_id,purpose,purpose_note,active) VALUES(COALESCE($1,nextval('fleet_trip_rules_id_seq')),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,weekdays=EXCLUDED.weekdays,start_min=EXCLUDED.start_min,end_min=EXCLUDED.end_min,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,driver_staff_id=EXCLUDED.driver_staff_id,purpose=EXCLUDED.purpose,purpose_note=EXCLUDED.purpose_note,active=EXCLUDED.active,updated_at=clock_timestamp() RETURNING to_jsonb(fleet_trip_rules)")
 .bind(rid).bind(s.owner).bind(vehicle).bind(p.name).bind(p.kind).bind(p.weekdays).bind(p.start_min).bind(p.end_min).bind(p.valid_from).bind(p.valid_to).bind(p.driver_staff_id).bind(p.purpose).bind(p.purpose_note).bind(p.active).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO fleet_trip_assignment_audit(owner_id,actor_id,vehicle_id,action,before_value,after_value) VALUES($1,$2,$3,'rule',$4,$5)").bind(s.owner).bind(s.actor).bind(vehicle).bind(before).bind(&after).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(after)
}
fn stale() -> AppError {
    AppError::Conflict("조회 후 자료가 변경됐습니다. 새로 미리보기를 확인해 주세요.".into())
}
fn date(v: &Value) -> Option<DateTime<Utc>> {
    v.as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.with_timezone(&Utc))
}
#[derive(Deserialize, Serialize)]
struct TripKey {
    source_device_id: i64,
    binding_id: i64,
    trip_started_at: DateTime<Utc>,
}
#[derive(Deserialize, Serialize)]
struct AssignInput {
    from: NaiveDate,
    to: NaiveDate,
    trips: Vec<TripKey>,
    mode: String,
    #[serde(default)]
    change_driver: bool,
    driver_staff_id: Option<i64>,
    #[serde(default)]
    change_purpose: bool,
    purpose: Option<String>,
    purpose_note: Option<String>,
    #[serde(default)]
    overwrite: bool,
    preview_token: Option<String>,
}
#[derive(Debug, Serialize, PartialEq)]
struct Choice {
    driver: Option<i64>,
    purpose: Option<String>,
    note: Option<String>,
    source: Value,
}
// A reservation must cover the whole trip. Partial/ambiguous matches suppress
// fallback rules; a driver must never be guessed at the vehicle handover boundary.
fn choose(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    bookings: &[Value],
    rules: &[Value],
) -> Result<Option<Choice>, &'static str> {
    let overlap: Vec<_> = bookings
        .iter()
        .filter(|r| {
            date(&r["starts_at"]).is_some_and(|s| s < end)
                && date(&r["ends_at"]).is_some_and(|e| e > start)
                && r["status"] != "cancelled"
        })
        .collect();
    if !overlap.is_empty() {
        if overlap.len() != 1 {
            return Err("여러 예약과 겹침");
        }
        let r = overlap[0];
        if date(&r["starts_at"]).is_none_or(|s| s > start)
            || date(&r["ends_at"]).is_none_or(|e| e < end)
        {
            return Err("예약 시간 일부와 겹침");
        }
        return Ok(Some(Choice {
            driver: r["driver_staff_id"].as_i64(),
            purpose: r["report_purpose"].as_str().map(str::to_owned),
            note: r["purpose"].as_str().map(str::to_owned),
            source: json!({"kind":"reservation","id":r["id"],"starts_at":r["starts_at"],"ends_at":r["ends_at"],"updated_at":r["updated_at"]}),
        }));
    }
    let local = start.with_timezone(&FixedOffset::east_opt(9 * 3600).unwrap());
    let local_end = end.with_timezone(local.offset());
    let valid: Vec<_> = rules
        .iter()
        .filter(|r| {
            if r["active"] != true {
                return false;
            }
            let day = local.date_naive().to_string();
            if r["valid_from"].as_str().is_none_or(|d| d > day.as_str())
                || r["valid_to"].as_str().is_some_and(|d| {
                    d < (local_end - Duration::nanoseconds(1))
                        .date_naive()
                        .to_string()
                        .as_str()
                })
            {
                return false;
            }
            if r["kind"] == "default" {
                return true;
            }
            let last = local_end - Duration::nanoseconds(1);
            let start_seconds = i64::from(local.num_seconds_from_midnight());
            let end_seconds = if local_end.date_naive() > local.date_naive() {
                86400
            } else {
                i64::from(local_end.num_seconds_from_midnight())
            };
            last.date_naive() == local.date_naive()
                && r["weekdays"]
                    .as_array()
                    .is_some_and(|d| d.contains(&json!(local.weekday().num_days_from_sunday())))
                && r["start_min"]
                    .as_i64()
                    .is_some_and(|v| start_seconds >= v * 60)
                && r["end_min"].as_i64().is_some_and(|v| end_seconds <= v * 60)
        })
        .collect();
    let weekly: Vec<_> = valid
        .iter()
        .copied()
        .filter(|r| r["kind"] == "weekly")
        .collect();
    let choices = if weekly.is_empty() { valid } else { weekly };
    if choices.len() > 1 {
        return Err("반복 규칙이 겹침");
    }
    Ok(choices.first().map(|r|Choice{driver:r["driver_staff_id"].as_i64(),purpose:r["purpose"].as_str().map(str::to_owned),note:r["purpose_note"].as_str().map(str::to_owned),source:json!({"kind":r["kind"],"id":r["id"],"name":r["name"],"updated_at":r["updated_at"]})}))
}
async fn assign(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vehicle): Path<i64>,
    s: Option<Extension<FleetScope>>,
    Json(mut p): Json<AssignInput>,
) -> AppResult<Json<Value>> {
    let s = scope(&state, user, s, vehicle).await?;
    if p.to < p.from
        || p.to - p.from > Duration::days(365)
        || p.trips.is_empty()
        || p.trips.len() > 100
        || !matches!(p.mode.as_str(), "manual" | "suggest")
        || p.mode == "manual" && !p.change_driver && !p.change_purpose
        || p.change_purpose
            && !matches!(
                p.purpose.as_deref(),
                Some("commute" | "business" | "other" | "unspecified")
            )
        || p.purpose_note
            .as_ref()
            .is_some_and(|v| v.chars().count() > 500)
    {
        return Err(AppError::BadRequest(
            "기간과 지정 항목을 확인해 주세요. 한 번에 100건까지 선택할 수 있습니다.".into(),
        ));
    }
    if !s.manager() && p.change_driver && p.driver_staff_id != s.staff {
        return Err(AppError::Forbidden);
    }
    let mut seen = HashSet::new();
    for k in &p.trips {
        if !seen.insert((k.source_device_id, k.binding_id, k.trip_started_at)) {
            return Err(AppError::BadRequest(
                "같은 운행을 중복 선택할 수 없습니다.".into(),
            ));
        }
    }
    let mut tx = state.db.begin().await?;
    locks(&mut tx, s.owner).await?;
    sqlx::query("SELECT set_config('app.fleet_actor',$1,true)")
        .bind(s.actor.to_string())
        .execute(&mut *tx)
        .await?;
    // Binding edits take row locks, so the reviewed vehicle allocation cannot move
    // while this annotation transaction is committing.
    sqlx::query(
        "SELECT id FROM fleet_vehicle_bindings WHERE owner_id=$1 AND vehicle_id=$2 FOR SHARE",
    )
    .bind(s.owner)
    .bind(vehicle)
    .fetch_all(&mut *tx)
    .await?;
    let from = p.from.and_hms_opt(0, 0, 0).unwrap().and_utc() - Duration::hours(9);
    let to = p.to.and_hms_opt(23, 59, 59).unwrap().and_utc() - Duration::hours(9);
    let trips = super::fleet_vehicles::allocated_trips(&state, s.owner, vehicle, from, to).await?;
    let bookings:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r) FROM vehicle_reservations r WHERE user_id=$1 AND fleet_vehicle_id=$2 AND starts_at<=$4 AND ends_at>=$3 AND status<>'cancelled' ORDER BY id").bind(s.owner).bind(vehicle).bind(from).bind(to).fetch_all(&mut *tx).await?;
    let rules: Vec<Value> = sqlx::query_scalar(RULES)
        .bind(s.owner)
        .bind(vehicle)
        .fetch_all(&mut *tx)
        .await?;
    let mut plan = Vec::new();
    for k in &p.trips {
        let t = trips
            .iter()
            .find(|t| {
                t["source_device_id"].as_i64() == Some(k.source_device_id)
                    && t["binding_id"].as_i64() == Some(k.binding_id)
                    && date(&t["source_started_at"]) == Some(k.trip_started_at)
            })
            .ok_or_else(stale)?;
        let mut row = json!({"key":k,"started_at":t["started_at"],"ended_at":t["ended_at"],"before":t["annotation"],"status":"skipped","reason":"","source":null});
        if t["allocation_status"] != "assigned"
            || date(&t["ended_at"]).is_none_or(|end| end <= k.trip_started_at)
        {
            row["reason"] = json!("종료·차량 연결 확인 필요");
            plan.push(row);
            continue;
        }
        let old_driver = t["annotation"]["driver_staff_id"].as_i64();
        if !s.manager() && old_driver.is_some() && old_driver != s.staff {
            row["reason"] = json!("다른 운전자에게 배정된 기록");
            plan.push(row);
            continue;
        }
        let choice = if p.mode == "suggest" {
            match choose(
                k.trip_started_at,
                date(&t["ended_at"]).unwrap(),
                &bookings,
                &rules,
            ) {
                Ok(Some(c)) => c,
                Ok(None) => {
                    row["reason"] = json!("해당 예약·규칙 없음");
                    plan.push(row);
                    continue;
                }
                Err(why) => {
                    row["reason"] = json!(why);
                    plan.push(row);
                    continue;
                }
            }
        } else {
            Choice {
                driver: p.driver_staff_id,
                purpose: p.purpose.clone(),
                note: p.purpose_note.clone(),
                source: json!({"kind":"manual"}),
            }
        };
        let replace = p.mode == "manual" && p.overwrite;
        let set_driver = (p.mode == "suggest" && choice.driver.is_some()
            || p.mode == "manual" && p.change_driver)
            && (replace || old_driver.is_none());
        let old_purpose = t["annotation"]["purpose"].as_str().unwrap_or("unspecified");
        let set_purpose = (p.mode == "suggest" && choice.purpose.is_some()
            || p.mode == "manual" && p.change_purpose)
            && (replace || old_purpose == "unspecified");
        if set_driver && choice.driver.is_some_and(|id| !s.staff_ids.contains(&id)) {
            row["reason"] = json!("운전자 배정 권한 확인 필요");
            plan.push(row);
            continue;
        }
        if set_driver {
            if let Err(e) =
                super::fleet_team::driver_allowed(&mut tx, s.owner, choice.driver, vehicle).await
            {
                match e {
                    AppError::BadRequest(_) => {
                        row["reason"] = json!("현재 차량에 배정 가능한 사용자 아님");
                        plan.push(row);
                        continue;
                    }
                    e => return Err(e),
                }
            }
        }
        let driver = if set_driver {
            choice.driver
        } else {
            old_driver
        };
        let purpose = if set_purpose {
            choice.purpose.as_deref().unwrap_or("unspecified")
        } else {
            old_purpose
        };
        let note = if set_purpose && purpose == "other" {
            choice.note.as_deref()
        } else if set_purpose {
            None
        } else {
            t["annotation"]["purpose_note"].as_str()
        };
        if driver == old_driver
            && purpose == old_purpose
            && note == t["annotation"]["purpose_note"].as_str()
        {
            row["reason"] = json!("이미 입력됨 · 변경 없음");
            plan.push(row);
            continue;
        }
        let name: Option<String> = if driver == old_driver {
            t["annotation"]["driver_name"].as_str().map(str::to_owned)
        } else if let Some(driver) = driver {
            sqlx::query_scalar("SELECT name FROM staff WHERE id=$1 AND user_id=$2")
                .bind(driver)
                .bind(s.owner)
                .fetch_optional(&mut *tx)
                .await?
        } else {
            None
        };
        row["status"] = json!("ready");
        row["source"] = choice.source;
        row["after"] = json!({"driver_staff_id":driver,"driver_name":name,"purpose":purpose,"purpose_note":note});
        plan.push(row);
    }
    let token = p.preview_token.take();
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(
                &json!({"owner":s.owner,"actor":s.actor,"vehicle":vehicle,"request":p,"rows":plan})
            )
            .map_err(|e| AppError::Internal(e.into()))?
        )
    );
    let ready = plan.iter().filter(|r| r["status"] == "ready").count();
    if let Some(token) = token {
        if token != fingerprint {
            return Err(stale());
        }
        for row in plan.iter().filter(|r| r["status"] == "ready") {
            let k = &row["key"];
            let after = &row["after"];
            let source = json!({"vehicle_id":vehicle,"source":row["source"],"driver_staff_id":after["driver_staff_id"],"purpose":after["purpose"]});
            sqlx::query("INSERT INTO trip_annotations(device_id,user_id,trip_started_at,driver_staff_id,purpose,purpose_note,assignment_source) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(device_id,user_id,trip_started_at) DO UPDATE SET driver_staff_id=EXCLUDED.driver_staff_id,purpose=EXCLUDED.purpose,purpose_note=EXCLUDED.purpose_note,assignment_source=EXCLUDED.assignment_source,updated_at=clock_timestamp()")
    .bind(k["source_device_id"].as_i64()).bind(s.owner).bind(date(&k["trip_started_at"])).bind(after["driver_staff_id"].as_i64()).bind(after["purpose"].as_str()).bind(after["purpose_note"].as_str()).bind(source).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(Json(json!({"applied":ready,"skipped":plan.len()-ready})))
    } else {
        tx.rollback().await?;
        Ok(Json(
            json!({"rows":plan,"preview_token":fingerprint,"ready":ready,"skipped":plan.len()-ready}),
        ))
    }
}
async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vehicle): Path<i64>,
    s: Option<Extension<FleetScope>>,
) -> AppResult<Json<Vec<Value>>> {
    let s = scope(&state, user, s, vehicle).await?;
    if !s.manager() {
        return Err(AppError::Forbidden);
    }
    Ok(Json(sqlx::query_scalar("SELECT to_jsonb(a)||jsonb_build_object('actor_name',u.display_name) FROM gps_read_fleet_trip_assignment_audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.owner_id=$1 AND a.vehicle_id=$2 ORDER BY a.id DESC LIMIT 100").bind(s.owner).bind(vehicle).fetch_all(&state.db).await?))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }
    #[test]
    fn reservations_require_unique_full_coverage() {
        let s = at("2026-10-26T00:00:00Z");
        let e = s + Duration::hours(1);
        let r = json!({"id":1,"starts_at":s,"ends_at":e,"driver_staff_id":9,"report_purpose":"business","status":"planned"});
        assert_eq!(
            choose(s, e, &[r.clone()], &[]).unwrap().unwrap().driver,
            Some(9)
        );
        assert!(choose(s - Duration::minutes(1), e, &[r.clone()], &[]).is_err());
        assert!(choose(s, e, &[r.clone(), r], &[]).is_err());
    }
    #[test]
    fn midnight_end_includes_last_valid_day() {
        let s = at("2026-10-26T14:00:00Z");
        let e = at("2026-10-26T15:00:00Z");
        let r = json!({"id":1,"kind":"weekly","active":true,"valid_from":"2026-10-26","valid_to":"2026-10-26","weekdays":[1],"start_min":1380,"end_min":1440,"purpose":"business"});
        assert!(choose(s, e, &[], &[r.clone()]).unwrap().is_some());
        assert!(choose(s, e + Duration::seconds(1), &[], &[r])
            .unwrap()
            .is_none());
    }
    #[test]
    fn weekly_uses_kst_and_conflicts_are_not_guessed() {
        let s = at("2026-10-26T00:00:00Z");
        let e = s + Duration::hours(1);
        let r = json!({"id":1,"kind":"weekly","active":true,"valid_from":"2026-10-26","weekdays":[1],"start_min":540,"end_min":600,"purpose":"business"});
        assert!(choose(s, e, &[], &[r.clone()]).unwrap().is_some());
        assert!(choose(s, e + Duration::minutes(1), &[], &[r.clone()])
            .unwrap()
            .is_none());
        assert!(choose(s, e, &[], &[r.clone(), r]).is_err());
    }
}
