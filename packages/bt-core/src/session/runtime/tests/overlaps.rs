use super::turns::idle_sessions;
use super::*;

/// Lets the project's local turns run at once, the only way two touch one file.
fn allow_parallel_turns(f: &Fixture) {
    std::fs::write(f.project.join(".bt/workspace.json"), r#"{"version":1,"localTurns":"parallel"}"#).unwrap();
}

fn edit(f: &Fixture, id: &str, rel: &str, ms: u32) {
    f.sessions.send_prompt(id, text(&format!("edit {} {ms}", f.path(rel)))).unwrap();
}

async fn tool_calls_seen(events: &[&Recorder]) {
    for e in events {
        e.kind_seen("tool_call_update").await;
    }
}

fn overlaps(events: &Recorder) -> Vec<Value> {
    lock(&events.events).iter().filter(|e| e.kind == "overlap").map(|e| e.payload.clone()).collect()
}

/// `a`'s quick edit of a.txt has ended while `b`'s goes on.
async fn a_ended_during_bs_edit(f: &Fixture, a: &Recorder, b: &Recorder) {
    a.clear();
    b.clear();
    edit(f, "a", "a.txt", 0);
    edit(f, "b", "a.txt", 800);
    a.wait_turn_end().await;
    b.kind_seen("tool_call_update").await;
}

#[tokio::test]
async fn parallel_turns_that_change_the_same_file_each_hear_of_the_other_once() {
    let f = fixture("overlap", FakeAgentOptions::default());
    allow_parallel_turns(&f);
    std::fs::write(f.project.join("b.txt"), "b\n").unwrap();
    let [a, b, c] = idle_sessions(&f, ["a", "b", "c"]).await;
    edit(&f, "a", "a.txt", 400);
    edit(&f, "b", "a.txt", 400);
    edit(&f, "c", "b.txt", 400);
    tool_calls_seen(&[&a, &b, &c]).await;

    // As the project's watcher reports them, twice.
    for _ in 0..2 {
        f.sessions.note_changes(&f.project, &["a.txt".to_owned(), "b.txt".to_owned()]);
    }
    assert_eq!(overlaps(&a), [json!({ "path": "a.txt", "other": { "id": "b", "title": "Session b" } })]);
    assert_eq!(overlaps(&b), [json!({ "path": "a.txt", "other": { "id": "a", "title": "Session a" } })]);
    assert!(overlaps(&c).is_empty(), "only c changed b.txt");
    for e in [&a, &b, &c] {
        assert_eq!(e.wait_turn_end().await, "end_turn");
    }

    // A new turn hears of it again.
    a.clear();
    b.clear();
    edit(&f, "a", "a.txt", 300);
    edit(&f, "b", "a.txt", 300);
    tool_calls_seen(&[&a, &b]).await;
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    assert_eq!((overlaps(&a).len(), overlaps(&b).len()), (1, 1));
    for e in [&a, &b] {
        e.wait_turn_end().await;
    }

    // A batch that comes just after a's turn ended still has a's change in it.
    a_ended_during_bs_edit(&f, &a, &b).await;
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    assert_eq!(overlaps(&b), [json!({ "path": "a.txt", "other": { "id": "a", "title": "Session a" } })], "late batch");
    assert!(overlaps(&a).is_empty(), "a's turn is over");
    b.wait_turn_end().await;

    // Once a's turn is well over, b's change is its own.
    a_ended_during_bs_edit(&f, &a, &b).await;
    tokio::time::sleep(OVERLAP_GRACE * 2).await;
    f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
    assert!(overlaps(&b).is_empty(), "not after a's turn");
}

#[tokio::test]
async fn only_turns_that_changed_a_file_overlap_by_whatever_name_they_gave_it() {
    let f = fixture("overlap-paths", FakeAgentOptions::default());
    allow_parallel_turns(&f);
    std::fs::create_dir_all(f.project.join("sub")).unwrap();
    let [a, b] = idle_sessions(&f, ["a", "b"]).await;
    for (a_prompt, expected) in [
        (format!("edit {} 400", f.path("sub/../a.txt")), 1),
        (format!("look {} 400", f.path("a.txt")), 0),
    ] {
        a.clear();
        b.clear();
        f.sessions.send_prompt("a", text(&a_prompt)).unwrap();
        edit(&f, "b", "a.txt", 400);
        tool_calls_seen(&[&a, &b]).await;
        f.sessions.note_changes(&f.project, &["a.txt".to_owned()]);
        for e in [&a, &b] {
            assert_eq!(overlaps(e).len(), expected, "{a_prompt}");
            e.wait_turn_end().await;
        }
    }
}
