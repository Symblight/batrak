use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        match writeln!(std::io::stdout(), "batrak {}", env!("CARGO_PKG_VERSION")) {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::FAILURE,
        }
    } else {
        let _ = writeln!(std::io::stderr(), "usage: batrak --version");
        ExitCode::from(2)
    }
}
