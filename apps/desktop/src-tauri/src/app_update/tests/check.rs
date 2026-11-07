//! What a check finds, from each state it can start in.

use super::*;

#[test]
fn a_check_offers_what_is_newer_and_takes_back_what_is_gone_from_each_state() {
    let nothing: Arrange = |_| {};
    let offered: Arrange = |f| f.available_after_a_check("0.9.3");
    let failing: Arrange = |f| f.failed_after_a_download("0.9.3");
    let waiting: Arrange = |f| f.ready_after_a_download("0.9.3");
    let cases = [
        ("nothing, and nothing found", nothing, Ok(None), AppUpdateState::None),
        ("offered, then pulled from GitHub", offered, Ok(None), AppUpdateState::None),
        ("failed, then pulled from GitHub", failing, Ok(None), AppUpdateState::None),
        ("failed, and the same version", failing, Ok(Some("0.9.3")), failed("0.9.3", REACH)),
        ("failed, and a newer one", failing, Ok(Some("0.9.4")), available("0.9.4")),
        ("ready, and the same version", waiting, Ok(Some("0.9.3")), ready("0.9.3")),
        ("ready, and pulled: what's on disk is still good", waiting, Ok(None), ready("0.9.3")),
        ("ready, and a newer one", waiting, Ok(Some("0.9.4")), available("0.9.4")),
    ];
    for (label, arrange, answer, state) in cases {
        let f = fixture();
        arrange(&f);
        f.check_finds(answer);

        assert_eq!(f.updates.check(CheckBy::Schedule).as_ref(), Ok(&state), "{label}");
        assert_eq!(lock(&f.events).last().cloned().unwrap_or(AppUpdateState::None), state, "{label}");
    }
}

#[test]
fn a_failed_check_changes_nothing_says_so_only_to_who_asked_and_shows_no_snackbar() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    lock(&f.events).clear();
    f.check_finds(Err(()));
    f.check_finds(Err(()));

    let warnings = warnings_during(|| {
        assert_eq!(f.updates.check(CheckBy::User), Err(REACH.to_owned()));
        assert_eq!(f.updates.check(CheckBy::Schedule), Err(REACH.to_owned()));
    });

    assert_eq!(warnings, 0);
    assert_eq!(f.updates.state(), available("0.9.3"));
    assert!(lock(&f.events).is_empty());
}

#[test]
fn while_an_update_is_on_its_way_a_second_download_or_a_check_asks_for_nothing() {
    let f = fixture();
    f.available_after_a_check("0.9.3");
    f.on("package", |updates| {
        assert!(updates.begin_download().unwrap().is_none());
        assert!(matches!(updates.check(CheckBy::User), Ok(AppUpdateState::Downloading { .. })));
        assert!(matches!(updates.check(CheckBy::Schedule), Ok(AppUpdateState::Downloading { .. })), "nor does the schedule");
    });
    f.download();

    assert_eq!(f.updates.check(CheckBy::User), Ok(ready("0.9.3")));
    assert!(f.updates.begin_restart());
    assert_eq!(f.updates.check(CheckBy::User), Ok(installing("0.9.3")));
    assert_eq!(f.updates.check(CheckBy::Schedule), Ok(installing("0.9.3")));

    assert_eq!(f.outcome(), expect(installing("0.9.3"), WAITING, &["package https://x/0.9.3", "verify"]));
}

#[test]
fn asking_by_hand_is_refused_where_there_is_no_row_for_it() {
    let f = fixture_with(false, false, "0.9.2");

    assert!(f.updates.check(CheckBy::User).is_err());

    assert_eq!(f.outcome(), expect(AppUpdateState::None, &[], &[]));
}
