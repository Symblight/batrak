//! What a launch makes of what the last run left: the spec's table (`docs/specs/app-update.md` §3.3).

use super::*;

fn leave(f: &Fixture, name: &str, bytes: &[u8]) {
    std::fs::create_dir_all(f.root.join("app-update")).unwrap();
    std::fs::write(f.root.join("app-update").join(name), bytes).unwrap();
}

#[test]
fn a_launch_settles_what_the_last_run_left_without_installing_or_asking_github() {
    const NONE: AppUpdateState = AppUpdateState::None;
    // Label, the version running, whether this build updates, what the last run left, then the state and the files after.
    type Case = (&'static str, &'static str, bool, Arrange, AppUpdateState, &'static [&'static str]);
    let cases: [Case; 9] = [
        ("nothing at all, with no folder: no snackbar on every launch", "0.9.2", true, |_| {}, NONE, &[]),
        ("a successful install", "0.9.3", true, |f| f.left_by_a_previous_run(false, true, GOOD), AppUpdateState::Updated { version: "0.9.3".to_owned() }, &[]),
        // A crash between `attempted` and the install, or a Windows installer that failed after the exit.
        ("still on the old version after an attempt: never tried again", "0.9.2", true, |f| f.left_by_a_previous_run(true, true, GOOD), failed("0.9.3", DID_NOT_INSTALL), &[]),
        ("on a version past the update waiting", "0.9.4", true, |f| f.left_by_a_previous_run(false, false, GOOD), NONE, &[]),
        ("a corrupted package", "0.9.2", true, |f| f.left_by_a_previous_run(false, false, BAD), NONE, &[]),
        ("a missing package", "0.9.2", true, |f| f.files.write_pending(&pending("0.9.3", false, false)).unwrap(), NONE, &[]),
        ("a package no pending.json names", "0.9.2", true, |f| {
            leave(f, "package", GOOD);
            leave(f, "package.new.part", b"half");
        }, NONE, &[]),
        ("a download a crash cut short goes, the update waiting stays", "0.9.2", true, |f| {
            f.left_by_a_previous_run(false, false, GOOD);
            leave(f, "package.new", b"newer");
            leave(f, "package.new.part", b"half");
        }, ready("0.9.3"), WAITING),
        // A dev build shares its data folder with an installed app, and isn't what the update replaces.
        ("a build with no updates leaves it alone", "0.1.0", false, |f| f.left_by_a_previous_run(true, false, GOOD), NONE, WAITING),
    ];
    for (label, running, updates_enabled, arrange, state, on_disk) in cases {
        let f = fixture_with(false, updates_enabled, running);
        arrange(&f);

        let warnings = warnings_during(|| {
            f.launch();
        });

        let (state_after, disk_after, logged) = f.outcome();
        assert_eq!((state_after, disk_after), (state, on_disk.iter().map(|name| (*name).to_owned()).collect()), "{label}");
        assert_eq!(warnings, 0, "{label}");
        assert!(logged.iter().all(|call| call == "verify"), "{label}: {logged:?}");
    }
}

#[test]
fn updated_is_told_to_the_page_once() {
    let f = fixture_with(false, true, "0.9.3");
    f.left_by_a_previous_run(false, true, GOOD);
    f.launch();

    assert_eq!(f.updates.page_state(), AppUpdateState::Updated { version: "0.9.3".to_owned() });
    assert_eq!(f.updates.page_state(), AppUpdateState::None);
}

#[test]
fn a_launch_with_an_update_waiting_shows_ready_once_its_package_passes_without_downloading_again() {
    let f = fixture();
    f.left_by_a_previous_run(false, false, GOOD);
    f.on("verify", |updates| assert_eq!(updates.state(), AppUpdateState::None, "None until the hash is done"));

    f.launch();

    assert_eq!(f.outcome(), expect(ready("0.9.3"), WAITING, &["verify"]));
    assert_eq!(lock(&f.events).last(), Some(&ready("0.9.3")));
}

#[test]
fn a_malformed_pending_json_is_cleaned_up_and_never_fails_the_launch() {
    let f = fixture();
    for text in ["", "not json", r#"{"version":"nope","manifest":{},"onNextLaunch":false,"attempted":false}"#, r#"{"version":"0.9.3"}"#] {
        leave(&f, "pending.json", text.as_bytes());
        leave(&f, "package", GOOD);

        let launch = f.launch();

        assert_eq!(launch, Launch::Clean(AppUpdateState::None), "{text}");
        assert_eq!(f.outcome(), expect(AppUpdateState::None, &[], &[]), "{text}");
    }
}
