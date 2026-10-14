//! Conditional runtime from the standard device's absolute-time discharge record.
//! Does not infer battery capacity, charging detection, or a safe cutoff voltage.
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Deserialize)]
pub struct RuntimePolicy {
    version: String,
    reference_seconds: i64,
    reference_label: String,
    note: String,
    external_power_above_mv: i32,
    stale_after_seconds: i64,
    curve: Vec<(i32, i64)>,
}

pub fn policy() -> &'static RuntimePolicy {
    static POLICY: OnceLock<RuntimePolicy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../battery-runtime-policy.json"))
            .expect("battery runtime policy")
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeEstimate {
    pub status: &'static str,
    pub remaining_seconds: Option<i64>,
    pub estimated_empty_at: Option<DateTime<Utc>>,
    pub measurement_at: Option<DateTime<Utc>>,
    pub reference_seconds: i64,
    pub reference_label: &'static str,
    pub note: &'static str,
    pub model: &'static str,
}

fn seconds_at_voltage(mv: i32) -> i64 {
    let p = policy();
    if mv <= p.curve[0].0 {
        return 0;
    }
    for pair in p.curve.windows(2) {
        let (lo, ls) = pair[0];
        let (hi, hs) = pair[1];
        if mv <= hi {
            return ls
                + (i64::from(mv - lo) * (hs - ls) + i64::from(hi - lo) / 2) / i64::from(hi - lo);
        }
    }
    p.reference_seconds
}

pub fn estimate(
    raw_mv: Option<i32>,
    measured_at: Option<DateTime<Utc>>,
    sleeping: bool,
    now: DateTime<Utc>,
) -> RuntimeEstimate {
    let p = policy();
    let mut result = RuntimeEstimate {
        status: "unavailable",
        remaining_seconds: None,
        estimated_empty_at: None,
        measurement_at: measured_at,
        reference_seconds: p.reference_seconds,
        reference_label: &p.reference_label,
        note: &p.note,
        model: &p.version,
    };
    let Some(mv) = raw_mv.and_then(super::battery::calibrated_mv) else {
        return result;
    };
    if sleeping {
        result.status = "sleeping";
        return result;
    }
    let Some(at) = measured_at else {
        return result;
    };
    let age = (now - at).num_seconds();
    if age > p.stale_after_seconds || age < -60 {
        result.status = "stale";
        return result;
    }
    // This is only an external-power possibility, not a confirmed charger flag.
    if mv > p.external_power_above_mv {
        result.status = "external_power_possible";
        return result;
    }
    let seconds = seconds_at_voltage(mv);
    let remaining = (seconds - age.max(0)).max(0);
    result.status = if remaining == 0 {
        "depleted"
    } else {
        "estimated"
    };
    result.remaining_seconds = Some(remaining);
    result.estimated_empty_at = at.checked_add_signed(Duration::seconds(seconds));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-14T17:00:00+09:00")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn timeline_interpolation_uses_physical_full_point_and_absolute_endpoint() {
        assert_eq!(policy().reference_seconds, 51 * 3600 + 3 * 60);
        assert_eq!(seconds_at_voltage(2600), 0);
        assert_eq!(seconds_at_voltage(3655), 91890);
        assert_eq!(seconds_at_voltage(4113), 183780);
        assert_eq!(seconds_at_voltage(4200), 183780);
        assert_eq!(seconds_at_voltage(3600), 86275);
        assert!((2600..=4200)
            .map(seconds_at_voltage)
            .collect::<Vec<_>>()
            .windows(2)
            .all(|p| p[0] <= p[1]));
        let full = estimate(Some(4118), Some(now()), false, now());
        assert_eq!(full.remaining_seconds, Some(183780));
        assert_eq!(
            full.estimated_empty_at,
            Some(now() + Duration::seconds(183780))
        );
        let aged = estimate(
            Some(4118),
            Some(now()),
            false,
            now() + Duration::seconds(30),
        );
        assert_eq!(aged.remaining_seconds, Some(183750));
        assert_eq!(aged.estimated_empty_at, full.estimated_empty_at);
    }

    #[test]
    fn missing_sleeping_charging_and_stale_samples_do_not_predict_depletion() {
        for raw in [None, Some(0), Some(-1), Some(65536)] {
            let r = estimate(raw, Some(now()), false, now());
            assert_eq!(r.status, "unavailable");
            assert!(r.estimated_empty_at.is_none());
        }
        for raw in [4772, 5273, 6000] {
            let r = estimate(Some(raw), Some(now()), false, now());
            assert_eq!(r.status, "external_power_possible");
            assert!(r.remaining_seconds.is_none());
        }
        assert_eq!(
            estimate(Some(3900), Some(now()), true, now()).status,
            "sleeping"
        );
        assert_eq!(
            estimate(
                Some(3900),
                Some(now()),
                false,
                now() + Duration::seconds(301)
            )
            .status,
            "stale"
        );
        assert_eq!(
            estimate(
                Some(3900),
                Some(now() + Duration::seconds(61)),
                false,
                now()
            )
            .status,
            "stale"
        );
        assert_eq!(
            estimate(Some(2500), Some(now()), false, now()).remaining_seconds,
            Some(0)
        );
    }
}
