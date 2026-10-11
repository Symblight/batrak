//! Logs: one file per day in the app log dir (`~/Library/Logs/dev.brama.app` on macOS), the
//! last `KEEP_FILES` kept, and stderr too in dev builds. `BRAMA_LOG` overrides the level with an
//! `EnvFilter` directive (`debug`, `brama_lib::git=trace`).

use std::backtrace::Backtrace;
use std::path::Path;

use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter, Layer};

const KEEP_FILES: usize = 7;

#[cfg(debug_assertions)]
const DEFAULT_FILTER: &str = "info,brama_lib=debug";
#[cfg(not(debug_assertions))]
const DEFAULT_FILTER: &str = "warn,brama_lib=info";

/// Starts logging to `dir`. Lines are written synchronously, without `non_blocking`'s worker:
/// the event loop exits the process without running destructors, so the worker's guard would
/// never flush its last lines, a panic's among them.
pub fn init(dir: &Path) -> Result<(), String> {
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("brama")
        .filename_suffix("log")
        .max_log_files(KEEP_FILES)
        .build(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let filter = EnvFilter::try_from_env("BRAMA_LOG").unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let file_layer = fmt::layer().with_writer(file).with_ansi(false).with_thread_names(true);
    let stderr_layer = cfg!(debug_assertions).then(|| fmt::layer().with_writer(std::io::stderr));
    tracing_subscriber::registry()
        .with(file_layer.and_then(stderr_layer).with_filter(filter))
        .try_init()
        .map_err(|e| e.to_string())
}

/// Logs every panic with its thread and backtrace, then runs the default hook. A panic in a
/// command's `spawn_blocking` task only fails that call, so without this it leaves no trace.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info.location().map(ToString::to_string).unwrap_or_default();
        tracing::error!(
            target: "panic",
            thread = thread.name().unwrap_or("<unnamed>"),
            %location,
            "{}\n{}",
            info.payload_as_str().unwrap_or("<non-string payload>"),
            Backtrace::force_capture(),
        );
        default(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    // The only test that installs the global subscriber and hook; other tests' lines land here too.
    #[test]
    fn panics_reach_the_log_file() {
        let dir = std::env::temp_dir().join(format!("brama-log-test-{}", std::process::id()));
        init(&dir).unwrap();
        install_panic_hook();
        let _ = std::thread::Builder::new().name("worker".into()).spawn(|| panic!("boom 42")).unwrap().join();
        let logged: String = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(logged.contains("boom 42"), "{logged}");
        assert!(logged.contains("thread=\"worker\""), "{logged}");
        assert!(logged.contains("logging.rs"), "location: {logged}");
    }
}
