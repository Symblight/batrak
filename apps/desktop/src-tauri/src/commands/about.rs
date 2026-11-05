//! About Batrak: the app's version, what it runs on and where its logs are.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::blocking;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutInfo {
    pub version: String,
    /// Name and version, e.g. `macOS 26.1`.
    pub os: String,
    pub arch: &'static str,
    pub log_dir: Option<String>,
}

#[tauri::command]
pub async fn about(app: AppHandle) -> Result<AboutInfo, String> {
    let version = app.package_info().version.to_string();
    let log_dir = Some(app.state::<crate::dirs::Dirs>().logs.to_string_lossy().into_owned());
    blocking(move || AboutInfo {
        version,
        os: os_name(),
        arch: std::env::consts::ARCH,
        log_dir,
    })
    .await
}

fn os_name() -> String {
    os_version().unwrap_or_else(|| std::env::consts::OS.to_owned())
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let out = std::process::Command::new("sw_vers").arg("-productVersion").output().ok()?;
    Some(format!("macOS {}", String::from_utf8_lossy(&out.stdout).trim()))
}

#[cfg(windows)]
fn os_version() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // `Microsoft Windows [Version 10.0.26100.1]`
    let out = std::process::Command::new("cmd").args(["/c", "ver"]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn os_version() -> Option<String> {
    let release = std::fs::read_to_string("/etc/os-release").ok()?;
    let name = release.lines().find_map(|line| line.strip_prefix("PRETTY_NAME="))?;
    Some(format!("{} ({})", name.trim_matches('"'), std::env::consts::OS))
}

/// The Windows build the app runs on, which the terminal's reflow depends on; `None` elsewhere.
#[tauri::command]
pub async fn windows_build() -> Result<Option<u32>, String> {
    #[cfg(windows)]
    {
        super::blocking(|| os_version().and_then(|version| build_of(&version))).await
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// The build in what `ver` prints: `Microsoft Windows [Version 10.0.26100.1]`.
#[cfg(any(windows, test))]
fn build_of(version: &str) -> Option<u32> {
    version.split("Version ").nth(1)?.split(['.', ']']).nth(2)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::build_of;

    #[test]
    fn the_windows_build_is_read_from_what_ver_prints() {
        assert_eq!(build_of("Microsoft Windows [Version 10.0.26100.1]"), Some(26100));
        assert_eq!(build_of("Microsoft Windows [Version 10.0.19045.3803]"), Some(19045));
        assert_eq!(build_of("macOS 26.1"), None);
    }
}
