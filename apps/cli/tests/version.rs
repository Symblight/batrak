use std::process::{Command, Output};

fn batrak(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_batrak")).args(args).output().unwrap()
}

#[test]
fn version_prints_the_name_and_the_version() {
    let out = batrak(&["--version"]);
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("batrak {}\n", env!("CARGO_PKG_VERSION")));
}

#[test]
fn anything_else_says_how_to_use_it_and_fails() {
    for args in [&[][..], &["run"][..]] {
        let out = batrak(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(out.stdout.is_empty());
        assert!(String::from_utf8_lossy(&out.stderr).contains("Usage: batrak"));
    }
}

#[test]
fn self_update_refuses_a_binary_with_no_receipt() {
    // The test binary sits in target/, which no install script wrote to, so this asks no network.
    let exe = std::path::Path::new(env!("CARGO_BIN_EXE_batrak"));
    let before = std::fs::read(exe).unwrap();

    let out = batrak(&["self", "update"]);

    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(String::from_utf8_lossy(&out.stderr), "batrak wasn't installed by the install script; update it with the tool that installed it\n");
    assert_eq!(std::fs::read(exe).unwrap(), before);
}

#[test]
fn json_without_check_is_a_usage_error() {
    let out = batrak(&["self", "update", "--json"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
}

#[test]
fn a_piped_version_prints_only_the_version_and_writes_no_cache() {
    let home = std::env::temp_dir().join(format!("batrak-piped-version-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);

    // Its stdout and stderr are pipes, which alone must silence it; CI's variable would hide that.
    let out = Command::new(env!("CARGO_BIN_EXE_batrak")).arg("--version").env("BATRAK_HOME", &home).env_remove("CI").env_remove("BATRAK_NO_UPDATE_CHECK").output().unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("batrak {}\n", env!("CARGO_PKG_VERSION")));
    assert!(out.stderr.is_empty());
    assert!(!home.exists());
}

#[test]
fn the_refresh_command_exists_but_is_hidden_from_help() {
    let help = String::from_utf8(batrak(&["self", "--help"]).stdout).unwrap();
    assert!(help.contains("update"));
    assert!(!help.contains("refresh-check"));

    // A flag it doesn't take, so this asks no network; clap's usage names the command when it exists.
    let out = batrak(&["self", "refresh-check", "--no-such-flag"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Usage: batrak self refresh-check"));
}
