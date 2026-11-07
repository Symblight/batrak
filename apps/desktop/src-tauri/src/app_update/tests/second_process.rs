//! Two processes over one data folder (`docs/specs/app-update.md` §3.3): the one without the lock leaves
//! updates alone.

use super::launch::leave;
use super::process_lock::{standing_after, Standing};
use super::*;

const UPDATER: Process = Process { manual: false, updates_enabled: true, running: "0.9.2", lock_wait: Duration::ZERO };

#[test]
fn a_process_without_the_lock_leaves_what_it_finds_alone() {
    const LEFT: &[&str] = &["package", "package.new.part", "pending.json"];
    // Label, the version running, what is on disk: what a launch with the lock would delete or install.
    type Case = (&'static str, &'static str, Arrange, &'static [&'static str]);
    let cases: [Case; 5] = [
        ("a running download's part file", "0.9.2", |f| {
            f.left_by_a_previous_run(false, false, GOOD);
            leave(f, "package.new.part", b"half");
        }, LEFT),
        ("nothing pending.json names", "0.9.2", |f| leave(f, "package.new.part", b"half"), &["package.new.part"]),
        ("an update on next launch", "0.9.2", |f| f.left_by_a_previous_run(true, false, GOOD), WAITING),
        ("a finished install", "0.9.3", |f| f.left_by_a_previous_run(false, true, GOOD), WAITING),
        ("a failed install", "0.9.2", |f| f.left_by_a_previous_run(true, true, GOOD), WAITING),
    ];
    for (label, running, arrange, on_disk) in cases {
        let first = fixture();
        arrange(&first);
        let second = first.another_process(Process { running, ..UPDATER });

        let warnings = warnings_during(|| {
            second.launch();
        });

        assert_eq!(second.outcome(), expect(AppUpdateState::None, on_disk, &[]), "{label}");
        assert!(lock(&second.events).is_empty(), "{label}");
        assert_eq!(warnings, 0, "{label}: a warning is a snackbar");
    }
}

#[test]
fn a_process_without_the_lock_has_no_updates_while_it_waits_for_it_or_after() {
    let first = fixture();
    first.left_by_a_previous_run(false, false, GOOD);
    // `manual` would refuse a download out loud.
    let second = first.another_process(Process { manual: true, ..UPDATER });
    second.check_finds(Ok(Some("0.9.3")));

    for moment in ["waiting", "settled"] {
        assert!(!second.updates.updates_enabled(), "{moment}");
        assert_eq!(second.updates.check(CheckBy::User), Ok(AppUpdateState::None), "{moment}");
        assert_eq!(second.updates.check(CheckBy::Schedule), Ok(AppUpdateState::None), "{moment}");
        assert!(second.updates.begin_download().unwrap().is_none(), "{moment}");
        assert_eq!(second.updates.cancel(), AppUpdateState::None, "{moment}");
        assert_eq!(second.updates.set_on_next_launch(true), Ok(AppUpdateState::None), "{moment}");
        assert!(!second.updates.begin_restart(), "{moment}");
        assert_eq!(second.updates.release_version(), None, "{moment}");
        assert_eq!(second.updates.page_state(), AppUpdateState::None, "{moment}");
        second.launch();
    }

    assert_eq!(second.outcome(), expect(AppUpdateState::None, WAITING, &[]));
    assert_eq!(first.files.read_pending(), Some(pending("0.9.3", false, false)));
}

#[test]
fn the_first_process_finishes_its_download_and_its_restart_past_a_second_one() {
    let first = fixture();
    first.available_after_a_check("0.9.3");
    let root = first.root.clone();
    first.on("package", move |_| {
        let second = process(root.clone(), root.0.clone(), UPDATER);
        second.launch();
    });

    first.download();

    assert_eq!(first.updates.state(), ready("0.9.3"));
    first.assert_waits("0.9.3", GOOD);
    assert!(first.updates.updates_enabled());
    assert!(first.updates.begin_restart());
    first.updates.run_restart();
    assert!(lock(&first.fake.log).contains(&"restart".to_owned()));
}

#[test]
fn the_folder_changes_hands_only_with_a_new_process_and_the_lock_file_outlives_the_cleanup() {
    let first = fixture();
    first.launch();
    assert!(first.lock_path().is_file(), "beside the folder a cleanup deletes");
    first.left_by_a_previous_run(false, false, GOOD);
    let second = first.another_process(UPDATER);
    second.launch();
    let third = first.another_process(Process { running: "0.9.3", ..UPDATER });
    assert!(!third.updates.updates_enabled());

    drop(first);
    let fourth = second.another_process(Process { running: "0.9.3", ..UPDATER });
    fourth.launch();

    assert_eq!(fourth.outcome(), expect(AppUpdateState::None, &[], &[]), "not attempted, and past it: cleaned up");
    assert!(fourth.updates.updates_enabled());
    assert!(!second.updates.updates_enabled(), "stays aside for its life");
}

#[test]
fn a_launch_that_gets_the_lock_within_its_wait_is_the_one_a_restart_meant() {
    const STOPPED_AND_RESTARTED: &[&str] = &["hide", "install attempted=true", "stop", "restart"];
    // Label, the version running, what the old process left, then the state told, the files and the calls.
    type Case = (&'static str, &'static str, Arrange, AppUpdateState, &'static [&'static str], &'static [&'static str]);
    let cases: [Case; 3] = [
        ("Updated still reaches the page, which may have asked already", "0.9.3", |f| f.left_by_a_previous_run(false, true, GOOD), AppUpdateState::Updated { version: "0.9.3".to_owned() }, &[], &[]),
        ("so does Failed", "0.9.2", |f| f.left_by_a_previous_run(true, true, GOOD), failed("0.9.3", DID_NOT_INSTALL), &[], &[]),
        ("an install on next launch hides the window it couldn't before", "0.9.2", |f| f.left_by_a_previous_run(true, false, GOOD), installing("0.9.3"), WAITING, STOPPED_AND_RESTARTED),
    ];
    for (label, running, arrange, state, on_disk, logged) in cases {
        let first = fixture();
        arrange(&first);
        let relaunched = first.another_process(Process { running, lock_wait: Duration::from_secs(30), ..UPDATER });
        let launching = relaunched.updates.clone();
        let launch = std::thread::spawn(move || {
            let launch = launching.plan_launch();
            launching.run_launch(launch);
        });
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(relaunched.updates.state(), AppUpdateState::None, "{label}: nothing yet");

        drop(first);
        launch.join().unwrap();

        assert_eq!(relaunched.outcome(), expect(state.clone(), on_disk, logged), "{label}");
        assert_eq!(lock(&relaunched.events).first(), Some(&state), "{label}");
        assert!(relaunched.updates.updates_enabled(), "{label}");
    }
}

#[test]
fn another_data_folder_and_a_build_that_doesnt_update_stand_in_nobodys_way() {
    let first = fixture();
    let elsewhere = fixture();
    elsewhere.left_by_a_previous_run(false, true, GOOD);
    elsewhere.launch();
    assert_eq!(elsewhere.on_disk(), Vec::<String>::new());
    assert!(elsewhere.updates.updates_enabled() && first.updates.updates_enabled());

    let dev = fixture_with(false, false, "0.1.0");
    assert!(!dev.lock_path().exists(), "a dev run sharing the folder takes no lock");
    assert!(dev.another_process(UPDATER).updates.updates_enabled());
}

#[test]
fn a_first_launch_makes_the_folder_for_its_lock() {
    let f = fixture();
    let home = f.root.0.join("no folder yet");

    let first = process(f.root.clone(), home.clone(), UPDATER);
    let second = process(f.root.clone(), home, UPDATER);

    assert!(first.updates.updates_enabled());
    assert!(!{ second.launch(); second.updates.updates_enabled() });
}

#[test]
fn only_another_process_holding_the_lock_disables_updates() {
    let f = fixture();
    let file = || std::fs::File::create(f.root.0.join("any file")).unwrap();

    assert!(matches!(standing_after(file(), Ok(())), Standing::Handling(Some(_))));
    assert!(matches!(standing_after(file(), Err(std::fs::TryLockError::WouldBlock)), Standing::Contended));
    let no_locks = std::fs::TryLockError::Error(std::io::Error::other("no locks on this filesystem"));
    assert!(matches!(standing_after(file(), Err(no_locks)), Standing::Handling(None)));

    let home = f.root.0.join("lockless");
    std::fs::create_dir_all(home.join("app-update.lock")).unwrap();
    let unopenable = process(f.root.clone(), home, UPDATER);
    let warnings = warnings_during(|| {
        unopenable.left_by_a_previous_run(false, false, GOOD);
        unopenable.launch();
    });
    assert!(unopenable.updates.updates_enabled());
    assert_eq!(unopenable.updates.state(), ready("0.9.3"));
    assert_eq!(warnings, 0, "a warning is a snackbar");
}
