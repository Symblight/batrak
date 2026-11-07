//! Against a local server: `agent(false)` is what lets these use plain HTTP.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{channel, Receiver};

use super::super::*;
use super::v;

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
    total: Vec<Option<u64>>,
}

fn get(url: &str, limit: u64) -> Fetched {
    let (mut body, mut total) = (Vec::new(), Vec::new());
    let result = fetch(
        &agent(false),
        url,
        limit,
        &mut |chunk: &[u8]| {
            body.extend_from_slice(chunk);
            Ok(())
        },
        &mut |length| total.push(length),
    );
    Fetched { result, body, total }
}

#[test]
fn fetch_streams_the_body_and_reports_its_length_if_known() {
    for (case, response, length) in [("sized", ok("hello"), Some(5)), ("unsized", unsized_ok("hello"), None)] {
        let (url, _requests) = serve(vec![response]);
        let fetched = get(&url, 100);
        assert_eq!(fetched.result, Ok(()), "{case}");
        assert_eq!(fetched.body, b"hello", "{case}");
        assert_eq!(fetched.total, [length], "{case}");
    }
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
    for status in ["404 Not Found", "201 Created"] {
        let (url, _requests) = serve(vec![format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 4\r\n\r\ngone").into_bytes()]);
        let fetched = get(&url, 100);
        let error = fetched.result.unwrap_err();
        assert!(error.contains(&status[..3]), "{status}: {error}");
        assert!(fetched.body.is_empty(), "{status}");
    }
}

#[test]
fn a_body_over_the_limit_is_refused_whatever_its_length_says() {
    // A declared length is refused before anything is reported or read; without one, the read is cut off.
    for (case, response, total) in [("a length over the limit", ok("too long"), vec![]), ("no length", unsized_ok("too long"), vec![None])] {
        let (url, _requests) = serve(vec![response]);
        let fetched = get(&url, 4);
        let error = fetched.result.unwrap_err();
        assert!(error.contains("limit"), "{case}: {error}");
        assert_eq!(fetched.total, total, "{case}");
        assert!(fetched.body.len() <= 4, "{case}: {} bytes", fetched.body.len());
    }
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

// ---- Manifest

#[test]
fn a_manifest_parses_with_what_is_optional_or_unknown_left_out() {
    let asset = Asset { url: "https://u".into(), signature: "s".into() };
    let cases = [
        (
            "unknown fields ignored",
            r#"{ "version": "0.9.3", "notes": "n", "pub_date": "2026-11-07T00:00:00Z",
                 "platforms": { "darwin-aarch64": { "url": "https://u", "signature": "s", "extra": 1 } } }"#,
            Some("2026-11-07T00:00:00Z".to_owned()),
            BTreeMap::from([("darwin-aarch64".to_owned(), asset)]),
        ),
        ("a leading v and no date", r#"{ "version": "v0.9.3", "platforms": {} }"#, None, BTreeMap::new()),
    ];
    for (case, json, pub_date, platforms) in cases {
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest, Manifest { version: v("0.9.3"), pub_date, platforms }, "{case}");
    }
}

#[test]
fn an_invalid_manifest_is_refused_naming_what_is_wrong() {
    let cases = [
        (r#"{ "version": "soon", "platforms": {} }"#, "soon"),
        (r#"{ "version": "vv0.9.3", "platforms": {} }"#, "vv0.9.3"),
        (r#"{ "platforms": {} }"#, "version"),
        (r#"{ "version": "0.9.3" }"#, "platforms"),
        (r#"{ "version": "0.9.3", "platforms": { "x": { "url": "u" } } }"#, "signature"),
    ];
    for (json, expected) in cases {
        let error = serde_json::from_str::<Manifest>(json).unwrap_err().to_string();
        assert!(error.contains(expected), "{json}: {error}");
    }
}

#[test]
fn a_manifest_is_fetched_and_parsed() {
    let (url, _requests) = serve(vec![ok(r#"{ "version": "0.9.3", "platforms": {} }"#)]);
    let manifest = fetch_manifest(&agent(false), &url).unwrap();
    assert_eq!(manifest.version, v("0.9.3"));
}

#[test]
fn a_manifest_that_cant_be_used_says_why_and_where() {
    let too_long = " ".repeat(usize::try_from(MANIFEST_LIMIT).unwrap() + 1);
    for (body, expected) in [("<html>", "manifest"), (too_long.as_str(), "limit")] {
        let (url, _requests) = serve(vec![unsized_ok(body)]);
        let error = fetch_manifest(&agent(false), &url).unwrap_err();
        assert!(error.contains(&url) && error.contains(expected), "{error}");
    }
}

/// Network, and a published release that has `batrak-cli.json` (`docs/specs/app-update.md` §4 step 4);
/// until then it fails with a 404: `cargo test -p bt-core real_release -- --ignored`.
#[test]
#[ignore]
fn real_release_manifest_parses() {
    let manifest = Http.manifest().unwrap();
    assert!(!manifest.platforms.is_empty());
}
