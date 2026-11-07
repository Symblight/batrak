use std::cell::Cell;
use std::path::PathBuf;

use bt_core::release::Manifest;

use super::*;

const NOW: u64 = 2_000_000_000;
const ADVICE: &str = "Run `batrak self update`.";
const NOTICE: &str = "batrak 0.9.3 is available (you have 0.9.2). Run `batrak self update`.";

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

fn terminal() -> Env {
    Env { stdout_tty: true, stderr_tty: true, ci: false, json: false, disabled: false }
}

/// Checked just now, with nothing to say unless a test adds it.
fn checked() -> Cache {
    Cache { checked_at: Some(NOW), latest: None, notified_at: None }
}

fn newer() -> Cache {
    Cache { latest: Some(v("0.9.3")), ..checked() }
}

fn decide_now(cache: &Cache) -> Plan {
    decide(&terminal(), cache, NOW, &v("0.9.2"), ADVICE)
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("batrak-update-notice-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

// ---- the check

#[test]
fn a_check_is_due_once_24_hours_have_passed() {
    let at = |checked_at| Cache { checked_at: Some(checked_at), ..Cache::default() };

    assert!(!decide_now(&at(NOW)).spawn);
    assert!(!decide_now(&at(NOW - DAY + 1)).spawn);
    assert!(decide_now(&at(NOW - DAY)).spawn);
}

#[test]
fn a_check_is_due_with_no_time_or_one_in_the_future() {
    assert!(decide_now(&Cache::default()).spawn);
    assert!(decide_now(&Cache { checked_at: Some(NOW + 1), ..Cache::default() }).spawn);
}

#[test]
fn a_due_check_stamps_its_time_and_keeps_the_rest() {
    let cache = Cache { checked_at: Some(NOW - DAY), latest: Some(v("0.9.2")), notified_at: Some(NOW - 5) };

    let plan = decide_now(&cache);

    assert_eq!(plan.cache, Cache { checked_at: Some(NOW), ..cache });
}

// ---- suppression

#[test]
fn each_suppression_silences_the_notice_and_the_check() {
    let cases = [
        ("stdout piped", Env { stdout_tty: false, ..terminal() }),
        ("stderr piped", Env { stderr_tty: false, ..terminal() }),
        ("CI", Env { ci: true, ..terminal() }),
        ("--json", Env { json: true, ..terminal() }),
        ("opted out", Env { disabled: true, ..terminal() }),
    ];
    let due_with_news = Cache { checked_at: None, ..newer() };

    for (name, env) in cases {
        let plan = decide(&env, &due_with_news, NOW, &v("0.9.2"), ADVICE);

        assert_eq!(plan, Plan { spawn: false, notice: None, cache: due_with_news.clone() }, "{name}");
    }
}

// ---- the notice

#[test]
fn the_notice_names_both_versions_and_the_advice() {
    assert_eq!(decide_now(&newer()).notice.as_deref(), Some(NOTICE));

    let plan = decide(&terminal(), &newer(), NOW, &v("0.9.2"), "batrak was installed by Homebrew; update it with `brew upgrade batrak`");

    assert_eq!(plan.notice.as_deref(), Some("batrak 0.9.3 is available (you have 0.9.2). batrak was installed by Homebrew; update it with `brew upgrade batrak`"));
}

#[test]
fn the_notice_shows_at_most_once_in_24_hours() {
    let first = decide_now(&newer());
    assert!(first.notice.is_some());

    let at = |now| decide(&terminal(), &first.cache, now, &v("0.9.2"), ADVICE).notice;

    assert_eq!(at(NOW), None);
    assert_eq!(at(NOW + DAY - 1), None);
    assert_eq!(at(NOW + DAY).as_deref(), Some(NOTICE));
}

#[test]
fn a_future_notified_time_does_not_silence_the_notice_for_good() {
    let cache = Cache { notified_at: Some(NOW + 1), ..newer() };

    assert_eq!(decide_now(&cache).notice.as_deref(), Some(NOTICE));
}

#[test]
fn an_equal_or_older_latest_gives_no_notice_so_it_clears_after_an_update() {
    for latest in ["0.9.3", "0.9.2", "0.9.3-rc.1"] {
        let cache = Cache { latest: Some(v(latest)), ..checked() };

        let plan = decide(&terminal(), &cache, NOW, &v("0.9.3"), ADVICE);

        assert_eq!(plan, Plan { spawn: false, notice: None, cache }, "{latest}");
    }
}

// ---- the file

#[test]
fn a_missing_or_malformed_cache_means_no_notice_and_a_check_due() {
    let dir = folder("malformed");
    let path = dir.join(CACHE_FILE);
    let missing = read_cache(&path);
    let malformed = [
        "not json",
        "null",
        r#"{"checkedAt":"yesterday","latest":"0.9.3"}"#,
        r#"{"checkedAt":-1,"latest":"0.9.3"}"#,
        r#"{"checkedAt":2000000000,"latest":"newest"}"#,
    ]
    .map(|text| {
        fs::write(&path, text).unwrap();
        read_cache(&path)
    });

    for cache in std::iter::once(missing).chain(malformed) {
        let plan = decide_now(&cache);
        assert!(plan.spawn, "{cache:?}");
        assert_eq!(plan.notice, None, "{cache:?}");
    }
}

#[test]
fn a_notice_and_a_check_are_saved_in_the_file_format_before_the_spawn() {
    let dir = folder("finish");
    let path = dir.join("data").join(CACHE_FILE);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"checkedAt":1,"latest":"0.9.3","notifiedAt":null}"#).unwrap();
    let mut err = Vec::new();
    let saved_at_spawn = Cell::new(None);

    finish(&path, &terminal(), NOW, &v("0.9.2"), ADVICE, &mut err, || saved_at_spawn.set(fs::read_to_string(&path).ok()));

    assert_eq!(String::from_utf8(err).unwrap(), format!("{NOTICE}\n"));
    let saved: serde_json::Value = serde_json::from_str(&saved_at_spawn.take().expect("spawned")).unwrap();
    assert_eq!(saved, serde_json::json!({ "checkedAt": NOW, "latest": "0.9.3", "notifiedAt": NOW }));
}

#[test]
fn nothing_to_do_prints_nothing_spawns_nothing_and_writes_nothing() {
    let dir = folder("nothing");
    let path = dir.join(CACHE_FILE);
    let mut err = Vec::new();

    finish(&path, &Env { stdout_tty: false, ..terminal() }, NOW, &v("0.9.2"), ADVICE, &mut err, || panic!("spawned"));

    assert!(err.is_empty());
    assert!(!path.exists());
}

#[test]
fn a_cache_that_cannot_be_saved_means_no_notice_and_no_spawn_so_neither_repeats() {
    let dir = folder("unwritable");
    fs::write(dir.join("file"), "").unwrap();
    let path = dir.join("file").join(CACHE_FILE);
    let mut err = Vec::new();

    finish(&path, &terminal(), NOW, &v("0.9.2"), ADVICE, &mut err, || panic!("spawned"));

    assert!(err.is_empty());
}

// ---- the child's refresh

struct FakeSource(Result<&'static str, String>);

impl Source for FakeSource {
    fn manifest(&self) -> Result<Manifest, String> {
        self.0.clone().map(|version| Manifest { version: v(version), pub_date: None, platforms: Default::default() })
    }

    fn package(&self, _url: &str, _sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, _total: &mut dyn FnMut(Option<u64>)) -> Result<(), String> {
        Err("no packages here".to_owned())
    }
}

#[test]
fn a_refresh_writes_latest_and_keeps_the_other_fields() {
    let dir = folder("refresh");
    let path = dir.join(CACHE_FILE);
    fs::write(&path, r#"{"checkedAt":7,"latest":"0.9.2","notifiedAt":8}"#).unwrap();

    refresh(&path, &FakeSource(Ok("0.9.3")));

    assert_eq!(read_cache(&path), Cache { checked_at: Some(7), latest: Some(v("0.9.3")), notified_at: Some(8) });
}

#[test]
fn a_failed_refresh_leaves_the_cache_as_it_was() {
    let dir = folder("refresh-failed");
    let path = dir.join(CACHE_FILE);
    let before = r#"{"checkedAt":7,  "latest":"0.9.2"}"#;
    fs::write(&path, before).unwrap();

    refresh(&path, &FakeSource(Err("HTTP 404".to_owned())));

    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}
