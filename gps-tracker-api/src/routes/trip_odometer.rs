//! Explicitly entered dashboard readings. These never replace received GPS points.
use serde::{Deserialize, Deserializer};
use serde_json::Value;

pub(crate) const MAX_ODOMETER_KM: f64 = 9_999_999.99;

// `Option<f64>` alone cannot distinguish an old client omitting a field from
// a user clearing a saved reading. Preserve that distinction before validation.
fn present_nullable<'de, D>(deserializer: D) -> Result<Option<Option<f64>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct OdometerPatch {
    #[serde(default, deserialize_with = "present_nullable")]
    odometer_before_km: Option<Option<f64>>,
    #[serde(default, deserialize_with = "present_nullable")]
    odometer_after_km: Option<Option<f64>>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum OdometerUpdate {
    Preserve,
    Replace(Option<(f64, f64)>),
}

impl OdometerPatch {
    pub(crate) fn validate(&self) -> Result<OdometerUpdate, &'static str> {
        match (self.odometer_before_km, self.odometer_after_km) {
            (None, None) => Ok(OdometerUpdate::Preserve),
            (Some(None), Some(None)) => Ok(OdometerUpdate::Replace(None)),
            (Some(Some(before)), Some(Some(after))) => {
                let valid = |v: f64| {
                    v.is_finite()
                        && (0.0..=MAX_ODOMETER_KM).contains(&v)
                        // At this range binary floating point can differ from
                        // integer hundredths slightly; never accept a third decimal.
                        && ((v * 100.0).round() - v * 100.0).abs() <= 0.000_001
                };
                if !valid(before) || !valid(after) {
                    return Err(
                        "계기판 값은 0~9,999,999.99km 범위에서 소수 둘째 자리까지 입력해 주세요.",
                    );
                }
                if after < before {
                    return Err("운행 후 계기판 값은 운행 전 값보다 작을 수 없습니다.");
                }
                Ok(OdometerUpdate::Replace(Some((before, after))))
            }
            _ => Err("운행 전·후 계기판 값을 모두 입력하거나 모두 비워 주세요."),
        }
    }
}

/// A split/adjustment/merge creates a different reporting interval. Its original
/// trip readings remain in storage and correction history, never redistributed.
pub(crate) fn clear_derived_readings(row: &mut Value, action: &str) {
    if action == "confirm" {
        return;
    }
    if let Some(annotation) = row["annotation"].as_object_mut() {
        annotation.insert("odometer_before_km".into(), Value::Null);
        annotation.insert("odometer_after_km".into(), Value::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(v: Value) -> Result<OdometerUpdate, &'static str> {
        serde_json::from_value::<OdometerPatch>(v)
            .unwrap()
            .validate()
    }

    #[test]
    fn omission_preserves_and_explicit_null_pair_clears() {
        assert_eq!(read(json!({})), Ok(OdometerUpdate::Preserve));
        assert_eq!(
            read(json!({"purpose":"business"})),
            Ok(OdometerUpdate::Preserve)
        );
        assert_eq!(
            read(json!({"odometer_before_km":null,"odometer_after_km":null})),
            Ok(OdometerUpdate::Replace(None))
        );
    }

    #[test]
    fn accepts_zero_stationary_and_two_decimal_readings() {
        for (before, after) in [
            (0., 0.),
            (0., 1.25),
            (12345.67, 12346.89),
            (MAX_ODOMETER_KM, MAX_ODOMETER_KM),
        ] {
            assert_eq!(
                read(json!({"odometer_before_km":before,"odometer_after_km":after})),
                Ok(OdometerUpdate::Replace(Some((before, after))))
            );
        }
    }

    #[test]
    fn rejects_partial_clears_partial_values_and_decreasing_values() {
        for value in [
            json!({"odometer_before_km":0}),
            json!({"odometer_after_km":1}),
            json!({"odometer_before_km":null}),
            json!({"odometer_after_km":null}),
            json!({"odometer_before_km":0,"odometer_after_km":null}),
            json!({"odometer_before_km":null,"odometer_after_km":1}),
            json!({"odometer_before_km":2,"odometer_after_km":1}),
        ] {
            assert!(read(value).is_err());
        }
    }

    #[test]
    fn rejects_negative_overflow_precision_and_non_finite() {
        for value in [
            -0.01,
            10_000_000.,
            1.001,
            9999999.991,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert!(OdometerPatch {
                odometer_before_km: Some(Some(value)),
                odometer_after_km: Some(Some(value))
            }
            .validate()
            .is_err());
        }
        assert!(serde_json::from_value::<OdometerPatch>(
            json!({"odometer_before_km":"1","odometer_after_km":2})
        )
        .is_err());
    }

    #[test]
    fn nested_flatten_keeps_missing_and_null_distinct() {
        #[derive(Deserialize)]
        struct Annotation {
            #[serde(flatten)]
            odometer: OdometerPatch,
        }
        #[derive(Deserialize)]
        struct VehicleAnnotation {
            #[serde(flatten)]
            annotation: Annotation,
        }
        let omitted: VehicleAnnotation =
            serde_json::from_value(json!({"binding_id":3,"purpose":"business"})).unwrap();
        assert_eq!(
            omitted.annotation.odometer.validate(),
            Ok(OdometerUpdate::Preserve)
        );
        let cleared: VehicleAnnotation = serde_json::from_value(
            json!({"binding_id":3,"odometer_before_km":null,"odometer_after_km":null}),
        )
        .unwrap();
        assert_eq!(
            cleared.annotation.odometer.validate(),
            Ok(OdometerUpdate::Replace(None))
        );
    }

    #[test]
    fn derived_intervals_clear_readings_without_changing_the_original() {
        let original = json!({"annotation":{"odometer_before_km":100.,"odometer_after_km":110.,"purpose":"business"},"distance_m":8000.});
        for action in ["split", "adjust", "merge"] {
            let mut derived = original.clone();
            clear_derived_readings(&mut derived, action);
            assert!(derived["annotation"]["odometer_before_km"].is_null());
            assert!(derived["annotation"]["odometer_after_km"].is_null());
            assert_eq!(derived["annotation"]["purpose"], "business");
            assert_eq!(derived["distance_m"], 8000.);
        }
        assert_eq!(original["annotation"]["odometer_before_km"], 100.);
        let mut confirmed = original.clone();
        clear_derived_readings(&mut confirmed, "confirm");
        assert_eq!(confirmed, original);
        let mut no_annotation = json!({"annotation":null});
        clear_derived_readings(&mut no_annotation, "split");
        assert!(no_annotation["annotation"].is_null());
    }
}
