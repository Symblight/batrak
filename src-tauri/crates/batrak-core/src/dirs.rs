//! Where the app's files live: resolved once by a front and passed down.

use std::path::{Path, PathBuf};

/// The app's bundle identifier, which names the data and log folders.
const IDENTIFIER: &str = "dev.brama.app";
/// Points every folder at another root, for trying things out.
const HOME_VAR: &str = "BRAMA_HOME";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dirs {
    pub data: PathBuf,
    /// Holds `agents.json`, the agents of no project.
    pub config: PathBuf,
    pub logs: PathBuf,
}

impl Dirs {
    /// The home variable's root when it is set, else the app's standard folders.
    pub fn resolve() -> Result<Dirs, String> {
        Self::from_home(std::env::var_os(HOME_VAR).filter(|home| !home.is_empty()).map(PathBuf::from))
    }

    /// Made absolute: agents and git run these folders from other working directories.
    fn from_home(home: Option<PathBuf>) -> Result<Dirs, String> {
        match home {
            Some(root) => Ok(Self::under(&std::path::absolute(&root).map_err(|e| format!("{}: {e}", root.display()))?)),
            None => Self::standard(),
        }
    }

    /// The app's folders, the same ones Tauri's path resolver gives for its identifier.
    pub fn standard() -> Result<Dirs, String> {
        let missing = |what: &str| format!("no {what} folder on this system");
        let data = ::dirs::data_dir().ok_or_else(|| missing("data"))?;
        let config = ::dirs::config_dir().ok_or_else(|| missing("config"))?;
        #[cfg(target_os = "macos")]
        let logs = ::dirs::home_dir().ok_or_else(|| missing("home"))?.join("Library/Logs").join(IDENTIFIER);
        #[cfg(not(target_os = "macos"))]
        let logs = ::dirs::data_local_dir().ok_or_else(|| missing("local data"))?.join(IDENTIFIER).join("logs");
        Ok(Dirs { data: data.join(IDENTIFIER), config: config.join("brama"), logs })
    }

    /// Everything under `root`.
    pub fn under(root: &Path) -> Dirs {
        Dirs { data: root.join("data"), config: root.join("config"), logs: root.join("logs") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_home_variable_moves_every_folder_under_its_root() {
        let root = std::env::temp_dir().join("try-brama");

        let dirs = Dirs::from_home(Some(root.clone())).unwrap();

        assert_eq!(dirs, Dirs { data: root.join("data"), config: root.join("config"), logs: root.join("logs") });
        assert_eq!(Dirs::from_home(None), Dirs::standard(), "no variable, the standard folders");
    }
}
