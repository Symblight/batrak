//! Installing, by a restart or on the next launch.

use super::*;

const TRIED: &str = "install attempted=true";
/// On Windows the plugin's hook has by then stopped everything and hidden the windows: the page hears
/// what stopped before the window comes back.
const WINDOW_BACK: &[&str] = &[TRIED, "report stopped", "show"];

#[test]
fn on_next_launch_is_saved_at_once_and_only_while_ready() {
    let f = fixture();
    assert_eq!(f.updates.set_on_next_launch(true), Ok(AppUpdateState::None), "nothing to apply it to");
    f.ready_after_a_download("0.9.3");

    let state = f.updates.set_on_next_launch(true).unwrap();

    assert_eq!(state, AppUpdateState::Ready { version: "0.9.3".to_owned(), on_next_launch: true });
    assert_eq!(f.files.read_pending(), Some(pending("0.9.3", true, false)));

    assert_eq!(f.updates.set_on_next_launch(false), Ok(ready("0.9.3")));
    f.assert_waits("0.9.3", GOOD);
}

#[test]
fn a_restart_outside_ready_does_nothing() {
    let f = fixture();
    assert!(!f.updates.begin_restart());

    f.available_after_a_check("0.9.3");
    assert!(!f.updates.begin_restart());
    assert_eq!(f.updates.state(), available("0.9.3"));
}

fn by_restart(f: &Fixture) {
    assert!(f.updates.begin_restart());
    assert!(!f.updates.begin_restart(), "one install");
    assert_eq!(lock(&f.events).last(), Some(&installing("0.9.3")), "before any work");
    f.updates.run_restart();
}

fn by_launch(f: &Fixture) {
    let launch = f.updates.plan_launch();
    assert!(matches!(launch, Launch::Install(_)));
    assert_eq!(f.updates.state(), installing("0.9.3"), "before the page can ask");
    f.updates.run_launch(launch);
}

#[test]
fn an_install_marks_the_attempt_first_and_only_after_it_worked_stops_everything_and_restarts() {
    // Label, what breaks it, then the state, the files and the calls after. `tried` is what `onNextLaunch`
    // and `attempted` still say: a failure clears both, so it's tried once and no crash is reported.
    type Case = (&'static str, Arrange, AppUpdateState, &'static [&'static str], &'static [&'static str], Option<bool>);
    let cases: [Case; 5] = [
        ("it works", |_| {}, installing("0.9.3"), WAITING, &[TRIED, "stop", "restart"], Some(true)),
        ("the installer refuses it", |f| std::fs::write(f.files.package(), REFUSED).unwrap(), failed("0.9.3", REPLACE), WAITING, WINDOW_BACK, Some(false)),
        ("the installer panics: no button stuck on Installing", |f| f.on("install", |_| panic!("the plugin panicked")), failed("0.9.3", REPLACE), WAITING, WINDOW_BACK, Some(false)),
        ("a package corrupted since it was verified is deleted", |f| std::fs::write(f.files.package(), BAD).unwrap(), failed("0.9.3", SIGNATURE), &[], WINDOW_BACK, None),
        ("a package gone", |f| std::fs::remove_file(f.files.package()).unwrap(), failed("0.9.3", REPLACE), &["pending.json"], &["report stopped", "show"], Some(false)),
    ];
    for (label, breaks, state, on_disk, logged, tried) in cases {
        for (route, install) in [("restart", by_restart as Arrange), ("launch", by_launch)] {
            let f = fixture();
            if route == "restart" {
                f.ready_after_a_download("0.9.3");
                f.updates.set_on_next_launch(true).unwrap();
            } else {
                f.left_by_a_previous_run(true, false, GOOD);
            }
            breaks(&f);

            let warnings = warnings_during(|| install(&f));

            assert_eq!(f.outcome(), expect(state.clone(), on_disk, logged), "{route}: {label}");
            assert_eq!(warnings, 0, "{route}: {label}");
            assert_eq!(f.files.read_pending(), tried.map(|tried| pending("0.9.3", tried, tried)), "{route}: {label}");
        }
    }
}
