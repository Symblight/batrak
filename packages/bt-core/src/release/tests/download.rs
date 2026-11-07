use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::super::*;

/// Hands out its chunks, then its ending; stops at the sink's first error, as `Source` promises.
struct Fake {
    chunks: Vec<&'static [u8]>,
    total: Option<u64>,
    fails_with: Option<&'static str>,
    delivered: AtomicUsize,
}

fn fake(chunks: &[&'static [u8]]) -> Fake {
    let total = Some(chunks.iter().map(|c| c.len() as u64).sum());
    Fake { chunks: chunks.to_vec(), total, fails_with: None, delivered: AtomicUsize::new(0) }
}

impl Source for Fake {
    fn manifest(&self) -> Result<Manifest, String> {
        Err("no manifest".into())
    }

    fn package(&self, _: &str, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, total: &mut dyn FnMut(Option<u64>)) -> Result<(), String> {
        total(self.total);
        for chunk in &self.chunks {
            sink(chunk)?;
            self.delivered.fetch_add(1, Ordering::Relaxed);
        }
        self.fails_with.map_or(Ok(()), |message| Err(message.to_owned()))
    }
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("batrak-release-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn download_writes_the_chunks_and_reports_progress_and_total() {
    let dir = folder("chunks");
    let dest = dir.join("missing/folder/pkg.tar.gz");
    let mut seen = Vec::new();

    let done = download(&fake(&[b"ab", b"cde"]), "u", &dest, &AtomicBool::new(false), |received, total| seen.push((received, total)));

    assert_eq!(done, Ok(Downloaded::Done));
    assert_eq!(fs::read(&dest).unwrap(), b"abcde");
    assert_eq!(seen, [(2, Some(5)), (5, Some(5))]);
    assert_eq!(names_in(dest.parent().unwrap()), ["pkg.tar.gz"]);
}

#[test]
fn download_with_no_known_total_reports_none() {
    let dir = folder("no-total");
    let source = Fake { total: None, ..fake(&[b"ab"]) };
    let mut seen = Vec::new();

    download(&source, "u", &dir.join("pkg"), &AtomicBool::new(false), |received, total| seen.push((received, total))).unwrap();

    assert_eq!(seen, [(2, None)]);
}

#[test]
fn a_stale_part_and_an_existing_package_are_replaced() {
    let dir = folder("part");
    let dest = dir.join("pkg.tar.gz");
    fs::write(&dest, b"old").unwrap();
    fs::write(dir.join("pkg.tar.gz.part"), b"left by a crash, longer than the package").unwrap();
    let mut during = Vec::new();

    download(&fake(&[b"new"]), "u", &dest, &AtomicBool::new(false), |_, _| during = names_in(&dir)).unwrap();

    assert_eq!(during, ["pkg.tar.gz", "pkg.tar.gz.part"]);
    assert_eq!(fs::read(&dest).unwrap(), b"new");
    assert_eq!(names_in(&dir), ["pkg.tar.gz"]);
}

#[test]
fn a_cancel_stops_the_transfer_and_leaves_no_part_and_no_dest() {
    let cases: [(&str, bool, &[&'static [u8]], usize); 3] = [
        ("before the start", true, &[b"a"], 0),
        // The sink's error aborts the transfer.
        ("in the middle", false, &[b"a", b"b", b"c"], 1),
        ("during the last chunk", false, &[b"a"], 1),
    ];
    for (case, cancelled, chunks, delivered) in cases {
        let dir = folder(&format!("cancel-{case}"));
        let source = fake(chunks);
        let cancel = AtomicBool::new(cancelled);

        let done = download(&source, "u", &dir.join("pkg"), &cancel, |_, _| cancel.store(true, Ordering::Relaxed));

        assert_eq!(done, Ok(Downloaded::Cancelled), "{case}");
        assert_eq!(source.delivered.load(Ordering::Relaxed), delivered, "{case}");
        assert!(names_in(&dir).is_empty(), "{case}");
    }
}

#[test]
fn a_failed_transfer_leaves_no_part_and_no_dest() {
    let dir = folder("fail");
    let source = Fake { fails_with: Some("connection reset"), ..fake(&[b"a"]) };

    let error = download(&source, "u", &dir.join("pkg"), &AtomicBool::new(false), |_, _| ()).unwrap_err();

    assert_eq!(error, DownloadError::Network("connection reset".to_owned()));
    assert!(names_in(&dir).is_empty());
}

/// `/dev/full` fails every write with "no space", as a full disk does in the middle of a download.
#[cfg(target_os = "linux")]
#[test]
fn a_write_that_fails_during_the_transfer_is_a_disk_failure() {
    let dir = folder("full");
    std::os::unix::fs::symlink("/dev/full", dir.join("pkg.part")).unwrap();

    let error = download(&fake(&[b"a"]), "u", &dir.join("pkg"), &AtomicBool::new(false), |_, _| ()).unwrap_err();

    assert!(matches!(error, DownloadError::Disk(_)), "{error:?}");
}

#[test]
fn a_cancel_or_a_failure_leaves_the_existing_package_untouched() {
    let dir = folder("keep");
    let dest = dir.join("pkg");
    fs::write(&dest, b"old").unwrap();

    let failing = Fake { fails_with: Some("nope"), ..fake(&[b"new"]) };
    download(&failing, "u", &dest, &AtomicBool::new(false), |_, _| ()).unwrap_err();
    assert_eq!(fs::read(&dest).unwrap(), b"old");

    let cancel = AtomicBool::new(false);
    download(&fake(&[b"new"]), "u", &dest, &cancel, |_, _| cancel.store(true, Ordering::Relaxed)).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"old");
    assert_eq!(names_in(&dir), ["pkg"]);
}

#[test]
fn a_rename_that_fails_is_an_error_and_removes_the_part() {
    let dir = folder("rename");
    let dest = dir.join("pkg");
    fs::create_dir(&dest).unwrap();

    let error = download(&fake(&[b"a"]), "u", &dest, &AtomicBool::new(false), |_, _| ()).unwrap_err();

    assert!(matches!(&error, DownloadError::Disk(detail) if detail.contains("pkg")), "{error}");
    assert_eq!(names_in(&dir), ["pkg"]);
}

#[test]
fn a_folder_that_cant_be_created_is_an_error() {
    let dir = folder("no-folder");
    fs::write(dir.join("file"), b"").unwrap();
    let source = fake(&[b"a"]);

    let error = download(&source, "u", &dir.join("file/pkg"), &AtomicBool::new(false), |_, _| ()).unwrap_err();

    assert!(matches!(&error, DownloadError::Disk(detail) if detail.contains("file")), "{error}");
    assert_eq!(source.delivered.load(Ordering::Relaxed), 0);
}
