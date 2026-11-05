# Batrak

An agent-first client for AI coding agents over [ACP](https://agentclientprotocol.com): one core
that runs agents, sessions and workspaces, and two fronts over it, a desktop app and a command-line
tool. The successor of Brama.

```
apps/desktop    Tauri + Lit: chats, workspaces, editor, search, changes, terminals
apps/cli        batrak: the same agents, sessions and workspaces from a terminal
packages/       bt-core and the agent crates, shared by both apps
docs/specs      one spec per feature
```

`ARCHITECTURE.md` says how the pieces fit and where new code goes. `docs/specs/README.md` says how
a spec is written.

## Status

The repository is being set up. The code arrives from Brama in the steps of `ARCHITECTURE.md` §9;
until then the folders are empty.

## Build and run

Prerequisites: Rust (stable), Node 22 with pnpm, and Tauri's platform
[prerequisites](https://tauri.app/start/prerequisites/) for the desktop app.

```bash
cargo test --workspace                       # every crate's tests
cargo clippy --all-targets                   # no warnings
cargo run -p batrak -- status                # the CLI

cd apps/desktop
pnpm install
pnpm tauri dev                               # the desktop app
pnpm typecheck && pnpm test                  # the frontend's checks
```

`BATRAK_HOME=<folder>` points both apps at another app-data root, for trying things out.

## Layout rules

- `apps/` holds what a user runs. An app depends on packages and never on another app.
- `packages/` holds what the apps share. A package never depends on an app. Today every package
  is a Rust crate; a JavaScript package goes here too the day two apps share one.
- Anything about agents, sessions, workspaces or a project's `.bt/` folder belongs in
  `packages/bt-core`. Anything that names a window, a tab, a PTY, a TTY or a DOM node belongs
  in an app.
