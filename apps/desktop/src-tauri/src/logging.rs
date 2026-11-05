//! Logs: one file per day in the app log dir (`~/Library/Logs/dev.batrak.app` on macOS), the
//! last `KEEP_FILES` kept, and stderr too in dev builds. `BATRAK_LOG` overrides the level with an
//! `EnvFilter` directive (`debug`, `batrak_core::git=trace`, `agent_acp=debug`). Our own warnings and errors also
//! reach every window as `app://notice`, which shows them as snackbars.

use std::backtrace::Backtrace;
use std::cell::Cell;
use std::fmt::{self, Write};
use std::path::Path;
use std::sync::Arc;

use crate::notify::{NoticeLevel, Notifier};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt as tracing_fmt, EnvFilter, Layer};

const KEEP_FILES: usize = 7;
/// A notice is a snackbar line, not a log: longer text is cut (the log file keeps all of it).
const MAX_NOTICE: usize = 500;

/// Our crates' log targets: the app's, the core's, and the agent crates' that log (`agent-acp`). Their lines get
/// the app's level, and their warnings and errors reach the windows.
const OWN_TARGETS: [&str; 3] = ["batrak_desktop", "batrak_core", "agent_acp"];

#[cfg(debug_assertions)]
const DEFAULT_FILTER: &str = "info,batrak_desktop=debug,batrak_core=debug,agent_acp=debug";
#[cfg(not(debug_assertions))]
const DEFAULT_FILTER: &str = "warn,batrak_desktop=info,batrak_core=info,agent_acp=info";

/// Whether a line is one of our crates' (`OWN_TARGETS`, or a module of one).
fn is_own(target: &str) -> bool {
    OWN_TARGETS.iter().any(|own| target.strip_prefix(own).is_some_and(|rest| rest.is_empty() || rest.starts_with("::")))
}

/// Starts logging to `dir`, and tells `notifier` of our failures when given. Lines are written synchronously, without `non_blocking`'s worker:
/// the event loop exits the process without running destructors, so the worker's guard would
/// never flush its last lines, a panic's among them.
pub fn init(dir: &Path, notifier: Option<Arc<dyn Notifier>>) -> Result<(), String> {
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("batrak")
        .filename_suffix("log")
        .max_log_files(KEEP_FILES)
        .build(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let filter = EnvFilter::try_from_env("BATRAK_LOG").unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let file_layer = tracing_fmt::layer().with_writer(file).with_ansi(false).with_thread_names(true);
    let stderr_layer = cfg!(debug_assertions).then(|| tracing_fmt::layer().with_writer(std::io::stderr));
    tracing_subscriber::registry()
        .with(file_layer.and_then(stderr_layer).with_filter(filter))
        .with(notifier.map(|notifier| NoticeLayer { notifier }))
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

/// Forwards our crates' warnings and errors (`is_own`), and panics, to every window. Not under `BATRAK_LOG`:
/// a quieter log must not hide failures from the user. `frontend` lines came from the page, which
/// has shown them already.
struct NoticeLayer {
    notifier: Arc<dyn Notifier>,
}

thread_local! {
    /// Set while emitting, so an event logged by the emit itself isn't forwarded in a loop.
    static EMITTING: Cell<bool> = const { Cell::new(false) };
}

impl<S: Subscriber> Layer<S> for NoticeLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let level = match *meta.level() {
            Level::ERROR => NoticeLevel::Error,
            Level::WARN => NoticeLevel::Warn,
            _ => return,
        };
        let target = meta.target();
        if !(is_own(target) || target == "panic") {
            return;
        }
        if EMITTING.with(|emitting| emitting.replace(true)) {
            return;
        }
        let mut text = NoticeText::default();
        event.record(&mut text);
        self.notifier.notice(level, &text.finish());
        EMITTING.with(|emitting| emitting.set(false));
    }
}

/// The message's first line (a panic's backtrace follows it) and the event's fields.
#[derive(Default)]
struct NoticeText {
    message: String,
    fields: String,
}

impl NoticeText {
    fn finish(self) -> String {
        let first_line = self.message.lines().next().unwrap_or_default();
        let text = if self.fields.is_empty() { first_line.to_owned() } else { format!("{first_line} ({})", self.fields) };
        match text.char_indices().nth(MAX_NOTICE) {
            Some((end, _)) => format!("{}…", &text[..end]),
            None => text,
        }
    }

    fn field(&mut self, field: &Field, value: fmt::Arguments) {
        if field.name() == "message" {
            let _ = self.message.write_fmt(value);
            return;
        }
        if !self.fields.is_empty() {
            self.fields.push_str(", ");
        }
        let _ = write!(self.fields, "{}: {value}", field.name());
    }
}

impl Visit for NoticeText {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.field(field, format_args!("{value}"));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.field(field, format_args!("{value:?}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_crates_lines_are_ours_wherever_they_log() {
        for target in ["batrak_desktop", "batrak_desktop::git", "batrak_core", "batrak_core::session::runtime", "agent_acp", "agent_acp::connection"] {
            assert!(is_own(target), "{target}");
        }
        for target in ["hyper", "agent_acpx", "batrak_desktops", "batrak_corex"] {
            assert!(!is_own(target), "{target}");
        }
        for target in OWN_TARGETS {
            assert!(DEFAULT_FILTER.contains(&format!("{target}=")), "the default filter keeps {target}'s lines");
        }
    }

    // The only test that installs the global subscriber and hook; other tests' lines land here too.
    #[test]
    fn panics_reach_the_log_file() {
        let dir = std::env::temp_dir().join(format!("batrak-log-test-{}", std::process::id()));
        init(&dir, None).unwrap();
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
