use super::*;

fn side(p: &Value) -> AppResult<(usize, i64)> {
    let amount = integer(p, "amount", 1, 1_000_000_000)?;
    match txt(p, "side") {
        "receipt" => Ok((0, amount)),
        "payout" => Ok((1, amount)),
        "receipt_refund" => Ok((0, -amount)),
        "payout_refund" => Ok((1, -amount)),
        _ => Err(bad("수납·지급 구분을 확인해 주세요.")),
    }
}

pub(super) fn validate(prev: &Index, db: &Index) -> AppResult<()> {
    let mut extras: HashMap<&str, [i64; 2]> = HashMap::new();
    let mut reopen = HashSet::new();
    for c in db.rows("charges") {
        let sid = required(c, "shipmentId")?;
        db.get("shipments", sid)?;
        required(c, "note")?;
        timestamp(required(c, "at")?)?;
        db.code("chargeTypes", required(c, "kind")?)?;
        let sell = integer(c, "sellAmount", 0, 1_000_000_000)?;
        let buy = integer(c, "buyAmount", 0, 1_000_000_000)?;
        let direct = integer(c, "companyCost", 0, 1_000_000_000)?;
        check(
            sell + buy + direct > 0,
            "추가 비용 중 한 항목 이상을 입력해 주세요.",
        )?;
        let status = required(c, "status")?;
        if let Some(before) = prev.find("charges", txt(c, "id")) {
            if before != c {
                match (txt(before, "status"), status) {
                    ("pending" | "rejected", "pending") => {}
                    ("pending", "approved" | "rejected") => {
                        check(
                            same_except(
                                before,
                                c,
                                &["status", "reviewNote", "reviewedAt", "history"],
                            ),
                            "비용 검토 시 제출한 금액과 운송 건을 확인해 주세요.",
                        )?;
                        timestamp(required(c, "reviewedAt")?)?;
                        if status == "rejected" {
                            required(c, "reviewNote")?;
                        } else {
                            if sell > 0 {
                                reopen.insert((sid, 0));
                            }
                            if buy > 0 {
                                reopen.insert((sid, 1));
                            }
                        }
                    }
                    _ => return Err(bad("승인한 비용을 수정할 수 없습니다.")),
                }
            }
        } else {
            choice(c, "status", &["pending"])?;
        }
        if status == "approved" {
            let sums = extras.entry(sid).or_default();
            sums[0] += sell;
            sums[1] += buy;
        }
    }
    let mut net: HashMap<&str, [i64; 2]> = HashMap::new();
    for p in prev.rows("payments") {
        check(
            db.find("payments", txt(p, "id")) == Some(p),
            "기존 수납·지급 내역은 수정할 수 없습니다.",
        )?;
        let (i, n) = side(p)?;
        net.entry(txt(p, "shipmentId")).or_default()[i] += n;
    }
    let mut totals = HashMap::new();
    for s in db.rows("shipments") {
        let id = required(s, "id")?;
        let mut sum = [None; 2];
        for (i, (amount, flag, confirmed)) in [
            ("sellAmount", "invoiceStatus", "issued"),
            ("buyAmount", "payableStatus", "confirmed"),
        ]
        .into_iter()
        .enumerate()
        {
            let v = money(s, amount)?;
            let base = if txt(s, "status") == "cancelled" {
                Some(0)
            } else {
                v
            };
            sum[i] = base.map(|n| n + extras.get(id).copied().unwrap_or_default()[i]);
            let status = required(s, flag)?;
            check(
                status == "draft" || status == confirmed,
                "정산 상태를 확인해 주세요.",
            )?;
            let before = prev.find("shipments", id);
            if reopen.contains(&(id, i)) {
                check(
                    status == "draft",
                    "승인한 추가 금액을 반영하여 정산을 다시 확인해 주세요.",
                )?;
            }
            if let Some(old) = before {
                if old[amount] != s[amount] {
                    check(
                        txt(old, flag) != confirmed
                            && net.get(id).copied().unwrap_or_default()[i] == 0,
                        "정산 또는 거래 기록이 있는 기본 금액은 변경할 수 없습니다.",
                    )?;
                }
                if txt(old, flag) == confirmed && status == "draft" {
                    check(
                        reopen.contains(&(id, i)),
                        "확인한 정산은 승인된 추가비가 있을 때 다시 열 수 있습니다.",
                    )?;
                }
            } else {
                check(status == "draft", "배차 후 정산을 확인해 주세요.")?;
            }
            if status == confirmed && before.is_some_and(|v| txt(v, flag) != confirmed) {
                check(sum[i].is_some(), "기본 운임 또는 원가를 먼저 정해 주세요.")?;
                if i == 0 && txt(s, "status") != "cancelled" {
                    check(
                        txt(s, "status") == "delivered"
                            && (!db.policy("requireProofForBilling")
                                || txt(&s["proof"], "status") == "approved"),
                        "하차 완료와 인수증 승인 상태를 확인해 주세요.",
                    )?;
                }
            }
        }
        totals.insert(id, sum);
    }
    // Each save posts one voucher. This avoids a refund depending on the array's display order.
    let mut posted = false;
    for p in db
        .rows("payments")
        .iter()
        .filter(|p| prev.find("payments", txt(p, "id")).is_none())
    {
        check(!posted, "수납·지급은 거래 한 건씩 등록해 주세요.")?;
        posted = true;
        let id = required(p, "shipmentId")?;
        let total = totals
            .get(id)
            .ok_or_else(|| bad("운송 건을 확인해 주세요."))?;
        let (i, delta) = side(p)?;
        choice(p, "method", &["계좌이체", "카드", "현금"])?;
        timestamp(required(p, "at")?)?;
        let current = net.get(id).copied().unwrap_or_default()[i];
        if delta < 0 {
            required(p, "note")?;
            check(
                -delta <= current,
                "환불·환수액은 순거래액을 넘을 수 없습니다.",
            )?;
        } else {
            check(
                total[i].is_some_and(|n| current + delta <= n),
                "수납·지급액이 현재 잔액을 넘습니다.",
            )?;
        }
    }
    Ok(())
}
