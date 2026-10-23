//! Agents the ACP registry ships as archives (`binary`, Google Antigravity): downloaded and
//! unpacked into app data (`agents/<id>/<version>/`) the first time they start. agents.json names
//! one as `${agent:<id>@<version>}` (the repository's file can't hold a path into this machine's
//! app data); it becomes the unpacked program just before it's spawned.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::registry::{Launch, Registry};
use super::AgentConfig;

/// The largest archive downloaded.
const MAX_ARCHIVE: u64 = 1 << 30;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// What an install keeps beside the program: which file it runs.
const MARKER: &str = "brama-install.json";

/// The command agents.json runs a downloaded agent with.
pub fn reference(id: &str, version: &str) -> String {
    format!("${{agent:{id}@{version}}}")
}

/// The id and version of `${agent:<id>@<version>}`; `None` for any other command.
pub fn parse_reference(command: &str) -> Option<(&str, &str)> {
    let inner = command.strip_prefix("${agent:")?.strip_suffix('}')?;
    let (id, version) = inner.rsplit_once('@')?;
    (safe(id) && safe(version)).then_some((id, version))
}

/// A path segment that stays one: letters, digits, `.`, `-`, `_`, and not `.` / `..`.
fn safe(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// This machine's key in the registry's `binary` map (`darwin-aarch64`, `windows-x86_64`…).
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Puts a downloaded agent's version in place. Blocking.
pub trait Installer: Send + Sync {
    /// The program to run: unpacked now, or by an earlier install.
    fn install(&self, id: &str, version: &str) -> Result<PathBuf, String>;
}

/// Fetches an archive. Tests replace it.
pub trait Download: Send + Sync {
    fn download(&self, url: &str, to: &mut dyn Write) -> Result<(), String>;
}

/// Over HTTPS only, at most `MAX_ARCHIVE`, `DOWNLOAD_TIMEOUT`.
pub struct Https;

impl Download for Https {
    fn download(&self, url: &str, to: &mut dyn Write) -> Result<(), String> {
        if !url.starts_with("https://") {
            return Err(format!("{url}: not HTTPS"));
        }
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(DOWNLOAD_TIMEOUT)).build().into();
        let mut response = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
        let mut reader = response.body_mut().with_config().limit(MAX_ARCHIVE).reader();
        std::io::copy(&mut reader, to).map_err(|e| format!("{url}: {e}"))?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct Marker {
    cmd: String,
}

/// Installs from the registry's archives into `dir` (`<app data>/agents`).
pub struct ArchiveInstaller {
    pub dir: PathBuf,
    pub registry: Registry,
    pub download: Arc<dyn Download>,
    /// One install at a time: two sessions starting at once download once.
    pub busy: Mutex<()>,
}

impl ArchiveInstaller {
    pub fn new(dir: PathBuf, registry: Registry, download: Arc<dyn Download>) -> ArchiveInstaller {
        ArchiveInstaller { dir, registry, download, busy: Mutex::default() }
    }
}

impl Installer for ArchiveInstaller {
    fn install(&self, id: &str, version: &str) -> Result<PathBuf, String> {
        if !safe(id) || !safe(version) {
            return Err(format!("not an agent: {id}@{version}"));
        }
        let _busy = self.busy.lock().unwrap_or_else(PoisonError::into_inner);
        let target = self.dir.join(id).join(version);
        if let Some(program) = installed(&target) {
            return Ok(program);
        }
        let entry = self.registry.agents().iter().find(|a| a.id == id).cloned();
        let (name, binary) = match entry {
            Some(agent) => match agent.launch {
                Launch::Binary(binary) if agent.version == version => (agent.name, binary),
                _ => return Err(format!("{} {version} isn't in the ACP registry: update it in the Agents tab", agent.name)),
            },
            None => return Err(format!("{id} isn't in the ACP registry")),
        };
        tracing::info!(agent = %id, version, "downloading the agent");
        let parent = self.dir.join(id);
        std::fs::create_dir_all(&parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        let archive_path = parent.join(format!(".{version}.zip"));
        let unpacked = parent.join(format!(".{version}.partial"));
        let result = (|| {
            let mut file = std::fs::File::create(&archive_path).map_err(|e| format!("{}: {e}", archive_path.display()))?;
            self.download.download(&binary.archive, &mut file).map_err(|e| format!("Downloading {name} failed: {e}"))?;
            drop(file);
            let _ = std::fs::remove_dir_all(&unpacked);
            unzip(&archive_path, &unpacked).map_err(|e| format!("Unpacking {name} failed: {e}"))?;
            let program = unpacked.join(relative(&binary.cmd)?);
            if !program.is_file() {
                return Err(format!("{name}'s archive has no {}", binary.cmd));
            }
            make_executable(&program)?;
            let marker = serde_json::to_string(&Marker { cmd: binary.cmd.clone() }).map_err(|e| e.to_string())?;
            std::fs::write(unpacked.join(MARKER), marker).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_dir_all(&target);
            std::fs::rename(&unpacked, &target).map_err(|e| format!("{}: {e}", target.display()))
        })();
        let _ = std::fs::remove_file(&archive_path);
        if let Err(e) = result {
            let _ = std::fs::remove_dir_all(&unpacked);
            tracing::warn!(agent = %id, version, "{e}");
            return Err(e);
        }
        tracing::info!(agent = %id, version, "agent installed");
        installed(&target).ok_or_else(|| format!("{name} {version} didn't install"))
    }
}

/// The program an install in `target` runs, when it's complete.
fn installed(target: &Path) -> Option<PathBuf> {
    let marker: Marker = serde_json::from_str(&std::fs::read_to_string(target.join(MARKER)).ok()?).ok()?;
    let program = target.join(relative(&marker.cmd).ok()?);
    program.is_file().then_some(program)
}

/// The registry's `cmd` (`./agy_acp_server.par`) as a path inside the install, never out of it.
fn relative(cmd: &str) -> Result<PathBuf, String> {
    let path = Path::new(cmd.strip_prefix("./").unwrap_or(cmd));
    let inside = path.components().all(|c| matches!(c, std::path::Component::Normal(_)));
    if inside && path.components().next().is_some() { Ok(path.to_path_buf()) } else { Err(format!("{cmd}: not a path in the archive")) }
}

/// Unpacks every entry inside `to`; an entry that would land outside it fails the whole archive.
fn unzip(archive: &Path, to: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.enclosed_name().ok_or_else(|| format!("entry {i}: outside the archive"))?;
        let path = to.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        out.write_all(&buf).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o777)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn make_executable(program: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(program).map_err(|e| e.to_string())?.permissions().mode();
        std::fs::set_permissions(program, std::fs::Permissions::from_mode(mode | 0o755)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = program;
    Ok(())
}

/// `agent` as it's spawned: a downloaded agent's `${agent:…}` command becomes its program,
/// installed first when it isn't yet. Blocking.
pub fn resolve(installer: &dyn Installer, agent: &AgentConfig) -> Result<AgentConfig, String> {
    let Some((id, version)) = parse_reference(&agent.command) else { return Ok(agent.clone()) };
    let program = installer.install(id, version)?;
    Ok(AgentConfig { command: program.to_string_lossy().into_owned(), ..agent.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Serves one zip, counting downloads.
    struct Served {
        zip: Vec<u8>,
        count: AtomicUsize,
    }

    impl Download for Served {
        fn download(&self, url: &str, to: &mut dyn Write) -> Result<(), String> {
            assert!(url.starts_with("https://dl.example.com/agy-"), "{url}");
            self.count.fetch_add(1, Ordering::SeqCst);
            to.write_all(&self.zip).map_err(|e| e.to_string())
        }
    }

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, text) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        out.into_inner()
    }

    fn installer(name: &str, zip: Vec<u8>) -> (ArchiveInstaller, Arc<Served>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("brama-install-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let served = Arc::new(Served { zip, count: AtomicUsize::new(0) });
        let registry = Registry::of(super::super::registry::tests::FIXTURE);
        (ArchiveInstaller::new(dir.join("agents"), registry, served.clone()), served, dir)
    }

    #[test]
    fn a_reference_names_an_agent_and_its_version() {
        assert_eq!(reference("antigravity-acp", "1.4.1"), "${agent:antigravity-acp@1.4.1}");
        assert_eq!(parse_reference("${agent:antigravity-acp@1.4.1}"), Some(("antigravity-acp", "1.4.1")));
        assert_eq!(parse_reference("npx"), None);
        assert_eq!(parse_reference("${agent:../x@1}"), None, "stays a folder of its own");
        assert_eq!(parse_reference("${agent:x}"), None, "no version");
    }

    #[test]
    fn a_downloaded_agent_is_unpacked_once_and_runs_its_program() {
        let (installer, served, dir) = installer("fresh", zip_of(&[("agy_acp_server.par", "#!/bin/sh\n"), ("lib/x.txt", "x")]));
        let program = installer.install("antigravity-acp", "1.4.1").unwrap();
        assert_eq!(program, installer.dir.join("antigravity-acp/1.4.1/agy_acp_server.par"));
        assert!(program.is_file() && installer.dir.join("antigravity-acp/1.4.1/lib/x.txt").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(&program).unwrap().permissions().mode() & 0o111, 0, "executable");
        }
        assert_eq!(installer.install("antigravity-acp", "1.4.1").unwrap(), program);
        assert_eq!(served.count.load(Ordering::SeqCst), 1, "installed already: no second download");
        let names: Vec<_> = std::fs::read_dir(installer.dir.join("antigravity-acp")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["1.4.1"], "no archive or partial folder left");

        let agent = AgentConfig { command: reference("antigravity-acp", "1.4.1"), ..AgentConfig::default() };
        assert_eq!(resolve(&installer, &agent).unwrap().command, program.to_string_lossy());
        let npx = AgentConfig { command: "npx".into(), ..AgentConfig::default() };
        assert_eq!(resolve(&installer, &npx).unwrap().command, "npx", "anything else runs as it is");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Downloads the real Antigravity archive of the bundled registry (network) and checks what it
    /// unpacks; it isn't run.
    #[test]
    #[ignore]
    fn real_antigravity_install() {
        let dir = std::env::temp_dir().join(format!("brama-install-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let registry = Registry::bundled();
        let version = registry.agents().iter().find(|a| a.id == "antigravity-acp").expect("in the snapshot").version.clone();
        let installer = ArchiveInstaller::new(dir.join("agents"), registry, Arc::new(Https));
        let program = installer.install("antigravity-acp", &version).unwrap();
        assert!(program.is_file(), "{}", program.display());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(&program).unwrap().permissions().mode() & 0o111, 0, "executable");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_the_registrys_version_of_an_archive_agent_installs() {
        let (installer, served, dir) = installer("refused", zip_of(&[("other", "")]));
        assert!(installer.install("antigravity-acp", "1.0.0").unwrap_err().contains("isn't in the ACP registry"));
        assert!(installer.install("claude-acp", "0.94.0").is_err(), "an npx agent");
        assert!(installer.install("..", "1").is_err());
        let missing = installer.install("antigravity-acp", "1.4.1").unwrap_err();
        assert!(missing.contains("has no ./agy_acp_server.par"), "{missing}");
        assert_eq!(served.count.load(Ordering::SeqCst), 1);
        assert!(!installer.dir.join("antigravity-acp/1.4.1").exists(), "nothing half installed");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
