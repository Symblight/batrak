//! The small decisions, and the shapes and config other sides rely on.

use super::*;

#[test]
fn checks_are_on_by_default_in_a_release_build() {
    // Zed's post-mortem: a settings refactor turned auto-update off for several releases.
    assert!(checks_on(false, false), "a release build, nothing set");
    assert!(!checks_on(false, true), "BATRAK_NO_UPDATE_CHECK");
    assert!(!checks_on(true, false), "a debug build");
}

#[test]
fn manual_installs_are_the_packages_and_a_mac_app_that_never_got_installed() {
    use tauri::utils::config::BundleType::{App, AppImage, Deb, Msi, Nsis, Rpm};
    let cases = [
        (Deb, "/usr/bin/batrak", false, true),
        (Rpm, "/usr/bin/batrak", false, true),
        (AppImage, "/home/me/Batrak.AppImage", false, false),
        (Nsis, r"C:\Program Files\Batrak\batrak.exe", false, false),
        (Msi, r"C:\Program Files\Batrak\batrak.exe", false, false),
        (App, "/Applications/Batrak.app/Contents/MacOS/batrak", true, false),
        (App, "/Volumes/Batrak 0.9.2/Batrak.app/Contents/MacOS/batrak", true, true),
        (App, "/private/var/folders/x/T/AppTranslocation/ABC/d/Batrak.app/Contents/MacOS/batrak", true, true),
        (Nsis, "/Volumes/on-a-mac-only", false, false),
    ];
    for (bundle, exe, macos, manual) in cases {
        assert_eq!(is_manual(Some(bundle), exe, macos), manual, "{exe}");
    }
}

#[test]
fn the_version_a_state_is_about_opens_its_release_page() {
    let f = fixture();
    assert_eq!(f.updates.release_version(), None);

    f.available_after_a_check("0.9.3");

    assert_eq!(f.updates.release_version().as_deref(), Some("0.9.3"));
    assert_eq!(release_page("0.9.3"), "https://github.com/Symblight/batrak/releases/tag/v0.9.3");
}

#[test]
fn progress_reaches_the_page_only_when_the_whole_percent_or_with_no_total_the_whole_megabyte_changes() {
    let moves = |step: u64, total: Option<u64>, steps: u64| {
        let mut throttle = Throttle::default();
        (1..=steps).filter(|i| throttle.moved(i * step, total)).count()
    };

    assert_eq!(moves(1, Some(1000), 1000), 101, "0% to 100%");
    assert_eq!(moves(64 * 1024, None, 16 * 3), 4, "megabytes 0 to 3");
}

#[test]
fn the_page_reads_each_state_as_the_spec_writes_it() {
    use AppUpdateState as S;
    let (version, current) = ("1".to_owned(), "0".to_owned());
    let cases = [
        (S::None, json!({ "state": "none" })),
        (S::Available { version: version.clone(), current, manual: true }, json!({ "state": "available", "version": "1", "current": "0", "manual": true })),
        (S::Downloading { version: version.clone(), received: 2, total: None }, json!({ "state": "downloading", "version": "1", "received": 2, "total": null })),
        (S::Ready { version: version.clone(), on_next_launch: true }, json!({ "state": "ready", "version": "1", "onNextLaunch": true })),
        (installing("1"), json!({ "state": "installing", "version": "1" })),
        (failed("1", "why"), json!({ "state": "failed", "version": "1", "reason": "why" })),
        (S::Updated { version }, json!({ "state": "updated", "version": "1" })),
    ];
    for (state, page) in cases {
        assert_eq!(serde_json::to_value(state).unwrap(), page);
    }
}

#[test]
fn a_chat_in_a_terminal_counts_as_an_agent_and_not_again_as_a_terminal() {
    let busy = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<String>>();

    let blockers = restart_blockers(2, &busy(&["cli-1", "shell-1", "shell-2"]), &busy(&["cli-1", "cli-2"]));

    assert_eq!(blockers, RestartBlockers { agents: 2, terminals: 2 });
}

#[test]
fn the_updater_config_is_what_the_release_is_signed_for_and_the_plugin_parses_it() {
    let conf: Value = serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();

    let config: tauri_plugin_updater::Config = serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();

    assert_eq!(config.pubkey, bt_core::release::PUBKEY);
    assert!(config.require_signed_version);
    let endpoint = config.endpoints.first().unwrap().as_str().to_owned();
    assert_eq!(endpoint, format!("{}/releases/latest/download/latest.json", bt_core::release::REPO_URL));
    assert_eq!(conf["plugins"]["updater"]["windows"]["installMode"], "passive");
    assert!(config.windows.is_some());
}
