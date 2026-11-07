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
