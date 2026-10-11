//! Manual timing on a real repository:
//! `BRAMA_BENCH_ROOT=/path/to/repo cargo test --release bench -- --ignored --nocapture`

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use super::search::{self, SearchEvent, SearchOptions};
use super::snapshot::Snapshot;
use super::quick_open;

#[test]
#[ignore]
fn bench() {
    let Ok(root) = std::env::var("BRAMA_BENCH_ROOT") else { return };
    let root = PathBuf::from(root).canonicalize().unwrap();

    let t = Instant::now();
    let snapshot = Snapshot::scan(&root);
    println!("scan: {:?}, {} searchable files", t.elapsed(), snapshot.files().count());

    let query = "drvnetethintel";
    for end in 1..=query.len() {
        let t = Instant::now();
        let items = quick_open::search(&snapshot, &[], &query[..end], false, || false).unwrap();
        println!("quick open {:>14}: {:>8.2?} {:>3} hits, top: {:?}", &query[..end], t.elapsed(), items.len(), items.first().map(|i| &i.path));
    }

    let files: Vec<_> = snapshot.files().map(|e| (e.path.clone(), e.size)).collect();
    for (label, query, regex) in [("literal", "kmalloc", false), ("rare", "brama_not_there", false), ("regex", r"\bstatic\s+int\s+\w+_probe\(", true)] {
        let options = SearchOptions {
            query: query.into(),
            case_sensitive: false,
            whole_word: false,
            regex,
            include: String::new(),
            exclude: String::new(),
        };
        let cancel = AtomicBool::new(false);
        let t = Instant::now();
        let first = Mutex::new(None);
        let done = Mutex::new(None);
        search::run(&root, files.clone(), &options, &cancel, &|event| match event {
            SearchEvent::File { .. } => {
                first.lock().unwrap().get_or_insert(t.elapsed());
            }
            SearchEvent::Done { total, limit_hit, .. } => *done.lock().unwrap() = Some((total, limit_hit)),
            SearchEvent::Error { message } => panic!("{message}"),
        });
        println!(
            "find {label:>8}: first result {:?}, done {:?}, (total, limit_hit) = {:?}",
            first.into_inner().unwrap(),
            t.elapsed(),
            done.into_inner().unwrap()
        );
    }

    // Cancellation: stop a full scan for a missing string shortly after it starts.
    let options = SearchOptions {
        query: "brama_not_there".into(),
        case_sensitive: false,
        whole_word: false,
        regex: false,
        include: String::new(),
        exclude: String::new(),
    };
    let cancel = AtomicBool::new(false);
    let t = Instant::now();
    std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            cancel.store(true, Ordering::Relaxed);
        });
        search::run(&root, files.clone(), &options, &cancel, &|_| {});
    });
    println!("cancelled search returned after {:?}", t.elapsed());
}
