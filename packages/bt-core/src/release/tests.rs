use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver};

use semver::Version;

use super::*;

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

// ---- download

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
fn the_part_file_appends_to_the_whole_name_and_a_stale_one_is_replaced() {
    let dir = folder("part");
    let dest = dir.join("pkg.tar.gz");
    fs::write(dir.join("pkg.tar.gz.part"), b"left by a crash, longer than the package").unwrap();
    let mut during = Vec::new();

    download(&fake(&[b"new"]), "u", &dest, &AtomicBool::new(false), |_, _| during = names_in(&dir)).unwrap();

    assert_eq!(during, ["pkg.tar.gz.part"]);
    assert_eq!(fs::read(&dest).unwrap(), b"new");
    assert_eq!(names_in(&dir), ["pkg.tar.gz"]);
}

#[test]
fn download_replaces_an_existing_package() {
    let dir = folder("replace");
    let dest = dir.join("pkg");
    fs::write(&dest, b"old").unwrap();

    download(&fake(&[b"new"]), "u", &dest, &AtomicBool::new(false), |_, _| ()).unwrap();

    assert_eq!(fs::read(&dest).unwrap(), b"new");
}

#[test]
fn a_cancel_stops_the_transfer_and_leaves_no_part_and_no_dest() {
    let dir = folder("cancel");
    let dest = dir.join("pkg");
    let source = fake(&[b"a", b"b", b"c"]);
    let cancel = AtomicBool::new(false);

    let done = download(&source, "u", &dest, &cancel, |_, _| cancel.store(true, Ordering::Relaxed));

    assert_eq!(done, Ok(Downloaded::Cancelled));
    assert_eq!(source.delivered.load(Ordering::Relaxed), 1, "the sink's error aborts the transfer");
    assert!(names_in(&dir).is_empty());
}

#[test]
fn a_cancel_during_the_last_chunk_still_cancels() {
    let dir = folder("cancel-last");
    let cancel = AtomicBool::new(false);

    let done = download(&fake(&[b"a"]), "u", &dir.join("pkg"), &cancel, |_, _| cancel.store(true, Ordering::Relaxed));

    assert_eq!(done, Ok(Downloaded::Cancelled));
    assert!(names_in(&dir).is_empty());
}

#[test]
fn a_cancel_before_the_start_asks_nothing() {
    let dir = folder("cancel-first");
    let source = fake(&[b"a"]);

    let done = download(&source, "u", &dir.join("pkg"), &AtomicBool::new(true), |_, _| ());

    assert_eq!(done, Ok(Downloaded::Cancelled));
    assert_eq!(source.delivered.load(Ordering::Relaxed), 0);
    assert!(names_in(&dir).is_empty());
}

#[test]
fn a_failed_transfer_leaves_no_part_and_no_dest() {
    let dir = folder("fail");
    let source = Fake { fails_with: Some("connection reset"), ..fake(&[b"a"]) };

    let error = download(&source, "u", &dir.join("pkg"), &AtomicBool::new(false), |_, _| ()).unwrap_err();

    assert_eq!(error, "connection reset");
    assert!(names_in(&dir).is_empty());
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

    assert!(error.contains("pkg"), "{error}");
    assert_eq!(names_in(&dir), ["pkg"]);
}

#[test]
fn a_folder_that_cant_be_created_is_an_error() {
    let dir = folder("no-folder");
    fs::write(dir.join("file"), b"").unwrap();
    let source = fake(&[b"a"]);

    let error = download(&source, "u", &dir.join("file/pkg"), &AtomicBool::new(false), |_, _| ()).unwrap_err();

    assert!(error.contains("file"), "{error}");
    assert_eq!(source.delivered.load(Ordering::Relaxed), 0);
}

// ---- verify: real signatures from `tauri signer`, made with a throwaway key.

const FILE: &str = "batrak-aarch64-apple-darwin";
const BYTES: &[u8] = b"batrak release fixture\n";
const TEST_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDkxMTk5Mjc1Mjk5RkFFMEYKUldRUHJwOHBkWklaa1lwTzZRNjhvOEtJL1VZVU9jL0ZLTzk0ZHJLQmVidkl6dGZHd25ZVGdGL2EK";
/// `tauri signer sign --app-version 0.9.3`
const SIGNED: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRUHJwOHBkWklaa2FGcTVuN0pyaEFtM0V3cXVIY3pwZUwveXlpcmdvNEtJWnpSeHUyelkrRlRWUDFpMWFmVjBSWlFiaG5PN1hlWEFwVjczczFXc0ZVUk00eVAvcWorL0FzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDUxOTA2CWZpbGU6YmF0cmFrLWFhcmNoNjQtYXBwbGUtZGFyd2luCXZlcnNpb246MC45LjMKU1BLdGhZenJOcGlwNS9zdTV4NVZkdDlKWkJ4TENIQmU2ZFd6OHFnYjNqcmpFMWErOXk4cmwzS0pPOHFBeG91OU1GaEF4WFJTWFVLejR4Njl2RU1MQlE9PQo=";
/// `tauri signer sign --app-version v0.9.3`, as the release job passes a tag.
const SIGNED_WITH_V: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRUHJwOHBkWklaa1JKOEdSdUZ2d0ZnVjBGZExhd0lnR0ZiTDFHVU92T3g1S2JGbjdqcHZjZVdaOHljOGtCdnZqU084K0cxd0hLVHBzbTVacTRpMHN2UE5hTm51WHV1c2cwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDUyMDM0CWZpbGU6YmF0cmFrLWFhcmNoNjQtYXBwbGUtZGFyd2luCXZlcnNpb246djAuOS4zCm1lTVRaaldKS3NreWtJNUUwOEp5M05lcHlSNmg1UTlpQ1Q4SmRTV1o3a2tJaEZNUVd0dDRiQlNQYVlwb1FKZkxkb3lUZXJOeGF5WU1kQlBrYWF3bEFRPT0K";
/// `tauri signer sign`, without `--app-version`.
const NO_VERSION: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRUHJwOHBkWklaa1ZQdXUyUW92R0tGVGVpalUzS2VJMFNjNldWMTUvU2hwZjRzdFByaWkraUowVm1sU0tzRjZoQStzQndNQ3luV2dEbWJVTFVSeHBwb2JtdkUvRWVxcndZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDUxOTA2CWZpbGU6YmF0cmFrLWFhcmNoNjQtYXBwbGUtZGFyd2luCmpPSEtZNnhZWUgyZGlVSVBIazkxc3NUT2xVdFF3OGNmaTUrK1hMQUtvczRzUFZ6M1NKTlNlWFJzc3orenFQU0M3VER4UFl2QXp1YjRyYmJMVzlqcURBPT0K";
/// The test key, trusted comment `timestamp:…\tversion:0.9.3` (the `minisign` crate; the CLI always writes `file:`).
const NO_FILE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRUHJwOHBkWklaa1NOcy9MdVVZU0hPWmZmMk1ZMExCUS9YNXpScllkckdLRFNDWFNZaC9rbkY5UzBnTjVWTWNQdU9yMzA1b0tWQUhqTTBZVmpWM3hyVGUvbHh2VVhGNkFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDUxOTA2CXZlcnNpb246MC45LjMKakl5dzlpREMwb1Vlc0QrQ0ZFN0xzZ2Zvdml4ZkxqajFKdnJXS1VTa3lZUVNOcnI5VVJxUzkyMjZHcFJmd0JZcnVRUFlqdFdIODdQK2RMQXVaMVljQkE9PQo=";
/// `tauri signer sign --app-version 0.9.3`, another key.
const OTHER_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTTnliSTNoRjVCNW52bkdJOHNBZXlIekR1RnlrQnA3b3NWUUNPc1Z6QmlLdGYzRmc0K0ZYWFFNdXRRLzlacXRJeUEra0NIWEFUUWJNbTN4d0cwS3c0cGg3U2N5VHlrK1FJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDUxOTA3CWZpbGU6YmF0cmFrLWFhcmNoNjQtYXBwbGUtZGFyd2luCXZlcnNpb246MC45LjMKWTVUanJBZ3Q1Y2tlaVVkRmhXV3Z6dzN4SDVhVXRUbU9yYlB5T0tZcDQvN0pvQnhlakR0dFFDU3lqS3JERUJ0TktLWVp4QlhtRnhmNnFlWUI0OVh4QlE9PQo=";

fn check(signature: &str, bytes: &[u8], version: &str, file: &str) -> Result<(), String> {
    verify_with(TEST_KEY, bytes, signature, &v(version), file)
}

/// `SIGNED` with text replaced inside its decoded box.
fn tampered(from: &str, to: &str) -> String {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let text = String::from_utf8(engine.decode(SIGNED).unwrap()).unwrap();
    assert!(text.contains(from));
    engine.encode(text.replace(from, to))
}

#[test]
fn a_good_signature_passes() {
    assert_eq!(check(SIGNED, BYTES, "0.9.3", FILE), Ok(()));
}

#[test]
fn a_signed_version_with_a_leading_v_is_the_same_version() {
    assert_eq!(check(SIGNED_WITH_V, BYTES, "0.9.3", FILE), Ok(()));
}

#[test]
fn a_surrounding_newline_in_the_signature_doesnt_matter() {
    assert_eq!(check(&format!("{SIGNED}\n"), BYTES, "0.9.3", FILE), Ok(()));
}

#[test]
fn a_changed_byte_is_refused() {
    let mut bytes = BYTES.to_vec();
    bytes[0] ^= 1;
    assert!(check(SIGNED, &bytes, "0.9.3", FILE).is_err());
}

#[test]
fn another_keys_signature_is_refused() {
    assert!(check(OTHER_KEY, BYTES, "0.9.3", FILE).is_err());
}

#[test]
fn another_version_than_the_signed_one_is_refused() {
    let error = check(SIGNED, BYTES, "0.9.4", FILE).unwrap_err();
    assert!(error.contains("0.9.3") && error.contains("0.9.4"), "{error}");
}

#[test]
fn a_signature_without_a_version_is_refused() {
    let error = check(NO_VERSION, BYTES, "0.9.3", FILE).unwrap_err();
    assert!(error.contains("version"), "{error}");
}

#[test]
fn another_file_than_the_signed_one_is_refused() {
    let error = check(SIGNED, BYTES, "0.9.3", "batrak-x86_64-apple-darwin").unwrap_err();
    assert!(error.contains(FILE), "{error}");
}

#[test]
fn a_signature_without_a_file_is_refused() {
    let error = check(NO_FILE, BYTES, "0.9.3", FILE).unwrap_err();
    assert!(error.contains("file"), "{error}");
}

#[test]
fn a_trusted_comment_edited_to_match_is_refused() {
    let edited = tampered("version:0.9.3", "version:0.9.4");
    let error = check(&edited, BYTES, "0.9.4", FILE).unwrap_err();
    assert!(error.contains("signature"), "{error}");
}

#[test]
fn signatures_that_arent_are_refused_without_a_panic() {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let one_line = engine.encode("untrusted comment: x");
    let short_box = engine.encode("untrusted comment: x\nRUQ=\ntrusted comment: y\nRUQ=\n");
    let no_prefix = tampered("trusted comment: timestamp", "timestamp");
    let not_utf8 = engine.encode([0xff, 0xfe]);
    for signature in ["", "not base64 !", one_line.as_str(), short_box.as_str(), no_prefix.as_str(), not_utf8.as_str()] {
        assert!(check(signature, BYTES, "0.9.3", FILE).is_err(), "{signature}");
    }
}

#[test]
fn a_public_key_that_isnt_is_refused() {
    assert!(verify_with("not a key", BYTES, SIGNED, &v("0.9.3"), FILE).is_err());
}

/// The built-in key decodes, and it is not the test key: the failure is the key id, not the key's format.
#[test]
fn the_built_in_key_refuses_a_test_keys_signature() {
    let error = verify(BYTES, SIGNED, &v("0.9.3"), FILE).unwrap_err();
    assert!(error.contains("key"), "{error}");
    assert!(!error.contains("public key"), "{error}");
}

// ---- compare

#[test]
fn compare_says_only_a_strictly_newer_version_is_an_update() {
    let cases = [
        ("0.9.2", "0.9.3", true),
        ("0.9.3", "0.10.0", true),
        ("0.9.3", "1.0.0", true),
        ("0.9.3", "0.9.3", false),
        // A backport published later has the older number.
        ("0.10.0", "0.9.4", false),
        ("1.0.0-rc.1", "1.0.0", true),
        ("1.0.0-rc.1", "1.0.0-rc.2", true),
        ("1.0.0", "1.0.0-rc.2", false),
        ("0.9.3", "1.0.0-rc.1", true),
        // Build metadata has no precedence.
        ("1.0.0+a", "1.0.0+b", false),
        ("1.0.0+b", "1.0.0+a", false),
    ];
    for (current, latest, update) in cases {
        assert_eq!(compare(&v(current), &v(latest)), update, "{current} -> {latest}");
    }
}

// ---- checks_disabled

#[test]
fn only_a_non_empty_variable_turns_checks_off() {
    assert!(!disabled_by(None));
    assert!(!disabled_by(Some(OsString::new())));
    assert!(disabled_by(Some(OsString::from("1"))));
    assert!(disabled_by(Some(OsString::from("0"))));
}

// ---- Manifest

#[test]
fn a_manifest_parses_with_unknown_fields_ignored() {
    let manifest: Manifest = serde_json::from_str(
        r#"{ "version": "0.9.3", "notes": "n", "pub_date": "2026-11-07T00:00:00Z",
             "platforms": { "darwin-aarch64": { "url": "https://u", "signature": "s", "extra": 1 } } }"#,
    )
    .unwrap();
    assert_eq!(manifest.version, v("0.9.3"));
    assert_eq!(manifest.pub_date.as_deref(), Some("2026-11-07T00:00:00Z"));
    assert_eq!(manifest.platforms["darwin-aarch64"], Asset { url: "https://u".into(), signature: "s".into() });
}

#[test]
fn a_manifests_version_may_have_a_leading_v_and_no_date() {
    let manifest: Manifest = serde_json::from_str(r#"{ "version": "v0.9.3", "platforms": {} }"#).unwrap();
    assert_eq!(manifest.version, v("0.9.3"));
    assert_eq!(manifest.pub_date, None);
}

#[test]
fn an_invalid_manifest_is_refused_naming_what_is_wrong() {
    let error = serde_json::from_str::<Manifest>(r#"{ "version": "soon", "platforms": {} }"#).unwrap_err().to_string();
    assert!(error.contains("soon"), "{error}");
    let cases = [
        r#"{ "platforms": {} }"#,
        r#"{ "version": "0.9.3" }"#,
        r#"{ "version": "vv0.9.3", "platforms": {} }"#,
        r#"{ "version": "0.9.3", "platforms": { "x": { "url": "u" } } }"#,
    ];
    for case in cases {
        assert!(serde_json::from_str::<Manifest>(case).is_err(), "{case}");
    }
}

// ---- Http, against a local server: `agent(false)` is what lets these use plain HTTP.

/// Answers one connection per response, in order, and sends what each request said.
fn serve(responses: Vec<Vec<u8>>) -> (String, Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (sent, requests) = channel();
    std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap() == 1 {
                request.push(byte[0]);
            }
            let _ = sent.send(String::from_utf8_lossy(&request).into_owned());
            let _ = stream.write_all(&response);
        }
    });
    (url, requests)
}

fn ok(body: &str) -> Vec<u8> {
    format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
}

/// A body whose end is only the connection closing.
fn unsized_ok(body: &str) -> Vec<u8> {
    format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{body}").into_bytes()
}

struct Fetched {
    result: Result<(), String>,
    body: Vec<u8>,
    chunks: usize,
    total: Vec<Option<u64>>,
}

fn get(url: &str, limit: u64) -> Fetched {
    let (mut body, mut chunks, mut total) = (Vec::new(), 0, Vec::new());
    let result = fetch(
        &agent(false),
        url,
        limit,
        &mut |chunk: &[u8]| {
            body.extend_from_slice(chunk);
            chunks += 1;
            Ok(())
        },
        &mut |length| total.push(length),
    );
    Fetched { result, body, chunks, total }
}

#[test]
fn fetch_streams_the_body_and_reports_its_length() {
    let (url, _requests) = serve(vec![ok("hello")]);
    let fetched = get(&url, 100);
    assert_eq!(fetched.result, Ok(()));
    assert_eq!(fetched.body, b"hello");
    assert_eq!(fetched.total, [Some(5)]);
}

#[test]
fn fetch_of_an_unsized_body_reports_no_length() {
    let (url, _requests) = serve(vec![unsized_ok("hello")]);
    let fetched = get(&url, 100);
    assert_eq!(fetched.result, Ok(()));
    assert_eq!(fetched.body, b"hello");
    assert_eq!(fetched.total, [None]);
}

#[test]
fn fetch_follows_a_redirect_to_another_host_and_says_who_it_is() {
    let (target, target_requests) = serve(vec![ok("moved")]);
    let redirect = format!("HTTP/1.1 302 Found\r\nLocation: {target}/asset\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let (url, requests) = serve(vec![redirect.into_bytes()]);

    let fetched = get(&url, 100);

    assert_eq!(fetched.result, Ok(()));
    assert_eq!(fetched.body, b"moved");
    let expected = format!("batrak/{}", env!("CARGO_PKG_VERSION"));
    for request in [requests.recv().unwrap(), target_requests.recv().unwrap()] {
        let lower = request.to_lowercase();
        assert!(lower.contains(&format!("user-agent: {expected}\r\n")), "{request}");
    }
}

#[test]
fn anything_but_200_is_an_error_and_reaches_no_sink() {
    let (url, _requests) = serve(vec![b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 4\r\n\r\ngone".to_vec()]);
    let fetched = get(&url, 100);
    let error = fetched.result.unwrap_err();
    assert!(error.contains("404"), "{error}");
    assert!(fetched.body.is_empty());
}

#[test]
fn a_length_over_the_limit_is_refused_before_any_chunk() {
    let (url, _requests) = serve(vec![ok("too long")]);
    let fetched = get(&url, 4);
    let error = fetched.result.unwrap_err();
    assert!(error.contains("limit"), "{error}");
    assert_eq!(fetched.chunks, 0);
}

#[test]
fn an_unsized_body_over_the_limit_is_cut_off() {
    let (url, _requests) = serve(vec![unsized_ok("too long")]);
    let fetched = get(&url, 4);
    let error = fetched.result.unwrap_err();
    assert!(error.contains("limit"), "{error}");
    assert!(fetched.body.len() <= 4, "{} bytes", fetched.body.len());
}

#[test]
fn a_body_of_exactly_the_limit_passes() {
    let (url, _requests) = serve(vec![unsized_ok("four")]);
    assert_eq!(get(&url, 4).result, Ok(()));
}

#[test]
fn a_body_shorter_than_its_length_is_an_error() {
    let (url, _requests) = serve(vec![b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 100\r\n\r\nshort".to_vec()]);
    assert!(get(&url, 1000).result.is_err());
}

#[test]
fn a_sinks_error_aborts_the_transfer_and_comes_back() {
    let (url, _requests) = serve(vec![ok("hello")]);
    let mut calls = 0;
    let result = fetch(
        &agent(false),
        &url,
        100,
        &mut |_: &[u8]| {
            calls += 1;
            Err("stop".to_owned())
        },
        &mut |_| (),
    );
    assert_eq!(result, Err("stop".to_owned()));
    assert_eq!(calls, 1);
}

#[test]
fn http_refuses_plain_http_without_connecting() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/asset", listener.local_addr().unwrap());

    let error = Http.package(&url, &mut |_: &[u8]| Ok(()), &mut |_| ()).unwrap_err();

    assert!(error.contains("https"), "{error}");
    assert!(listener.accept().is_err(), "no connection was tried");
}

#[test]
fn a_manifest_is_fetched_and_parsed() {
    let (url, _requests) = serve(vec![ok(r#"{ "version": "0.9.3", "platforms": {} }"#)]);
    let manifest = fetch_manifest(&agent(false), &url).unwrap();
    assert_eq!(manifest.version, v("0.9.3"));
}

#[test]
fn a_manifest_that_doesnt_parse_says_so() {
    let (url, _requests) = serve(vec![ok("<html>")]);
    let error = fetch_manifest(&agent(false), &url).unwrap_err();
    assert!(error.contains(&url) && error.contains("manifest"), "{error}");
}

#[test]
fn a_manifest_over_its_limit_is_refused() {
    let body = " ".repeat(usize::try_from(MANIFEST_LIMIT).unwrap() + 1);
    let (url, _requests) = serve(vec![unsized_ok(&body)]);
    let error = fetch_manifest(&agent(false), &url).unwrap_err();
    assert!(error.contains("limit"), "{error}");
}

#[test]
fn the_user_agent_says_only_the_version() {
    assert_eq!(USER_AGENT, format!("batrak/{}", env!("CARGO_PKG_VERSION")));
}

/// Network, and a published release that has `batrak-cli.json` (`docs/specs/app-update.md` §4 step 4);
/// until then it fails with a 404: `cargo test -p bt-core real_release -- --ignored`.
#[test]
#[ignore]
fn real_release_manifest_parses() {
    let manifest = Http.manifest().unwrap();
    assert!(!manifest.platforms.is_empty());
}
