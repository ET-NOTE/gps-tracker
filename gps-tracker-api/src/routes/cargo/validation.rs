use super::bad;
use crate::error::AppResult;
use chrono::{DateTime, NaiveDateTime, NaiveTime};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

mod dispatch;
mod finance;
#[cfg(test)]
mod tests;

pub(super) const COLLECTIONS: &[&str] = &[
    "branches",
    "orders",
    "recurring",
    "shipments",
    "vehicles",
    "drivers",
    "shippers",
    "carriers",
    "locations",
    "rates",
    "services",
    "incidents",
    "charges",
    "payments",
];
pub(super) struct References {
    pub new_devices: Vec<i64>,
    pub new_staff: Vec<(i64, String)>,
    pub images: Vec<String>,
}

struct Index<'a> {
    data: &'a Value,
    by_id: HashMap<(&'static str, &'a str), &'a Value>,
}

impl<'a> Index<'a> {
    fn new(data: &'a Value) -> AppResult<Self> {
        let mut by_id = HashMap::new();
        for &key in COLLECTIONS {
            for record in arr(&data[key])? {
                let id = required(record, "id")?;
                check(
                    id.len() <= 100
                        && id.chars().all(|c| {
                            c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':')
                        }),
                    "항목 식별자를 확인해 주세요.",
                )?;
                check(
                    by_id.insert((key, id), record).is_none(),
                    "중복된 항목이 있습니다.",
                )?;
            }
        }
        Ok(Self { data, by_id })
    }
    fn rows(&self, key: &str) -> &'a [Value] {
        self.data[key]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
    }
    fn find(&self, key: &str, id: &str) -> Option<&'a Value> {
        self.by_id.get(&(key, id)).copied()
    }
    fn get(&self, key: &str, id: &str) -> AppResult<&'a Value> {
        self.find(key, id)
            .ok_or_else(|| bad("연결된 항목을 찾을 수 없습니다."))
    }
    fn link(&self, r: &Value, field: &str, key: &str, optional: bool) -> AppResult<()> {
        let id = txt(r, field);
        if optional && id.is_empty() {
            return Ok(());
        }
        self.get(key, id).map(|_| ())
    }
    fn code(&self, field: &str, name: &str) -> AppResult<()> {
        check(
            arr(&self.data["codes"][field])?
                .iter()
                .any(|x| x.as_str() == Some(name)),
            "사용 중인 차량 형태, 화물 단위, 비용 항목을 확인해 주세요.",
        )
    }
    fn policy(&self, k: &str) -> bool {
        self.data["policies"][k].as_bool() == Some(true)
    }
    fn buffer(&self) -> i64 {
        self.data["policies"]["bufferMinutes"].as_i64().unwrap_or(0) * 60
    }
}

fn check(ok: bool, message: &str) -> AppResult<()> {
    if ok {
        Ok(())
    } else {
        Err(bad(message))
    }
}
fn txt<'a>(r: &'a Value, k: &str) -> &'a str {
    r[k].as_str().unwrap_or("")
}
fn required<'a>(r: &'a Value, k: &str) -> AppResult<&'a str> {
    r[k].as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| bad(&format!("필수 항목을 확인해 주세요 ({k}).")))
}
fn choice(r: &Value, k: &str, choices: &[&str]) -> AppResult<()> {
    check(
        choices.contains(&txt(r, k)),
        "입력한 상태 또는 분류를 확인해 주세요.",
    )
}
fn arr(v: &Value) -> AppResult<&[Value]> {
    v.as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| bad("목록 형식을 확인해 주세요."))
}
fn integer(r: &Value, k: &str, min: i64, max: i64) -> AppResult<i64> {
    r[k].as_i64()
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(|| bad(&format!("입력값 범위를 확인해 주세요 ({k}).")))
}
fn money(r: &Value, k: &str) -> AppResult<Option<i64>> {
    if r[k].is_null() {
        Ok(None)
    } else {
        integer(r, k, 0, 1_000_000_000).map(Some)
    }
}
fn bools(r: &Value, fields: &[&str]) -> AppResult<()> {
    check(
        fields.iter().all(|k| r[*k].is_boolean()),
        "설정 값을 확인해 주세요.",
    )
}
fn positive(r: &Value, k: &str, max: f64) -> AppResult<f64> {
    r[k].as_f64()
        .filter(|n| *n > 0. && *n <= max)
        .ok_or_else(|| bad(&format!("수량 또는 중량을 확인해 주세요 ({k}).")))
}
fn timestamp(s: &str) -> AppResult<i64> {
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Ok(t.timestamp());
    }
    for fmt in ["%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, fmt) {
            return Ok(t.and_utc().timestamp() - 9 * 3600);
        }
    }
    Err(bad("날짜와 시각을 확인해 주세요."))
}
fn interval(r: &Value) -> AppResult<(i64, i64)> {
    let a = timestamp(required(r, "start")?)?;
    let b = timestamp(required(r, "end")?)?;
    check(a < b, "종료 일시는 시작 일시 이후여야 합니다.")?;
    Ok((a, b))
}
fn overlap((a, b): (i64, i64), (c, d): (i64, i64), buffer: i64) -> bool {
    a < d + buffer && c < b + buffer
}
fn active(r: &Value) -> bool {
    !matches!(txt(r, "status"), "delivered" | "cancelled")
}
fn same_fields(old: &Value, new: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|k| old[*k] == new[*k])
}
fn same_except(old: &Value, new: &Value, keys: &[&str]) -> bool {
    [old, new].iter().all(|r| {
        r.as_object().is_some_and(|v| {
            v.keys()
                .all(|k| keys.contains(&k.as_str()) || old[k] == new[k])
        })
    })
}
fn shape(v: &Value) -> AppResult<()> {
    match v {
        Value::Object(o) => {
            for (k, v) in o {
                check(
                    k.len() <= 100
                        && !matches!(
                            k.as_str(),
                            "__proto__"
                                | "constructor"
                                | "prototype"
                                | "lat"
                                | "lng"
                                | "latitude"
                                | "longitude"
                                | "x"
                                | "y"
                                | "lastSeen"
                                | "lastFix"
                                | "voltage"
                                | "battery"
                                | "motion"
                                | "speed"
                        ),
                    "실시간 단말기 값은 업무 자료에 저장할 수 없습니다.",
                )?;
                shape(v)?;
            }
        }
        Value::Array(list) => {
            for v in list {
                shape(v)?;
            }
        }
        Value::String(s) => {
            check(
                s.len() <= 16_384 && !s.starts_with("data:image/"),
                "문자 길이 또는 사진 저장 방식을 확인해 주세요.",
            )?;
        }
        _ => {}
    }
    Ok(())
}
fn unique_text<'a>(values: impl Iterator<Item = &'a Value>, k: &str) -> AppResult<()> {
    let mut set = HashSet::new();
    for r in values {
        check(
            set.insert(required(r, k)?.trim().to_lowercase()),
            "중복된 이름 또는 번호가 있습니다.",
        )?;
    }
    Ok(())
}
fn optional_database_id(v: &Value) -> AppResult<Option<i64>> {
    if v.is_null() || v.as_str() == Some("") {
        return Ok(None);
    }
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .filter(|x| *x > 0)
        .map(Some)
        .ok_or_else(|| bad("연결할 단말기 또는 담당자 번호를 확인해 주세요."))
}

pub(super) fn validate(old: &Value, data: &Value) -> AppResult<References> {
    let root = data
        .as_object()
        .ok_or_else(|| bad("업무 자료 형식을 확인해 주세요."))?;
    check(
        root.keys().all(|k| {
            COLLECTIONS.contains(&k.as_str())
                || matches!(
                    k.as_str(),
                    "activity" | "codes" | "policies" | "integrations"
                )
        }),
        "지원하지 않는 업무 자료입니다.",
    )?;
    shape(data)?;
    let db = Index::new(data)?;
    let prev = Index::new(old)?;
    let policy = &data["policies"];
    integer(policy, "bufferMinutes", 0, 1440)?;
    integer(policy, "offlineMinutes", 1, 240)?;
    integer(policy, "acceptTimeoutMinutes", 1, 1440)?;
    bools(
        policy,
        &[
            "ownAutoConfirm",
            "requireDriverCheck",
            "requireProofForBilling",
        ],
    )?;
    bools(
        &data["integrations"],
        &[
            "dispatchNotice",
            "delayNotice",
            "proofNotice",
            "connectionNotice",
        ],
    )?;
    choice(&data["integrations"], "channel", &["앱 알림"])?;
    for key in ["vehicleTypes", "units", "chargeTypes"] {
        let opts = arr(&data["codes"][key])?;
        let mut used = HashSet::new();
        check(!opts.is_empty(), "기준정보는 한 항목 이상이어야 합니다.")?;
        for name in opts {
            check(
                name.as_str().is_some_and(|s| {
                    !s.trim().is_empty() && s.len() <= 120 && used.insert(s.trim().to_lowercase())
                }),
                "기준정보 이름과 중복을 확인해 주세요.",
            )?;
        }
    }
    for r in arr(&data["activity"])? {
        required(r, "text")?;
        timestamp(required(r, "at")?)?;
    }
    // Branch IDs are also referenced by staff assignments outside this JSON document.
    for key in [
        "branches",
        "orders",
        "shipments",
        "services",
        "incidents",
        "charges",
        "payments",
    ] {
        for r in prev.rows(key) {
            db.get(key, txt(r, "id"))
                .map_err(|_| bad("업무 거래와 이력은 삭제할 수 없습니다."))?;
        }
    }
    for (key, field) in [
        ("branches", "name"),
        ("orders", "number"),
        ("shipments", "number"),
    ] {
        unique_text(db.rows(key).iter(), field)?;
    }
    for r in db.rows("locations") {
        for k in ["name", "address", "region"] {
            required(r, k)?;
        }
    }
    for key in ["shippers", "carriers"] {
        let mut registration_numbers = HashSet::new();
        for r in db.rows(key) {
            required(r, "name")?;
            let registration = txt(r, "businessNumber");
            if !registration.is_empty() {
                let digits = registration.replace('-', "");
                let parts: Vec<_> = registration.split('-').map(str::len).collect();
                check(
                    digits.len() == 10
                        && digits.bytes().all(|b| b.is_ascii_digit())
                        && (parts == [10] || parts == [3, 2, 5]),
                    "사업자등록번호를 확인해 주세요.",
                )?;
                check(
                    registration_numbers.insert(digits),
                    "이미 등록된 사업자등록번호입니다.",
                )?;
            }
            bools(r, &["active"])?;
        }
    }
    for r in db.rows("drivers") {
        required(r, "name")?;
        db.link(r, "branchId", "branches", true)?;
        db.link(r, "carrierId", "carriers", true)?;
        bools(r, &["active", "licenseChecked"])?;
        choice(r, "availability", &["available", "off"])?;
        if let Some(before) = prev.find("drivers", txt(r, "id")) {
            if !same_fields(
                before,
                r,
                &[
                    "carrierId",
                    "branchId",
                    "active",
                    "availability",
                    "licenseChecked",
                ],
            ) && db
                .rows("shipments")
                .iter()
                .any(|s| active(s) && s["driverId"] == r["id"])
            {
                check(
                    same_fields(before, r, &["carrierId", "branchId"])
                        && r["active"] == true
                        && txt(r, "availability") == "available"
                        && (!db.policy("requireDriverCheck") || r["licenseChecked"] == true),
                    "배차된 기사의 소속과 가동 상태를 확인해 주세요.",
                )?;
            }
        }
    }
    let mut devices = HashSet::new();
    let mut plates = HashSet::new();
    let mut new_devices = Vec::new();
    for r in db.rows("vehicles") {
        let plate = required(r, "plate")?
            .split_whitespace()
            .collect::<String>()
            .to_uppercase();
        check(plates.insert(plate), "이미 등록된 차량번호입니다.")?;
        db.code("vehicleTypes", required(r, "type")?)?;
        integer(r, "capacityKg", 1, 100_000)?;
        choice(r, "readiness", &["ready", "hold", "maintenance"])?;
        db.link(r, "branchId", "branches", true)?;
        db.link(r, "carrierId", "carriers", true)?;
        db.link(r, "driverId", "drivers", true)?;
        if let Some(d) = db.find("drivers", txt(r, "driverId")) {
            check(
                txt(d, "carrierId") == txt(r, "carrierId"),
                "차량과 담당 기사의 운송사가 다릅니다.",
            )?;
        }
        let blocked = db.rows("incidents").iter().any(|i| {
            i["vehicleId"] == r["id"]
                && txt(i, "status") == "open"
                && (txt(i, "type") == "사고" || i["vehicleBlocked"] == true)
        });
        if blocked {
            check(
                txt(r, "readiness") == "hold",
                "미처리 운행 제한이 있는 차량은 배차에서 제외해 주세요.",
            )?;
        }
        if let Some(old) = prev.find("vehicles", txt(r, "id")) {
            if db
                .rows("shipments")
                .iter()
                .any(|s| s["vehicleId"] == r["id"] && active(s))
            {
                check(
                    same_fields(
                        old,
                        r,
                        &["type", "capacityKg", "branchId", "carrierId", "driverId"],
                    ),
                    "진행 중인 배차의 차량 조건을 먼저 확인해 주세요.",
                )?;
            }
            if !r["odometer"].is_null() {
                integer(
                    r,
                    "odometer",
                    old["odometer"].as_i64().unwrap_or(0),
                    10_000_000,
                )?;
            }
        }
        if let Some(id) = optional_database_id(&r["deviceId"])? {
            check(
                devices.insert(id),
                "같은 단말기를 두 차량에 연결할 수 없습니다.",
            )?;
            if prev
                .find("vehicles", txt(r, "id"))
                .map(|v| optional_database_id(&v["deviceId"]))
                .transpose()?
                .flatten()
                != Some(id)
            {
                new_devices.push(id);
            }
        }
    }
    for r in db.rows("rates") {
        for k in ["name", "pickupRegion", "dropoffRegion"] {
            required(r, k)?;
        }
        db.code("vehicleTypes", required(r, "vehicleType")?)?;
        positive(r, "capacityKg", 100_000.)?;
        money(r, "sellAmount")?;
        money(r, "buyAmount")?;
    }
    check_master_events(&prev, &db)?;
    let images = dispatch::validate(&prev, &db)?;
    finance::validate(&prev, &db)?;
    let mut new_staff = HashSet::new();
    for order in db.rows("orders") {
        if let Some(old) = prev.find("orders", txt(order, "id")) {
            if same_fields(old, order, &["userId", "branchId"]) {
                continue;
            }
        }
        if let Some(id) = optional_database_id(&order["userId"])? {
            new_staff.insert((id, required(order, "branchId")?.to_owned()));
        }
    }
    Ok(References {
        new_devices,
        new_staff: new_staff.into_iter().collect(),
        images,
    })
}

fn check_master_events(prev: &Index, db: &Index) -> AppResult<()> {
    for event in db.rows("incidents") {
        db.link(event, "vehicleId", "vehicles", false)?;
        db.link(event, "shipmentId", "shipments", true)?;
        if let Some(s) = db.find("shipments", txt(event, "shipmentId")) {
            check(
                s["vehicleId"] == event["vehicleId"],
                "운송 건과 차량을 확인해 주세요.",
            )?;
        }
        required(event, "note")?;
        timestamp(required(event, "at")?)?;
        choice(event, "status", &["open", "resolved"])?;
        choice(event, "type", &["지연", "사고", "화물 손상", "기타"])?;
        choice(event, "severity", &["normal", "urgent"])?;
        if txt(event, "type") == "사고" {
            check(
                event["vehicleBlocked"] == true,
                "사고 차량은 배차 중지 상태로 등록해 주세요.",
            )?;
        }
        if let Some(old) = prev.find("incidents", txt(event, "id")) {
            if old != event {
                check(
                    txt(old, "status") == "open"
                        && txt(event, "status") == "resolved"
                        && same_except(
                            old,
                            event,
                            &["resolution", "resolvedAt", "status", "history"],
                        ),
                    "처리한 사고·지연 내역을 확인해 주세요.",
                )?;
                required(event, "resolution")?;
                timestamp(required(event, "resolvedAt")?)?;
            }
        } else {
            choice(event, "status", &["open"])?;
        }
    }
    for r in db.rows("services") {
        db.link(r, "vehicleId", "vehicles", false)?;
        choice(r, "type", &["정비", "검사", "보험"])?;
        choice(r, "status", &["scheduled", "done"])?;
        let times = interval(r)?;
        integer(r, "cost", 0, 1_000_000_000)?;
        let before = prev.find("services", txt(r, "id"));
        if before == Some(r) {
            continue;
        }
        if let Some(old) = before {
            check(
                txt(old, "status") != "done",
                "완료된 정비 이력은 수정할 수 없습니다.",
            )?;
        }
        if txt(r, "status") == "done" {
            check(
                before
                    .is_some_and(|old| same_except(old, r, &["status", "completedAt", "history"])),
                "등록된 정비 일정의 완료를 기록해 주세요.",
            )?;
            timestamp(required(r, "completedAt")?)?;
        } else {
            for other in db.rows("services").iter().filter(|s| {
                s["vehicleId"] == r["vehicleId"]
                    && s["id"] != r["id"]
                    && txt(s, "status") == "scheduled"
            }) {
                check(
                    !overlap(times, interval(other)?, 0),
                    "다른 정비·보험 일정과 겹칩니다.",
                )?;
            }
            for ship in db
                .rows("shipments")
                .iter()
                .filter(|s| active(s) && s["vehicleId"] == r["vehicleId"])
            {
                check(
                    !overlap(times, interval(ship)?, db.buffer()),
                    "정비 일정과 진행 중인 배차가 겹칩니다.",
                )?;
            }
        }
    }
    Ok(())
}
