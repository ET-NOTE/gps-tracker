//! Shared voltage estimate for the 1S GPS product. Never rewrites raw telemetry.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
pub struct Policy {
    pub normal_min_mv: i32,
    pub critical_below_mv: i32,
    pub valid_min_mv: i32,
    pub valid_max_mv: i32,
    curve: Vec<(i32, i32)>,
}

pub fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../battery-policy.json")).expect("battery policy")
    })
}

pub fn estimate(mv: i32) -> Option<(&'static str, i32)> {
    let p = policy();
    if !(p.valid_min_mv..=p.valid_max_mv).contains(&mv) {
        return None;
    }
    let label = if mv < p.critical_below_mv {
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
        _ => "배터리 알림 기준 도달",
    }
}

pub fn alert_body(mv: Option<i32>) -> String {
    match mv.and_then(|v| estimate(v).map(|(label, pct)| (v, label, pct))) {
        Some((v, label, pct)) => format!(
            "{label} · 약 {pct}% (전압 기반 추정) · {:.2} V. 배터리와 전원 연결을 확인해 주세요.",
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
        assert_eq!(estimate(5000), None);
        assert_eq!(estimate(2800), Some(("전압 매우 부족", 0)));
        assert_eq!(estimate(2899).unwrap().0, "전압 매우 부족");
        assert_eq!(estimate(2900).unwrap().0, "저전압");
        assert_eq!(estimate(3299).unwrap().0, "저전압");
        assert_eq!(estimate(3300).unwrap().0, "정상");
        assert_eq!(estimate(3910), Some(("정상", 75)));
        assert_eq!(estimate(4200), Some(("정상", 100)));
        assert_eq!(estimate(4300).unwrap().1, 100);
        assert!(alert_body(Some(2800)).contains("전압 기반 추정"));
        assert_eq!(alert_title(Some(3898)), "배터리 알림 기준 도달");
        let percentages: Vec<_> = (1000..=4500).map(|v| estimate(v).unwrap().1).collect();
        assert!(percentages.windows(2).all(|w| w[0] <= w[1]));
    }
}
