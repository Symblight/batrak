mod self_update;

use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "batrak", version, about = "Batrak's command line", arg_required_else_help = true)]
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
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Own { command: OwnCommand::Update { check, json } } => self_update::run(check, json),
    }
}
