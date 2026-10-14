//! Shared voltage estimate for the 1S GPS product. Never rewrites raw telemetry.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
pub struct Policy {
    pub version: String,
    pub normal_min_mv: i32,
    pub critical_below_mv: i32,
    pub valid_min_mv: i32,
    pub valid_max_mv: i32,
    pub normal_max_raw_mv: i32,
    curve: Vec<(i32, i32)>,
    calibration: Calibration,
}

#[derive(Deserialize)]
struct Calibration {
    points: Vec<(i32, i32)>,
}

pub fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../battery-policy.json")).expect("battery policy")
    })
}

pub fn calibrated_mv(mv: i32) -> Option<i32> {
    let p = policy();
    if !(p.valid_min_mv..=p.valid_max_mv).contains(&mv) {
        return None;
    }
    let points = &p.calibration.points;
    if mv <= points[0].0 {
        return Some(mv + points[0].1 - points[0].0);
    }
    for w in points.windows(2) {
        let (lo, lv) = w[0];
        let (hi, hv) = w[1];
        if mv <= hi {
            return Some(lv + ((mv - lo) * (hv - lv) + (hi - lo) / 2) / (hi - lo));
        }
    }
    let (raw, value) = *points.last().expect("battery calibration points");
    Some(mv + value - raw)
}

/// Only call with a trusted SQL expression, never user input. Generates the same
/// integer interpolation as Rust/JS for stale-notification eligibility checks.
pub fn sql_calibrated_mv(expression: &str) -> String {
    let p = policy();
    let points = &p.calibration.points;
    let x = format!("({expression})");
    let mut sql = format!(
        "CASE WHEN {x} IS NULL OR {x} NOT BETWEEN {} AND {} THEN NULL WHEN {x} <= {} THEN {x} + {}",
        p.valid_min_mv,
        p.valid_max_mv,
        points[0].0,
        points[0].1 - points[0].0
    );
    for w in points.windows(2) {
        let (lo, lv) = w[0];
        let (hi, hv) = w[1];
        sql.push_str(&format!(
            " WHEN {x} <= {hi} THEN {lv} + (({x} - {lo}) * {} + {}) / {}",
            hv - lv,
            (hi - lo) / 2,
            hi - lo
        ));
    }
    let (raw, value) = *points.last().expect("battery calibration points");
    sql.push_str(&format!(" ELSE {x} + {} END", value - raw));
    sql
}

pub fn estimate(raw_mv: i32) -> Option<(&'static str, i32)> {
    let mv = calibrated_mv(raw_mv)?;
    let p = policy();
    // The user-selected charging ceiling is in received ADC mV, not calibrated mV.
    let label = if raw_mv > p.normal_max_raw_mv {
        "과충전"
    } else if mv < p.critical_below_mv {
        "전압 매우 부족"
    } else if mv < p.normal_min_mv {
        "저전압"
    } else {
        "정상"
    };
    let mut percent = if mv <= p.curve[0].0 { 0 } else { 100 };
    for w in p.curve.windows(2) {
        let (lo, lp) = w[0];
        let (hi, hp) = w[1];
        if mv > lo && mv <= hi {
            percent =
                (lp as f64 + (mv - lo) as f64 * (hp - lp) as f64 / (hi - lo) as f64).round() as i32;
            break;
        }
    }
    Some((label, percent))
}

pub fn alert_title(mv: Option<i32>) -> &'static str {
    match mv.and_then(estimate) {
        Some(("전압 매우 부족", _)) => "전압 매우 부족",
        Some(("저전압", _)) => "저전압",
        Some(("과충전", _)) => "과충전",
        _ => "배터리 알림 기준 도달",
    }
}

pub fn alert_body(mv: Option<i32>) -> String {
    match mv.and_then(|v| estimate(v).map(|(label, pct)| (calibrated_mv(v).unwrap(), label, pct))) {
        Some((v, label, pct)) => format!(
            "{label} · 약 {pct}% (전압 기반 추정) · {:.2} V (보정). 배터리와 전원 연결을 확인해 주세요.",
            v as f64 / 1000.0
        ),
        None => "배터리 전압을 확인해 주세요.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundaries_missing_values_and_estimate_are_consistent() {
        assert_eq!(estimate(0), None);
        assert_eq!(estimate(65536), None);
        assert_eq!(estimate(2500), Some(("전압 매우 부족", 0)));
        assert_eq!(estimate(2875).unwrap().0, "전압 매우 부족");
        assert_eq!(estimate(2876).unwrap().0, "저전압");
        assert_eq!(estimate(3331).unwrap().0, "저전압");
        assert_eq!(estimate(3332).unwrap().0, "정상");
        assert_eq!(estimate(3901), Some(("정상", 75)));
        assert_eq!(estimate(4200), Some(("정상", 100)));
        assert_eq!(estimate(4300).unwrap().1, 100);
        assert!(alert_body(Some(2800)).contains("전압 기반 추정"));
        assert_eq!(alert_title(Some(3898)), "배터리 알림 기준 도달");
        assert_eq!(calibrated_mv(2689), Some(2761));
        assert_eq!(calibrated_mv(3253), Some(3219));
        assert_eq!(calibrated_mv(2500), Some(2597));
        assert!(alert_body(Some(2500)).contains("2.60 V"));
        assert_eq!(calibrated_mv(0), None);
        let voltages: Vec<_> = (1000..=4500).map(|v| calibrated_mv(v).unwrap()).collect();
        assert!(voltages.windows(2).all(|w| w[0] <= w[1]));
        let percentages: Vec<_> = (1000..=4500).map(|v| estimate(v).unwrap().1).collect();
        assert!(percentages.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn charging_telemetry_stays_visible_with_an_inclusive_raw_ceiling() {
        assert_eq!(calibrated_mv(4772), Some(4775));
        assert_eq!(estimate(4501), Some(("정상", 100)));
        assert_eq!(estimate(4772), Some(("정상", 100)));
        assert_eq!(estimate(5272), Some(("정상", 100)));
        assert_eq!(estimate(5273), Some(("과충전", 100)));
        assert_eq!(estimate(6000), Some(("과충전", 100)));
        assert_eq!(calibrated_mv(6000), Some(6003));
        assert_eq!(estimate(65535), Some(("과충전", 100)));
        assert_eq!(estimate(-1), None);
        assert_eq!(estimate(i32::MAX), None);
    }
}
