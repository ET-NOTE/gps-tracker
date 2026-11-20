use super::*;
use serde_json::json;

#[test]
fn new_workspaces_are_empty_and_do_not_accept_telemetry() {
    let old = crate::routes::cargo::empty_workspace();
    let refs = validate(&old, &old).unwrap();
    assert!(refs.new_devices.is_empty() && refs.images.is_empty());

    let mut changed = old.clone();
    changed["devices"] = json!([]);
    assert!(validate(&old, &changed).is_err());
    let mut changed = old.clone();
    changed["branches"] = json!([{"id":"a", "name":"서울", "lat":37.4}]);
    assert!(validate(&old, &changed).is_err());
}

#[test]
fn branch_ids_outlive_external_staff_links() {
    let mut old = crate::routes::cargo::empty_workspace();
    old["branches"] = json!([{"id":"west","name":"서부","active":true}]);
    let mut changed = old.clone();
    changed["branches"][0]["name"] = json!("서부 영업소");
    assert!(validate(&old, &changed).is_ok());
    changed["branches"] = json!([]);
    assert!(validate(&old, &changed).is_err());
}

#[test]
fn preparation_windows_use_the_same_instant_for_korean_and_utc_inputs() {
    let end = timestamp("2031-05-12T12:00").unwrap();
    assert_eq!(end, timestamp("2031-05-12T03:00:00Z").unwrap());
    assert!(!overlap((end - 3600, end), (end + 600, end + 1800), 600));
    assert!(overlap((end - 3600, end), (end + 599, end + 1800), 600));
}

#[test]
fn partners_with_the_same_name_use_distinct_registration_numbers() {
    let empty = crate::routes::cargo::empty_workspace();
    let mut edited = empty.clone();
    edited["shippers"] = json!([
        {"id":"one","name":"운송상사","active":true,"businessNumber":"111-11-11111"},
        {"id":"two","name":"운송상사","active":true,"businessNumber":"2222222222"}
    ]);
    assert!(validate(&empty, &edited).is_ok());
    edited["shippers"][1]["businessNumber"] = json!("1111111111");
    assert!(validate(&empty, &edited).is_err());
}
