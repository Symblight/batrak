//! Downloading, cancelling and retrying.

use std::sync::mpsc::channel;

use super::*;

const DISK: &str = "couldn't save the update";
const URL: &str = "package https://x/0.9.3";

#[test]
fn a_download_shows_at_once_reaches_ready_and_leaves_a_verified_package_named_by_pending_json() {
    let f = fixture();
    f.available_after_a_check("0.9.3");

    f.download();

    assert_eq!(f.outcome(), expect(ready("0.9.3"), WAITING, &[URL, "verify"]));
    f.assert_waits("0.9.3", GOOD);
    let events = lock(&f.events);
    let size = GOOD.len() as u64;
    assert!(events.contains(&AppUpdateState::Downloading { version: "0.9.3".to_owned(), received: 0, total: None }), "{events:?}");
    assert!(events.contains(&AppUpdateState::Downloading { version: "0.9.3".to_owned(), received: size, total: Some(size) }), "{events:?}");
    assert_eq!(events.last(), Some(&ready("0.9.3")));
    drop(events);

    assert_eq!(f.updates.cancel(), ready("0.9.3"), "a cancel after it finished changes nothing");
    f.assert_waits("0.9.3", GOOD);
}

#[test]
fn a_failed_download_says_what_the_user_can_do_leaves_no_package_and_shows_no_snackbar() {
    let cases: [(&str, Arrange, &str, &[&str]); 3] = [
        ("a bad signature", |f| f.serves(Some(BAD)), SIGNATURE, &[URL, "verify"]),
        ("the network", |f| f.serves(None), REACH, &[URL]),
        ("a file where the folder should be", |f| std::fs::write(f.root.join("app-update"), b"").unwrap(), DISK, &[]),
    ];
    for (label, arrange, reason, logged) in cases {
        let f = fixture();
        f.available_after_a_check("0.9.3");
        arrange(&f);

        let warnings = warnings_during(|| f.download());

        assert_eq!(f.outcome(), expect(failed("0.9.3", reason), &[], logged), "{label}");
        assert_eq!(warnings, 0, "{label}");
    }
}

#[test]
fn a_manual_install_refuses_to_download() {
    let f = fixture_with(true, true, "0.9.2");
    f.check_finds(Ok(Some("0.9.3")));
    let state = f.updates.check(CheckBy::User).unwrap();
    assert_eq!(state, AppUpdateState::Available { version: "0.9.3".to_owned(), current: "0.9.2".to_owned(), manual: true });

    let refused = f.updates.begin_download();

    assert!(refused.is_err());
    assert_eq!(f.outcome(), expect(state, &[], &["check"]));
}

#[test]
fn a_cancel_returns_to_available_at_once_and_leaves_no_files_wherever_the_download_is() {
    let cases: [(&'static str, &[&str]); 2] = [("package", &[URL]), ("verify", &[URL, "verify"])];
    for (during, logged) in cases {
        let f = fixture();
        f.available_after_a_check("0.9.3");
        f.on(during, |updates| assert_eq!(updates.cancel(), available("0.9.3")));

        f.download();

        assert_eq!(f.outcome(), expect(available("0.9.3"), &[], logged), "{during}");
    }
}

#[test]
fn a_download_started_right_after_a_cancel_waits_for_the_old_one_to_be_gone() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.serves(Some(GOOD));
    f.serves(Some(OTHER_GOOD));
    let (second, joins) = channel();
    f.on("package", move |updates| {
        updates.cancel();
        let job = updates.begin_download().unwrap().expect("a new download");
        let updates = updates.clone();
        second.send(std::thread::spawn(move || updates.run_download(job))).unwrap();
    });

    f.download();
    joins.recv().unwrap().join().unwrap();

    assert_eq!(f.updates.state(), ready("0.9.3"));
    f.assert_waits("0.9.3", OTHER_GOOD);
}

#[test]
fn the_update_waiting_stays_until_a_newer_one_is_in() {
    let f = fixture();
    f.ready_after_a_download("0.9.3");
    f.available_after_a_check("0.9.4");
    f.assert_waits("0.9.3", GOOD);

    f.serves(Some(BAD));
    f.download();
    assert_eq!(f.updates.state(), failed("0.9.4", SIGNATURE));
    f.assert_waits("0.9.3", GOOD);

    f.serves(Some(OTHER_GOOD));
    let incoming = f.files.incoming();
    // Nothing left to rename: fails like a share violation, on every platform.
    f.on("verify", move |_| std::fs::remove_file(incoming).unwrap());
    f.download();
    assert_eq!(f.updates.state(), failed("0.9.4", DISK));
    f.assert_waits("0.9.3", GOOD);

    f.serves(Some(OTHER_GOOD));
    f.download();
    assert_eq!(f.updates.state(), ready("0.9.4"));
    f.assert_waits("0.9.4", OTHER_GOOD);
}

/// A relaunch knows no `Found`, so its retry asks first; a failure in this run still knows what it failed with.
#[test]
fn a_retry_asks_only_after_a_relaunch_and_ends_where_the_user_can_see() {
    let relaunched: Arrange = |f| {
        f.left_by_a_previous_run(false, true, GOOD);
        f.launch();
    };
    type Case = (&'static str, Arrange, Result<Option<&'static str>, ()>, AppUpdateState, &'static [&'static str], &'static [&'static str]);
    let cases: [Case; 4] = [
        ("failed in this run", |f| f.failed_after_a_download("0.9.3"), Ok(None), ready("0.9.3"), WAITING, &[URL, "verify"]),
        ("relaunched, finds a release", relaunched, Ok(Some("0.9.4")), ready("0.9.4"), WAITING, &["check", "package https://x/0.9.4", "verify"]),
        ("relaunched, can't ask", relaunched, Err(()), failed("0.9.3", REACH), &[], &["check"]),
        ("relaunched, finds nothing", relaunched, Ok(None), AppUpdateState::None, &[], &["check"]),
    ];
    for (label, arrange, answer, state, on_disk, logged) in cases {
        let f = fixture();
        arrange(&f);
        f.check_finds(answer);

        f.download();

        assert_eq!(f.outcome(), expect(state, on_disk, logged), "{label}");
    }
}
