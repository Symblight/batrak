mod self_update;
mod update_notice;

use std::process::ExitCode;

use clap::error::ErrorKind;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "batrak", bin_name = "batrak", version, about = "Batrak's command line", arg_required_else_help = true)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Batrak's own binary
    #[command(name = "self")]
    Own {
        #[command(subcommand)]
        command: OwnCommand,
    },
}

#[derive(Subcommand)]
enum OwnCommand {
    /// Replace this binary with the latest release
    Update {
        /// Only compare with the latest release; changes nothing
        #[arg(long)]
        check: bool,
        /// Print the comparison as JSON
        #[arg(long, requires = "check")]
        json: bool,
    },
    /// Asks for the latest release and saves the answer for the update notice; a command starts it
    #[command(hide = true)]
    RefreshCheck,
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(version) if version.kind() == ErrorKind::DisplayVersion => {
            let _ = version.print();
            update_notice::after_command();
            return ExitCode::SUCCESS;
        }
        Err(other) => other.exit(),
    };
    match cli.command {
        Command::Own { command: OwnCommand::Update { check, json } } => self_update::run(check, json),
        Command::Own { command: OwnCommand::RefreshCheck } => update_notice::refresh_check(),
    }
}
