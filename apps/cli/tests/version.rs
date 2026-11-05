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
        assert!(String::from_utf8_lossy(&out.stderr).contains("usage: batrak --version"));
    }
}
