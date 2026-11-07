use std::ffi::OsString;

use semver::Version;

use super::*;

mod download;
mod http;
mod verify;

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

#[test]
fn compare_says_only_a_strictly_newer_version_is_an_update() {
    let cases = [
        ("0.9.2", "0.9.3", true),
        ("0.9.3", "0.10.0", true),
        ("0.9.3", "1.0.0", true),
        ("0.9.3", "0.9.3", false),
        // A backport published later has the older number.
        ("0.10.0", "0.9.4", false),
        ("1.0.0-rc.1", "1.0.0", true),
        ("1.0.0-rc.1", "1.0.0-rc.2", true),
        ("1.0.0", "1.0.0-rc.2", false),
        ("0.9.3", "1.0.0-rc.1", true),
        // Build metadata has no precedence.
        ("1.0.0+a", "1.0.0+b", false),
        ("1.0.0+b", "1.0.0+a", false),
    ];
    for (current, latest, update) in cases {
        assert_eq!(compare(&v(current), &v(latest)), update, "{current} -> {latest}");
    }
}

#[test]
fn only_a_non_empty_variable_turns_checks_off() {
    assert!(!disabled_by(None));
    assert!(!disabled_by(Some(OsString::new())));
    assert!(disabled_by(Some(OsString::from("1"))));
    assert!(disabled_by(Some(OsString::from("0"))));
}
