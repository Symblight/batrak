//! Releases on GitHub: the manifest, the download and the signature every package must carry. Both
//! fronts use it; how a package gets installed is theirs. A failure comes back as an error and logs
//! at `debug!` only, since each caller decides what its user sees.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use tracing::debug;

pub const REPO_URL: &str = "https://github.com/Symblight/batrak";
/// The same value as `plugins.updater.pubkey` in the desktop's `tauri.conf.json`.
pub const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE4QjZFMTU2MjZBMTFFRUEKUldUcUhxRW1WdUcyR08vYWgvWjZyMjFUcTJ1YmprN3JBMkM1Vzh2eUVsZ2ZtcjlubnhqNXJxYWUK";

const USER_AGENT: &str = concat!("batrak/", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Also how long a cancel can wait, since it is only seen between chunks.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// GitHub sends a release asset through one redirect to another host.
const MAX_REDIRECTS: u32 = 10;
const MANIFEST_LIMIT: u64 = 1024 * 1024;
const PACKAGE_LIMIT: u64 = 500 * 1024 * 1024;
const CHUNK_SIZE: usize = 64 * 1024;

/// `batrak-cli.json` of a release: the same shape as the updater plugin's `latest.json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Manifest {
    #[serde(deserialize_with = "version_field")]
    pub version: Version,
    pub pub_date: Option<String>,
    pub platforms: BTreeMap<String, Asset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Asset {
    pub url: String,
    pub signature: String,
}

/// Semver, with the leading `v` a release tag has.
fn parse_version(text: &str) -> Result<Version, String> {
    Version::parse(text.strip_prefix('v').unwrap_or(text)).map_err(|e| format!("invalid version {text:?}: {e}"))
}

fn version_field<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Version, D::Error> {
    let text = String::deserialize(deserializer)?;
    parse_version(&text).map_err(serde::de::Error::custom)
}

/// The network; tests replace it.
pub trait Source: Send + Sync {
    fn manifest(&self) -> Result<Manifest, String>;
    /// Calls `total` once with the size, if known, then `sink` per chunk. The first error from `sink`
    /// stops the transfer and is returned as it is.
    fn package(&self, url: &str, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, total: &mut dyn FnMut(Option<u64>)) -> Result<(), String>;
}

/// GitHub over HTTPS (`ureq`, rustls), for every hop of a redirect. Blocking.
pub struct Http;

impl Source for Http {
    fn manifest(&self) -> Result<Manifest, String> {
        fetch_manifest(&agent(true), &format!("{REPO_URL}/releases/latest/download/batrak-cli.json"))
    }

    fn package(&self, url: &str, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, total: &mut dyn FnMut(Option<u64>)) -> Result<(), String> {
        fetch(&agent(true), url, PACKAGE_LIMIT, sink, total)
    }
}

fn agent(https_only: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(https_only)
        .http_status_as_error(false)
        .max_redirects(MAX_REDIRECTS)
        .user_agent(USER_AGENT)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .timeout_per_read(Some(READ_TIMEOUT))
        .build()
        .into()
}

fn fetch_manifest(agent: &ureq::Agent, url: &str) -> Result<Manifest, String> {
    let mut body = Vec::new();
    let mut sink = |chunk: &[u8]| {
        body.extend_from_slice(chunk);
        Ok(())
    };
    fetch(agent, url, MANIFEST_LIMIT, &mut sink, &mut |_| ())?;
    serde_json::from_slice(&body).map_err(|e| format!("{url}: invalid manifest: {e}"))
}

/// Counts what it reads, since a `Content-Length` can be wrong or absent.
fn fetch(agent: &ureq::Agent, url: &str, limit: u64, sink: &mut dyn FnMut(&[u8]) -> Result<(), String>, total: &mut dyn FnMut(Option<u64>)) -> Result<(), String> {
    debug!(url, "fetching from a release");
    let mut response = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("{url}: HTTP {status}"));
    }
    let over_limit = || format!("{url}: over the limit of {limit} bytes");
    let length = response.body().content_length();
    if length.is_some_and(|length| length > limit) {
        return Err(over_limit());
    }
    total(length);
    let mut reader = BufReader::with_capacity(CHUNK_SIZE, response.body_mut().as_reader());
    let mut received = 0u64;
    loop {
        let chunk = match reader.fill_buf() {
            Ok(chunk) => chunk,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("{url}: {e}")),
        };
        if chunk.is_empty() {
            return Ok(());
        }
        let size = chunk.len();
        received += size as u64;
        if received > limit {
            return Err(over_limit());
        }
        sink(chunk)?;
        reader.consume(size);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Downloaded {
    Done,
    Cancelled,
}

/// Why a download failed, which a front tells apart for its user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// The transfer: a connection, a status, a limit.
    Network(String),
    /// Our side: making the folder, writing the file, putting it in place.
    Disk(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (Self::Network(detail) | Self::Disk(detail)) = self;
        f.write_str(detail)
    }
}

/// Writes `<dest>.part`, creating the folder, then renames it over `dest`. A cancel or a failure
/// removes the part file and leaves an existing `dest` as it was. Blocking. `cancel` is checked between
/// chunks.
pub fn download(source: &dyn Source, url: &str, dest: &Path, cancel: &AtomicBool, progress: impl FnMut(u64, Option<u64>)) -> Result<Downloaded, DownloadError> {
    let part = part_path(dest);
    let outcome = write_part(source, url, &part, dest, cancel, progress);
    if outcome != Ok(Downloaded::Done) {
        debug!(url, ?outcome, "release download didn't finish");
        let _ = fs::remove_file(&part);
    }
    outcome
}

fn part_path(dest: &Path) -> PathBuf {
    let mut part = OsString::from(dest);
    part.push(OsStr::new(".part"));
    PathBuf::from(part)
}

fn write_part(source: &dyn Source, url: &str, part: &Path, dest: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<Downloaded, DownloadError> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(Downloaded::Cancelled);
    }
    let file_error = |path: &Path, e: std::io::Error| DownloadError::Disk(format!("{}: {e}", path.display()));
    if let Some(folder) = dest.parent() {
        fs::create_dir_all(folder).map_err(|e| file_error(folder, e))?;
    }
    let mut file = File::create(part).map_err(|e| file_error(part, e))?;
    let size = Cell::new(None);
    // `Source` hands back the sink's error as a plain string.
    let write_failed = Cell::new(false);
    let mut received = 0u64;
    let mut sink = |chunk: &[u8]| {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_owned());
        }
        file.write_all(chunk).map_err(|e| {
            write_failed.set(true);
            format!("{}: {e}", part.display())
        })?;
        received += chunk.len() as u64;
        progress(received, size.get());
        Ok(())
    };
    let transfer = source.package(url, &mut sink, &mut |total| size.set(total));
    if cancel.load(Ordering::Relaxed) {
        return Ok(Downloaded::Cancelled);
    }
    transfer.map_err(|e| if write_failed.get() { DownloadError::Disk(e) } else { DownloadError::Network(e) })?;
    file.sync_all().map_err(|e| file_error(part, e))?;
    // Windows can't rename an open file.
    drop(file);
    fs::rename(part, dest).map_err(|e| file_error(dest, e))?;
    Ok(Downloaded::Done)
}

/// Verifies against `PUBKEY`. The trusted comment's `version` must equal `version` and its `file` must
/// equal `file`, so a manifest can't pair a version with another file. A missing field is refused.
pub fn verify(bytes: &[u8], signature: &str, version: &Version, file: &str) -> Result<(), String> {
    verify_with(PUBKEY, bytes, signature, version, file)
}

fn verify_with(key: &str, bytes: &[u8], signature: &str, version: &Version, file: &str) -> Result<(), String> {
    let key = unwrap_box(key).and_then(|text| PublicKey::decode(&text).map_err(|e| e.to_string())).map_err(|e| format!("invalid public key: {e}"))?;
    let signature = decode_signature(signature)?;
    // The signer prehashes, so no legacy signature is ever ours. The comment is signed too: it is read
    // only after this.
    key.verify(bytes, &signature, false).map_err(|e| format!("signature check failed: {e}"))?;

    let comment = signature.trusted_comment();
    let signed_version = signed_field(comment, "version").ok_or("the signature names no version")?;
    let signed_version = parse_version(signed_version).map_err(|e| format!("the signature's version: {e}"))?;
    if signed_version != *version {
        return Err(format!("the signature is for version {signed_version}, not {version}"));
    }
    let signed_file = signed_field(comment, "file").ok_or("the signature names no file")?;
    if signed_file != file {
        return Err(format!("the signature is for {signed_file}, not {file}"));
    }
    Ok(())
}

/// The `file:` a signature's trusted comment names. This checks nothing: the comment means something
/// only once the signature has passed, so call it after that.
pub fn signed_file(signature: &str) -> Result<String, String> {
    let signature = decode_signature(signature)?;
    signed_field(signature.trusted_comment(), "file").map(str::to_owned).ok_or_else(|| "the signature names no file".to_owned())
}

fn decode_signature(wrapped: &str) -> Result<Signature, String> {
    unwrap_box(wrapped).and_then(|text| Signature::decode(&text).map_err(|e| e.to_string())).map_err(|e| format!("invalid signature: {e}"))
}

/// The outer base64 of a Tauri `.sig` or public key.
fn unwrap_box(wrapped: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(wrapped.trim()).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// `timestamp:N\tfile:NAME\tversion:V`
fn signed_field<'a>(comment: &'a str, name: &str) -> Option<&'a str> {
    comment.split('\t').find_map(|field| field.split_once(':').filter(|(key, _)| *key == name).map(|(_, value)| value))
}

/// Whether `latest` is strictly newer than `current`, by semver precedence: a backport published later
/// isn't an update, a release is newer than its prereleases, and build metadata doesn't count.
pub fn compare(current: &Version, latest: &Version) -> bool {
    let precedence = |v: &Version| (v.major, v.minor, v.patch, v.pre.clone());
    precedence(latest) > precedence(current)
}

/// `BATRAK_NO_UPDATE_CHECK` is set and not empty.
pub fn checks_disabled() -> bool {
    disabled_by(std::env::var_os("BATRAK_NO_UPDATE_CHECK"))
}

fn disabled_by(variable: Option<OsString>) -> bool {
    variable.is_some_and(|value| !value.is_empty())
}

/// What a front says about the installed version and the latest release. `latest` is `None` until one
/// answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStatus {
    pub current: String,
    pub latest: Option<String>,
    pub update_available: bool,
    pub self_update: bool,
}

#[cfg(test)]
mod tests;
