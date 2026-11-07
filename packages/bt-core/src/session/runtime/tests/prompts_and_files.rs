use super::turns::idle_sessions;
use super::*;

#[tokio::test]
async fn agent_file_access_is_confined_to_the_project_and_never_rewrites_its_agents_json() {
    let f = fixture("fs", FakeAgentOptions::default());
    let [events] = idle_sessions(&f, ["fs"]).await;
    let agents_json = std::fs::read_to_string(f.project.join(".bt/agents.json")).unwrap();
    let outside = f.dir.join("outside.txt");
    std::fs::write(&outside, "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, f.project.join("link.txt")).unwrap();

    let mut replies = Vec::new();
    for prompt in [
        format!("read {}", f.path("a.txt")),
        format!("write {} new text", f.path("dir/new.txt")),
        format!("read {}", f.path("../outside.txt")),
        format!("read {}", f.path("link.txt")),
        format!("write {} x", f.path(".git/config")),
        format!("write {} x", outside.display()),
        format!("read {}", f.path("missing.txt")),
        format!("write {} x", f.path(".bt/agents.json")),
    ] {
        replies.push(f.ask("fs", &events, &prompt).await);
    }
    assert_eq!(replies[0], "read:one\ntwo\nthree\n");
    assert_eq!(replies[1], "written");
    assert_eq!(std::fs::read_to_string(f.project.join("dir/new.txt")).unwrap(), "new text");
    assert!(replies[2].starts_with("error:") && replies[2].contains(".."), "{}", replies[2]);
    if cfg!(unix) {
        assert!(replies[3].contains("outside the session"), "{}", replies[3]);
    }
    assert!(replies[4].contains(".git"), "{}", replies[4]);
    assert!(replies[5].contains("outside the session"), "{}", replies[5]);
    assert!(replies[6].starts_with("error:"), "{}", replies[6]);
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");
    assert_eq!(std::fs::read_to_string(f.project.join(".git/config")).unwrap(), "[core]\n");
    assert!(replies[7].starts_with("error:") && replies[7].contains("agents.json"), "{}", replies[7]);
    assert_eq!(std::fs::read_to_string(f.project.join(".bt/agents.json")).unwrap(), agents_json);
}

#[tokio::test]
async fn session_ids_are_names_not_paths() {
    let f = fixture("ids", FakeAgentOptions::default());
    for bad in ["../x", "/tmp/x", "", "a/b", "..", "a\\b", &"x".repeat(65)] {
        let err = f.create(bad, "fake").unwrap_err();
        assert!(err.contains("invalid session id"), "{bad:?}: {err}");
    }
    assert!(f.sessions.list().is_empty());
}

#[test]
fn reads_lines_without_loading_more_than_the_limit() {
    let dir = std::env::temp_dir().join(format!("batrak-read-lines-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let small = dir.join("small.txt");
    std::fs::write(&small, "a\nb\nc").unwrap();
    assert_eq!(read_lines(&small, Some(2), Some(1), 100).unwrap(), "b\n");
    assert_eq!(read_lines(&small, Some(2), None, 100).unwrap(), "b\nc");
    assert_eq!(read_lines(&small, None, Some(1), 100).unwrap(), "a\n");
    assert_eq!(read_lines(&small, None, None, 100).unwrap(), "a\nb\nc");
    assert!(read_lines(&small, None, None, 3).unwrap_err().contains("too large"), "a whole file over the limit");
    assert_eq!(read_lines(&small, Some(3), Some(1), 3).unwrap(), "c", "a part of it is fine");

    let long = dir.join("long.txt");
    std::fs::write(&long, format!("{}\nshort\n", "x".repeat(50))).unwrap();
    assert_eq!(read_lines(&long, Some(2), None, 10).unwrap(), "short\n", "a long line skipped is never loaded");
    assert!(read_lines(&long, Some(1), Some(1), 10).unwrap_err().contains("too large"), "nor is a part over the limit");
    std::fs::write(&long, [0xff, 0xfe, b'\n']).unwrap();
    assert!(read_lines(&long, Some(1), Some(1), 10).is_err(), "not UTF-8");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn prompt_blocks_map_mentions_and_selections_and_refuse_escapes() {
    let dir = std::env::temp_dir().join(format!("batrak-blocks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/my file.rs"), "l1\nl2\nl3\nl4\n").unwrap();
    let root = dunce::canonicalize(&dir).unwrap();
    let env = env::LocalEnv::new(root.clone());
    let blocks = prompt_blocks(
        &env,
        vec![
            PromptInput::Text { text: "look".to_owned() },
            PromptInput::Mention { path: "src/my file.rs".to_owned() },
            PromptInput::Selection { path: "src/my file.rs".to_owned(), from_line: 2, to_line: 3 },
        ],
    )
    .unwrap();
    let uri = format!("file://{}/src/my%20file.rs", root.display());
    assert_eq!(
        blocks,
        vec![
            PromptBlock::Text("look".to_owned()),
            PromptBlock::Mention { name: "my file.rs".to_owned(), uri: uri.clone() },
            PromptBlock::Selection { uri: format!("{uri}#L2-3"), text: "l2\nl3\n".to_owned() },
        ]
    );
    for bad in ["../x", "/etc/passwd", ".git/config", "missing.rs"] {
        assert!(prompt_blocks(&env, vec![PromptInput::Mention { path: bad.to_owned() }]).is_err(), "{bad}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn prompt_input_from_the_page() {
    let parsed: Vec<PromptInput> = serde_json::from_str(
        r#"[{"type":"text","text":"hi"},{"type":"mention","path":"a.rs"},{"type":"selection","path":"a.rs","fromLine":1,"toLine":2}]"#,
    )
    .unwrap();
    assert_eq!(parsed[2], PromptInput::Selection { path: "a.rs".to_owned(), from_line: 1, to_line: 2 });
}
