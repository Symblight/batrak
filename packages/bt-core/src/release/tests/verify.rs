//! Real signatures from `tauri signer`, made with a throwaway key: they can't be made at test time.

use base64::Engine;

use super::super::*;
use super::v;

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
    let engine = base64::engine::general_purpose::STANDARD;
    let text = String::from_utf8(engine.decode(SIGNED).unwrap()).unwrap();
    assert!(text.contains(from));
    engine.encode(text.replace(from, to))
}

#[test]
fn a_signature_names_the_file_it_signed() {
    assert_eq!(signed_file(SIGNED).as_deref(), Ok("batrak-aarch64-apple-darwin"));
    assert_eq!(signed_file(NO_FILE), Err("the signature names no file".to_owned()));
    assert!(signed_file("not a signature").is_err());
}

#[test]
fn a_good_signature_passes() {
    let with_newline = format!("{SIGNED}\n");
    for (case, signature) in [("plain", SIGNED), ("a leading v in the signed version", SIGNED_WITH_V), ("a surrounding newline", with_newline.as_str())] {
        assert_eq!(check(signature, BYTES, "0.9.3", FILE), Ok(()), "{case}");
    }
}

#[test]
fn a_signature_that_doesnt_vouch_for_this_package_is_refused() {
    let mut changed = BYTES.to_vec();
    changed[0] ^= 1;
    let edited = tampered("version:0.9.3", "version:0.9.4");
    // `Ed` instead of `ED`. Flipping it also breaks the signature, so only the message tells this from a bad one.
    let legacy = tampered("\nRUQP", "\nRWQP");
    let cases = [
        ("a changed byte", SIGNED, changed.as_slice(), "0.9.3", FILE, "signature check failed"),
        ("another key", OTHER_KEY, BYTES, "0.9.3", FILE, "signature check failed"),
        ("a comment edited to match", edited.as_str(), BYTES, "0.9.4", FILE, "signature check failed"),
        ("a legacy signature", legacy.as_str(), BYTES, "0.9.3", FILE, "algorithm"),
        ("another version", SIGNED, BYTES, "0.9.4", FILE, "for version 0.9.3, not 0.9.4"),
        ("no version", NO_VERSION, BYTES, "0.9.3", FILE, "names no version"),
        ("another file", SIGNED, BYTES, "0.9.3", "batrak-x86_64-apple-darwin", "not batrak-x86_64-apple-darwin"),
        ("no file", NO_FILE, BYTES, "0.9.3", FILE, "names no file"),
    ];
    for (case, signature, bytes, version, file, expected) in cases {
        let error = check(signature, bytes, version, file).unwrap_err();
        assert!(error.contains(expected), "{case}: {error}");
    }
}

#[test]
fn signatures_that_arent_are_refused_without_a_panic() {
    let engine = base64::engine::general_purpose::STANDARD;
    let one_line = engine.encode("untrusted comment: x");
    let short_box = engine.encode("untrusted comment: x\nRUQ=\ntrusted comment: y\nRUQ=\n");
    let no_prefix = tampered("trusted comment: timestamp", "timestamp");
    let not_utf8 = engine.encode([0xff, 0xfe]);
    for signature in ["", "not base64 !", one_line.as_str(), short_box.as_str(), no_prefix.as_str(), not_utf8.as_str()] {
        let error = check(signature, BYTES, "0.9.3", FILE).unwrap_err();
        assert!(error.contains("invalid signature"), "{signature}: {error}");
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
