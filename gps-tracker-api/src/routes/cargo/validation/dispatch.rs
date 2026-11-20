use super::*;
use chrono::{Datelike, NaiveDate, Utc};

fn order_fields(r: &Value, db: &Index) -> AppResult<()> {
    db.link(r, "shipperId", "shippers", false)?;
    db.link(r, "branchId", "branches", false)?;
    db.link(r, "pickupLocationId", "locations", false)?;
    db.link(r, "dropoffLocationId", "locations", false)?;
    check(
        r["pickupLocationId"] != r["dropoffLocationId"],
        "상차지와 하차지를 구분해 주세요.",
    )?;
    required(r, "cargoName")?;
    positive(r, "quantity", 1_000_000.)?;
    for key in ["weightKg", "capacityKg"] {
        integer(r, key, 1, 100_000)?;
    }
    db.code("vehicleTypes", required(r, "vehicleType")?)?;
    db.code("units", required(r, "unit")?)?;
    choice(r, "temperature", &["상온", "냉장", "냉동"])?;
    check(
        txt(r, "temperature") == "상온" || txt(r, "vehicleType") == "냉장·냉동",
        "저온 화물에는 냉장·냉동 차량이 필요합니다.",
    )?;
    choice(r, "tripType", &["편도", "왕복"])?;
    money(r, "sellAmount")?;
    money(r, "buyAmount")?;
    Ok(())
}

pub(super) fn validate(prev: &Index, db: &Index) -> AppResult<Vec<String>> {
    for r in db.rows("recurring") {
        order_fields(r, db)?;
        required(r, "name")?;
        bools(r, &["active"])?;
        let times = ["startTime", "endTime"].map(|k| NaiveTime::parse_from_str(txt(r, k), "%H:%M"));
        check(
            matches!(times,[Ok(a),Ok(b)] if a<b),
            "반복 주문의 시작·종료 시각을 확인해 주세요.",
        )?;
        let days = arr(&r["weekdays"])?;
        let mut set = HashSet::new();
        check(
            !days.is_empty()
                && days.iter().all(|v| {
                    v.as_i64()
                        .is_some_and(|d| (0..=6).contains(&d) && set.insert(d))
                }),
            "반복 요일을 확인해 주세요.",
        )?;
    }
    let mut exts = HashSet::new();
    let mut repeats = HashSet::new();
    let mut linked = HashMap::new();
    let mut files = HashSet::new();
    for s in db.rows("shipments") {
        let sid = required(s, "id")?;
        let state = required(s, "status")?;
        db.link(s, "vehicleId", "vehicles", false)?;
        db.link(s, "driverId", "drivers", false)?;
        db.link(s, "carrierId", "carriers", true)?;
        let times = interval(s)?;
        let ids = arr(&s["orderIds"])?;
        check(ids.len() == 1, "현재 배차는 주문 한 건씩 지정해 주세요.")?;
        let oid = ids[0]
            .as_str()
            .ok_or_else(|| bad("배차 주문을 선택해 주세요."))?;
        let order = db.get("orders", oid)?;
        let alloc = arr(&s["allocations"])?;
        let before = prev.find("shipments", sid);
        if before.is_none() || state != "cancelled" {
            check(
                alloc.len() == 1
                    && alloc[0]["orderId"] == order["id"]
                    && same_fields(&alloc[0], order, &["quantity", "weightKg"])
                    && s["branchId"] == order["branchId"]
                    && interval(order)? == times,
                "주문과 배차의 시간·지점·수량을 확인해 주세요.",
            )?;
        }
        if state != "cancelled" {
            check(
                linked.insert(oid, (sid, state)).is_none(),
                "같은 주문이 이미 배차되었습니다.",
            )?;
        }
        let vehicle = db.get("vehicles", required(s, "vehicleId")?)?;
        let driver = db.get("drivers", required(s, "driverId")?)?;
        let assigned_state = if txt(vehicle, "carrierId").is_empty() && db.policy("ownAutoConfirm")
        {
            "confirmed"
        } else {
            "requested"
        };
        let old_state = before.map(|r| txt(r, "status")).unwrap_or("");
        let events = arr(&s["events"])?;
        let previous_events = if let Some(old) = before {
            arr(&old["events"])?
        } else {
            &[]
        };
        check(
            events.starts_with(previous_events),
            "이전 운송 단계 이력을 유지해 주세요.",
        )?;
        let reassigned = before.is_some_and(|r| {
            !same_fields(r, s, &["vehicleId", "driverId", "carrierId"])
                || events
                    .get(previous_events.len())
                    .is_some_and(|e| txt(e, "type") == "reassigned")
        });
        let mut verify_pair = false;
        let event_kind = if let Some(old) = before {
            check(
                same_fields(
                    old,
                    s,
                    &[
                        "number",
                        "orderIds",
                        "allocations",
                        "start",
                        "end",
                        "branchId",
                    ],
                ),
                "배차 주문과 일정은 변경할 수 없습니다.",
            )?;
            if reassigned {
                check(
                    matches!(old_state, "requested" | "confirmed")
                        && state == assigned_state
                        && txt(old, "invoiceStatus") != "issued"
                        && txt(old, "payableStatus") != "confirmed"
                        && !prev
                            .rows("payments")
                            .iter()
                            .any(|p| p["shipmentId"] == s["id"]),
                    "진행 또는 정산 중인 배차는 변경할 수 없습니다.",
                )?;
                required(s, "note")?;
                verify_pair = true;
                "reassigned"
            } else if old_state == state {
                ""
            } else {
                match (old_state, state) {
                    ("requested", "confirmed") => {
                        verify_pair = true;
                        "confirmed"
                    }
                    ("confirmed", "loading") => {
                        verify_pair = true;
                        "arrived"
                    }
                    ("loading", "in_transit") => "loaded",
                    ("in_transit", "delivered") => "delivered",
                    ("requested" | "confirmed", "cancelled") => {
                        required(s, "cancelReason")?;
                        if old_state == "requested"
                            && events.last().is_some_and(|e| txt(e, "type") == "declined")
                        {
                            "declined"
                        } else {
                            "cancelled"
                        }
                    }
                    _ => return Err(bad("운송 진행 순서를 확인해 주세요.")),
                }
            }
        } else {
            check(
                prev.find("orders", oid)
                    .is_some_and(|o| txt(o, "status") == "open")
                    && state == assigned_state,
                "미배차 주문에서 배차를 등록해 주세요.",
            )?;
            verify_pair = true;
            assigned_state
        };
        if event_kind.is_empty() {
            check(
                events.len() == previous_events.len(),
                "운송 단계에 맞는 이력만 기록할 수 있습니다.",
            )?;
        } else {
            check(
                events.len() == previous_events.len() + 1
                    && events.last().is_some_and(|r| txt(r, "type") == event_kind),
                "현재 단계와 운송 이력이 일치하지 않습니다.",
            )?;
            let at = timestamp(required(events.last().unwrap(), "at")?)?;
            if let Some(last) = previous_events.last() {
                check(
                    at >= timestamp(required(last, "at")?)?,
                    "처리 시각이 이전 업무 기록보다 빠릅니다.",
                )?;
            }
        }
        if verify_pair {
            check(
                s["carrierId"].as_str().unwrap_or("") == txt(vehicle, "carrierId")
                    && txt(vehicle, "carrierId") == txt(driver, "carrierId")
                    && txt(vehicle, "readiness") == "ready"
                    && vehicle["manualHold"] != true
                    && driver["active"] == true
                    && txt(driver, "availability") == "available"
                    && (!db.policy("requireDriverCheck") || driver["licenseChecked"] == true),
                "차량·기사의 소속과 가동 상태를 확인해 주세요.",
            )?;
            if let Some(c) = db.find("carriers", txt(vehicle, "carrierId")) {
                check(c["active"] == true, "사용 중인 운송사를 선택해 주세요.")?;
            }
            check(
                vehicle["type"] == order["vehicleType"]
                    && vehicle["capacityKg"].as_f64().unwrap_or(0.)
                        >= positive(order, "weightKg", 100_000.)?.max(positive(
                            order,
                            "capacityKg",
                            100_000.,
                        )?)
                    && (txt(order, "temperature") == "상온" || txt(vehicle, "type") == "냉장·냉동"),
                "차량 형태·적재능력·온도 조건을 확인해 주세요.",
            )?;
            for other in db.rows("shipments").iter().filter(|r| {
                r["id"] != s["id"]
                    && active(r)
                    && (r["vehicleId"] == s["vehicleId"] || r["driverId"] == s["driverId"])
            }) {
                let other_times = interval(other)?;
                check(
                    other_times.1 >= Utc::now().timestamp()
                        && !overlap(times, other_times, db.buffer())
                        && !(state == "loading"
                            && matches!(txt(other, "status"), "loading" | "in_transit")),
                    "같은 차량·기사에 진행 중이거나 겹치는 운송이 있습니다.",
                )?;
            }
            for svc in db
                .rows("services")
                .iter()
                .filter(|r| r["vehicleId"] == s["vehicleId"] && txt(r, "status") == "scheduled")
            {
                check(
                    !overlap(times, interval(svc)?, db.buffer()),
                    "정비·보험 일정과 겹칩니다.",
                )?;
            }
            check(
                !db.rows("incidents").iter().any(|r| {
                    r["vehicleId"] == s["vehicleId"]
                        && txt(r, "status") == "open"
                        && (r["vehicleBlocked"] == true || txt(r, "type") == "사고")
                }),
                "미처리 사고 또는 운행 제한을 확인해 주세요.",
            )?;
        }
        proof(before, s, &mut files)?;
    }
    for o in db.rows("orders") {
        let id = required(o, "id")?;
        let state = required(o, "status")?;
        let before = prev.find("orders", id);
        order_fields(o, db)?;
        interval(o)?;
        if before.is_none() {
            choice(o, "status", &["open"])?;
            timestamp(required(o, "createdAt")?)?;
        }
        if before.is_none() || before.is_some_and(|r| r["shipperId"] != o["shipperId"]) {
            check(
                db.get("shippers", txt(o, "shipperId"))?["active"] == true,
                "사용 중인 화주를 선택해 주세요.",
            )?;
        }
        if let Some(old) = before {
            check(
                same_fields(
                    old,
                    o,
                    &["number", "createdAt", "recurringId", "recurringDate"],
                ),
                "주문 번호와 생성 정보를 확인해 주세요.",
            )?;
            if txt(old, "status") != "open" || state != "open" {
                check(
                    same_except(old, o, &["status", "shipmentId", "history", "cancelReason"]),
                    "배차된 주문 정보를 직접 변경할 수 없습니다.",
                )?;
            }
            if matches!(txt(old, "status"), "cancelled" | "completed") {
                check(
                    old["status"] == o["status"],
                    "종료한 주문의 상태는 변경할 수 없습니다.",
                )?;
            }
        }
        match linked.get(id) {
            Some((sid, ship_state)) => {
                check(
                    txt(o, "shipmentId") == *sid
                        && state
                            == if *ship_state == "delivered" {
                                "completed"
                            } else {
                                "assigned"
                            },
                    "주문의 운송 상태와 배차가 일치하지 않습니다.",
                )?;
            }
            None => {
                check(
                    matches!(state, "open" | "cancelled") && txt(o, "shipmentId").is_empty(),
                    "미배차·취소 주문의 배차 연결을 확인해 주세요.",
                )?;
            }
        }
        let external = txt(o, "externalRef").trim().to_lowercase();
        if !external.is_empty() {
            check(
                exts.insert((txt(o, "shipperId"), external)),
                "같은 화주의 외부 주문번호가 중복되었습니다.",
            )?;
        }
        if !txt(o, "recurringId").is_empty() {
            let template = db.get("recurring", txt(o, "recurringId"))?;
            let date = required(o, "recurringDate")?;
            check(
                repeats.insert((txt(o, "recurringId"), date)),
                "해당 날짜의 정기 주문이 이미 있습니다.",
            )?;
            if before.is_none() {
                let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map_err(|_| bad("생성 날짜를 확인해 주세요."))?;
                let weekday = date.weekday().num_days_from_sunday() as i64;
                check(
                    template["active"] == true
                        && arr(&template["weekdays"])?
                            .iter()
                            .any(|v| v.as_i64() == Some(weekday))
                        && txt(o, "start").starts_with(&date.to_string()),
                    "사용 중인 반복 주문의 요일과 날짜를 확인해 주세요.",
                )?;
            }
        }
    }
    Ok(files.into_iter().map(str::to_owned).collect())
}

fn proof<'a>(old: Option<&Value>, s: &'a Value, files: &mut HashSet<&'a str>) -> AppResult<()> {
    let p = &s["proof"];
    let state = required(p, "status")?;
    let before = old.map(|r| &r["proof"]);
    let previous = before.map(|r| txt(r, "status")).unwrap_or("missing");
    let photos = arr(&p["files"])?;
    check(
        photos.len() <= 3,
        "인수증은 최대 3장까지 등록할 수 있습니다.",
    )?;
    let mut local = HashSet::new();
    for photo in photos {
        let id = required(photo, "id")?;
        check(
            uuid::Uuid::parse_str(id).is_ok()
                && required(photo, "name")?.len() <= 512
                && local.insert(id)
                && photo
                    .as_object()
                    .is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "id" | "name"))),
            "첨부 사진을 확인해 주세요.",
        )?;
        files.insert(id);
    }
    if state == "missing" {
        return check(
            previous == "missing" && photos.is_empty(),
            "제출한 인수증을 삭제할 수 없습니다.",
        );
    }
    check(
        txt(s, "status") == "delivered",
        "하차 완료 후 인수증을 등록할 수 있습니다.",
    )?;
    if before == Some(p) {
        return Ok(());
    }
    if state == "submitted" && matches!(previous, "missing" | "rework" | "submitted") {
        check(
            !photos.is_empty()
                || (!txt(p, "receiver").trim().is_empty() && !txt(p, "note").trim().is_empty()),
            "사진 또는 수령인과 확인 내용을 입력해 주세요.",
        )?;
        let at = timestamp(required(p, "at")?)?;
        let delivered = arr(&s["events"])?
            .iter()
            .find(|e| txt(e, "type") == "delivered")
            .ok_or_else(|| bad("하차 기록을 확인해 주세요."))?;
        return check(
            at >= timestamp(required(delivered, "at")?)?,
            "수령 확인 시각은 하차 완료 이후여야 합니다.",
        );
    }
    check(
        previous == "submitted"
            && matches!(state, "approved" | "rework")
            && before.is_some_and(|r| same_except(r, p, &["status", "reviewNote", "reviewedAt"])),
        "인수증 제출·보완·승인 순서를 확인해 주세요.",
    )?;
    timestamp(required(p, "reviewedAt")?)?;
    if state == "rework" {
        required(p, "reviewNote")?;
    }
    Ok(())
}
