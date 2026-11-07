//! What the system recorded about collecting, using and providing a person's location
//! information, for one account and one period. Facts only: when, how and through what, never
//! where. No coordinate, address, token or free text of another person is read here.
//!
//! Attribution is the account a report was stored under when it arrived
//! (`location_records.user_id`), not who owns the SIM today. Devices that have ever been bound to
//! a company vehicle, and erased SIMs, are left out and counted for separate review, exactly as
//! the location file delivery does.
//!
//! Reads are recorded only from the moment the access ledger was switched on, and only while it
//! ran. Nothing is made up for the time before. What is not recorded is listed in the output
//! instead of being implied complete.
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};

pub const SECTION: &str = "location_facts";
pub const MAX_DAYS: i64 = 366;

/// The period exists exactly when the section is selected, starts in the past and is bounded.
pub fn valid_period(
    selected: bool,
    from: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    match (selected, from, until) {
        (false, None, None) => true,
        (true, Some(from), Some(until)) => {
            from < until && from < now && until - from <= Duration::days(MAX_DAYS)
        }
        _ => false,
    }
}

/// `{a}` is the alias of a row with a `device_id`.
fn own_device(alias: &str) -> String {
    format!(
        "NOT EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.device_id={alias}.device_id) \
         AND NOT EXISTS(SELECT 1 FROM device_data_controls c WHERE c.device_id={alias}.device_id AND c.blocked)"
    )
}

// LIMIT N+1 is deliberate, as in the other sections: an oversized list fails, it is never cut short.
async fn list(
    tx: &mut Transaction<'_, Postgres>,
    uid: i64,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
    query: &str,
    limit: usize,
) -> AppResult<Value> {
    let values: Vec<Value> = in_time(
        sqlx::query_scalar(query)
            .bind(uid)
            .bind(from)
            .bind(until)
            .fetch_all(&mut **tx)
            .await,
    )?;
    if values.len() > limit {
        return Err(too_much());
    }
    Ok(json!(values))
}

/// Reaching the statement time limit of this transaction means too much for one file, not a server fault.
fn in_time<T>(result: Result<T, sqlx::Error>) -> AppResult<T> {
    match result {
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("57014") => Err(too_much()),
        other => Ok(other?),
    }
}

fn too_much() -> AppError {
    AppError::Conflict(
        "선택한 기간의 수집·이용·제공사실이 한 번에 제공할 수 있는 양을 넘습니다. 담당자에게 기간을 나눈 제공을 요청해 주세요."
            .into(),
    )
}

/// What is not recorded once the access ledger has started. `since` is its first moment in Korean time.
fn not_recorded(started: Option<DateTime<Utc>>) -> Vec<String> {
    let Some(started) = started else {
        return NOT_RECORDED.iter().map(|s| s.to_string()).collect();
    };
    let since = (started + Duration::hours(9)).format("%Y-%m-%d %H:%M");
    vec![
        format!("본인 계정·회사 연결 계정·운영자의 조회, 공유 링크 열람, 외부 서비스 전달: 기록을 시작한 {since}(한국 시간) 이전과 access_records.recorded_periods에 없는 시간에는 기록이 없으며, 소급해 만들지 않습니다."),
        "새 조회 기록은 건별 시각과 처리 상태를 남깁니다. 이전 집계는 legacy_hourly로 구분합니다. 조회 내용과 위치는 저장하지 않습니다.".into(),
        "공유 링크를 받은 사람의 신원은 확인하지 않으며, 링크별 요청 시각과 처리 상태만 남습니다. 만료·회수 후 30일이 지난 링크는 목록에서 삭제됩니다.".into(),
        "인증 전 거부, 공유 화면에서 받는 사람의 브라우저가 지도 서비스로 직접 보내는 주소 변환, 서비스 내부의 자동 처리(구역 출입 판정, 통계 집계, 지점 방문 판정): 기록하지 않습니다.".into(),
        NOT_RECORDED[5].into(),
        NOT_RECORDED[6].into(),
        NOT_RECORDED[7].into(),
    ]
}

/// Facts the service produces without leaving a record per occurrence, while no access ledger exists.
const NOT_RECORDED: [&str; 8] = [
    "본인 계정의 지도·이동 이력·통계 조회, 실시간 화면 연결, 파일 내보내기: 조회할 때마다의 기록을 남기지 않습니다.",
    "공유 링크를 받은 사람의 열람: 누가 언제 열었는지는 기록하지 않으며 열람 횟수와 마지막 열람 시각만 남습니다. 만료·회수 후 30일이 지난 링크는 목록에서 삭제됩니다.",
    "회사에 연결된 계정(회사 소유자·직원)의 차량 운행 조회와 보고서 생성: 조회할 때마다의 기록을 남기지 않습니다.",
    "운영자(관리자)의 장치 상태·최근 위치 확인: 확인할 때마다의 기록을 남기지 않습니다.",
    "주소 표시를 위한 외부 지도 서비스의 좌표 변환, 알림 전송 서비스로의 알림 전달: 호출할 때마다의 기록을 남기지 않습니다. 알림 전송 대기 기록은 처리 후 14일이 지나면 삭제됩니다.",
    "완료되지 않은 AI 분석 요청: 실패하거나 시간이 초과된 요청은 기록에 남지 않습니다.",
    "수집을 중지했거나 차단된 동안 단말기가 보낸 보고: 저장하지 않으며 받은 사실도 기록하지 않습니다.",
    "이미 삭제·파기되어 남아 있지 않은 위치 기록은 집계에 포함되지 않습니다. 이 자료의 조회 기간은 원본 위치정보의 보관 기간을 뜻하지 않습니다.",
];

pub async fn export(
    tx: &mut Transaction<'_, Postgres>,
    uid: i64,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
) -> AppResult<Value> {
    let (l, e, a, s, g) = (
        own_device("l"),
        own_device("e"),
        own_device("a"),
        own_device("s"),
        own_device("g"),
    );
    // A stored report is a location report when it carries at least one point: its own fix, or
    // the fixes of a batch. Reports without a point carry device status only.
    let daily = list(tx, uid, from, until, &format!(
        "SELECT jsonb_build_object('device_id',device_id,'date',day,'method',method,'reports',count(*) FILTER (WHERE points>0),\
         'points',COALESCE(sum(points),0),'status_only_reports',count(*) FILTER (WHERE points=0),'first_at',min(recorded_at),'last_at',max(recorded_at)) \
         FROM (SELECT l.device_id,l.recorded_at,(l.recorded_at AT TIME ZONE 'Asia/Seoul')::date AS day,\
         CASE l.source WHEN 'l80' THEN 'device_gnss' WHEN 'lte_gnss' THEN 'modem_gnss' WHEN 'phone' THEN 'phone' ELSE 'other_review_required' END AS method,\
         CASE WHEN l.fixes_jsonb IS NULL THEN l.fix::int WHEN jsonb_typeof(l.fixes_jsonb)='array' THEN jsonb_array_length(l.fixes_jsonb) ELSE 0 END AS points \
         FROM gps_read_location_records l WHERE l.user_id=$1 AND l.recorded_at>=$2 AND l.recorded_at<$3 AND {l}) x \
         GROUP BY device_id,day,method ORDER BY day,device_id,method LIMIT 4001"), 4000).await?;
    let changes = list(tx, uid, from, until, &format!(
        "SELECT jsonb_build_object('device_id',e.device_id,'action',CASE WHEN e.paused THEN 'paused' ELSE 'resumed' END,'at',e.created_at) \
         FROM collection_control_events e WHERE e.actor_id=$1 AND e.created_at>=$2 AND e.created_at<$3 AND {e} ORDER BY e.id LIMIT 1001"), 1000).await?;
    let events = list(tx, uid, from, until, &format!(
        "SELECT jsonb_build_object('device_id',e.device_id,'kind',e.kind,'at',e.occurred_at,'notification_processed_at',e.notified_at) \
         FROM gps_read_events e WHERE e.user_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3 AND e.kind IN ('geofence_in','geofence_out','cycle_first_fix') AND {e} \
         ORDER BY e.occurred_at,e.id LIMIT 2001"), 2000).await?;
    let analyses = list(tx, uid, from, until, &format!(
        "SELECT jsonb_build_object('device_id',a.device_id,'target_date',a.target_date,'requested_at',a.created_at) FROM (\
         SELECT device_id,target_date,created_at FROM ai_analysis_requests WHERE user_id=$1 \
         UNION SELECT device_id,target_date,created_at FROM ai_analyses y WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM ai_analysis_requests r WHERE r.analysis_id=y.id)) a \
         WHERE a.created_at>=$2 AND a.created_at<$3 AND {a} ORDER BY a.created_at,a.device_id LIMIT 1001"), 1000).await?;
    // Never the link token. The note is the subject's own memo about the recipient.
    let links = list(tx, uid, from, until, &format!(
        "SELECT jsonb_build_object('id',s.id,'device_id',s.device_id,'created_at',s.created_at,'expires_at',s.expires_at,'revoked_at',s.revoked_at,\
         'view_count',s.view_count,'last_viewed_at',s.last_viewed_at,'note',left(s.note,200)) \
         FROM share_tokens s WHERE s.created_by=$1 AND s.created_at<$3 AND COALESCE(s.revoked_at,s.expires_at)>=$2 AND {s} ORDER BY s.id LIMIT 501"), 500).await?;
    let charges = list(tx, uid, from, until,
        "SELECT jsonb_build_object('action',CASE reason WHEN 'share_create' THEN 'created' ELSE 'extended' END,'at',created_at) \
         FROM credit_log WHERE user_id=$1 AND created_at>=$2 AND created_at<$3 AND reason IN ('share_create','share_extend') ORDER BY id LIMIT 1001", 1000).await?;
    let deliveries = list(tx, uid, from, until,
        "SELECT jsonb_build_object('delivery_id',d.id,'issued_at',d.created_at,'device_ids',d.device_ids,'records_from',d.from_at,'records_until',d.until_at,\
         'expires_at',d.expires_at,'revoked_at',d.revoked_at,'downloads',(SELECT COALESCE(jsonb_agg(jsonb_build_object('at',v.created_at,'record_count',v.record_count) ORDER BY v.id),'[]'::jsonb) \
         FROM privacy_delivery_events v WHERE v.delivery_id=d.id AND v.action='download_prepared' AND v.actor_id=$1)) \
         FROM privacy_deliveries d JOIN privacy_requests r ON r.id=d.request_id WHERE r.user_id=$1 AND d.created_at>=$2 AND d.created_at<$3 ORDER BY d.id LIMIT 201", 200).await?;
    // Which company is not named: company records are reviewed in their own procedure. The start
    // of the period is not a filter, because a link made earlier still holds during the period.
    let companies = list(tx, uid, from, until,
        "SELECT jsonb_build_object('company_link',dense_rank() OVER (ORDER BY h.company_owner_id,h.staff_id),'action',h.action,'effective_at',h.effective_at) \
         FROM privacy_company_link_history h WHERE h.subject_id=$1 AND h.effective_at<$3 AND $2::timestamptz IS NOT NULL ORDER BY h.id LIMIT 201", 200).await?;
    let separate: i64 = in_time(
        sqlx::query_scalar(&format!(
            "SELECT count(DISTINCT l.device_id) FROM gps_read_location_records l WHERE l.user_id=$1 AND l.recorded_at>=$2 AND l.recorded_at<$3 AND NOT ({l})"
        ))
        .bind(uid)
        .bind(from)
        .bind(until)
        .fetch_one(&mut **tx)
        .await,
    )?;
    // Who was given the location information, from the moment that started to be recorded.
    let started: Option<DateTime<Utc>> = in_time(
        sqlx::query_scalar("SELECT min(c.started_at) FROM location_access_coverage c")
            .fetch_one(&mut **tx)
            .await,
    )?;
    let access = match started {
        None => None,
        Some(started) => {
            let periods = list(tx, uid, from, until,
                "SELECT jsonb_build_object('from',GREATEST(c.started_at,$2),'until',LEAST(COALESCE(c.stopped_at,c.alive_at),$3),                 'ended',CASE WHEN c.stopped_at IS NOT NULL THEN 'stopped' ELSE 'unconfirmed' END,                 'not_kept',c.dropped) FROM location_access_coverage c                  WHERE $1::bigint IS NOT NULL AND c.started_at<$3 AND COALESCE(c.stopped_at,c.alive_at)>=$2 ORDER BY c.id LIMIT 501", 500).await?;
            // The account a company member or an administrator used is not named, only that it was one.
            let records = list(tx, uid, from, until, &format!(
                "SELECT jsonb_build_object('first_at',g.first_at,'last_at',g.last_at,'count',g.hits,'recipient',g.recipient_kind,'service',g.recipient_name,                 'via',g.path,'kind',g.method,'device_id',g.device_id,'vehicle_id',g.vehicle_id,'share_link_id',g.share_id,'all_accounts',g.all_subjects,                 'requested_from',g.range_from,'requested_until',g.range_until,'attribution',g.attribution,'outcome',g.outcome,'route',g.route,'record_type',g.record_type,'actual_subject_user_id',g.actual_subject_user_id)                  FROM location_access_records g WHERE g.subject_user_id=$1 AND g.attribution NOT IN ('company_scope','all_accounts','unresolved','legacy_unverified') AND g.last_at>=$2 AND g.first_at<$3                  AND (g.device_id IS NULL OR ({g})) ORDER BY g.bucket,g.id LIMIT 2001"), 2000).await?;
            Some(json!({
                "recording_started_at": started,
                "recorded_periods": periods,
                "records": records,
                "notice": "기록 시작 후 계정 범위의 건별 조회·전달 처리 기록입니다. 계정은 실제 운전자와 동일하다고 확정하지 않습니다. attribution은 귀속 근거, actual_subject_user_id는 확정된 정보주체(현재 미확정)입니다. response_ready는 HTTP 응답 준비, socket_sent는 소켓 쓰기 완료, http_accepted/http_rejected는 외부 서버 응답입니다. 최종 사용자의 수신·열람은 증명하지 않습니다. prepared는 중단 등으로 결과 미확정, transport_unknown은 통신 결과 미확정, denied는 거부된 요청입니다. legacy_hourly는 이전 방식의 시간별 집계이며 귀속을 소급 확정하지 않습니다. requested_from/until이 없으면 자료 기간을 특정하지 못한 요청입니다. 회사·공유·귀속 미상 자료는 별도 검토가 필요합니다.",
            }))
        }
    };
    let mut facts = json!({
        "period": {"from": from, "until": until, "date_timezone": "Asia/Seoul"},
        "collection": {
            "by": "본인 계정에 등록된 단말기가 보낸 위치 보고를 서비스가 저장한 사실입니다. 기록은 보고가 저장될 당시의 계정에 귀속됩니다.",
            "daily": daily,
            "collection_changes": changes,
        },
        "use": {
            "location_events": events,
            "ai_analyses": analyses,
        },
        "provision": {
            "share_links": links,
            "share_link_charges": charges,
            "location_file_deliveries": deliveries,
            "company_links": companies,
        },
        "separate_review": {"devices_with_company_vehicle_history_or_erased": separate},
        "not_recorded": not_recorded(started),
        "notice": "지정한 기간에 대해 시스템에 남아 있는 수집·이용·제공사실입니다. 좌표와 주소는 포함하지 않습니다. \
    수집은 날짜(한국 시간)·단말기·수집 방법별 건수와 처음·마지막 시각이며, 건별 시각과 위치는 위치 기록 제공에서 확인합니다. 저장된 보고 기준이라 재전송된 보고가 중복 집계될 수 있습니다. \
    method는 device_gnss(단말기 위성 수신), modem_gnss(통신 모듈 위성 수신), phone(휴대전화)입니다. \
    location_events는 위치를 이용해 만든 구역 출입·첫 위치 확인 사건이고 notification_processed_at은 알림 처리 시각이며 수신 완료를 증명하지 않습니다. \
    ai_analyses는 그 날짜의 이동 요약을 외부 AI 서비스로 보내 분석한 기록입니다. \
    share_links는 본인이 만든 공유 링크이고 받는 사람은 시스템이 식별하지 않습니다. location_file_deliveries는 열람 요청에 따라 본인에게 제공한 위치 파일입니다. \
    company_links는 회사와의 계정 연결 변동이며, 회사 차량 운행 중 회사 계정으로 수집된 위치와 separate_review의 단말기는 회사 자료 검토 절차에서 따로 다룹니다. \
    not_recorded는 서비스가 수행하지만 건별 기록이 없는 처리입니다. 이 자료는 모든 수집·이용·제공사실의 제공 완료를 뜻하지 않습니다.",
    });
    if let Some(access) = access {
        facts["access_records"] = access;
    }
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn the_period_exists_exactly_when_the_section_is_selected_and_is_bounded() {
        let now = Utc.with_ymd_and_hms(2026, 11, 6, 0, 0, 0).unwrap();
        let day = Duration::days(1);
        assert!(valid_period(false, None, None, now));
        assert!(valid_period(true, Some(now - day * 30), Some(now), now));
        // A period that reaches past the moment of issue is cut there by the insert, not refused.
        assert!(valid_period(true, Some(now - day), Some(now + day), now));
        assert!(valid_period(true, Some(now - day * 366), Some(now), now));
        assert!(!valid_period(true, Some(now - day * 367), Some(now), now));
        assert!(!valid_period(true, Some(now), Some(now - day), now));
        assert!(!valid_period(
            true,
            Some(now + day),
            Some(now + day * 2),
            now
        ));
        assert!(!valid_period(true, None, None, now));
        assert!(!valid_period(true, Some(now - day), None, now));
        assert!(!valid_period(false, Some(now - day), Some(now), now));
    }

    #[test]
    fn what_is_not_recorded_depends_on_whether_and_since_when_reads_are_recorded() {
        // No ledger: the eight statements released with the section, unchanged.
        assert_eq!(not_recorded(None), NOT_RECORDED.map(String::from).to_vec());
        // A ledger: nothing claims a record before its start, and the start is given in Korean time.
        let started = Utc.with_ymd_and_hms(2026, 11, 30, 16, 5, 0).unwrap();
        let listed = not_recorded(Some(started));
        assert_eq!(listed.len(), 7);
        assert!(
            listed[0].contains("2026-12-01 01:05(한국 시간) 이전")
                && listed[0].contains("소급해 만들지 않습니다")
        );
        assert!(!listed
            .iter()
            .any(|s| s.contains("조회할 때마다의 기록을 남기지 않습니다")));
        assert_eq!(listed[4..], NOT_RECORDED.map(String::from)[5..]);
    }

    #[test]
    fn excluded_devices_are_named_by_the_alias_of_the_row() {
        let clause = own_device("e");
        assert!(
            clause.contains("b.device_id=e.device_id")
                && clause.contains("c.device_id=e.device_id AND c.blocked")
        );
    }

    #[test]
    fn nothing_that_is_exported_selects_a_coordinate_or_a_token() {
        // Every column in the queries of this file is written with its row alias. A column that
        // locates a person, a link token or the free text of an event must not be among them.
        let source = include_str!("privacy_location_facts.rs");
        let queries = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in [
            "lat",
            "lng",
            "token",
            "raw",
            "data",
            "heading",
            "speed_kmh",
            "message",
        ] {
            let found = queries
                .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.'))
                .any(|word| word.ends_with(&format!(".{forbidden}")));
            assert!(!found, "{forbidden} is selected");
        }
    }
}
