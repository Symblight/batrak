# Batrak — architecture

Status: draft · 2026-11-05 · builds on
`docs/specs/cli.md`, `agent-plugins.md`, `workspaces.md`, `session-sync.md`, `subagents.md`.

Batrak is an agent-first client for AI coding agents over ACP. One library, **`bt-core`**,
holds everything about agents, sessions, workspaces and a project's `.bt/` folder. Two thin
fronts render it: the **desktop app** (Tauri + a Lit web UI) and the **CLI** (`batrak`). Later
features (spec-driven pipelines, MCP, routing) land in the core and show up in both fronts.

```
                          ┌─ apps/desktop   Tauri commands + events, the window, the editor (files, search, git, terminals), the Lit UI
packages/bt-core ─────┤
                          └─ apps/cli       clap verbs, a TTY renderer, inherit-stdio program runner
                          │
                          └─ packages/agent-api · agent-acp · agent-kit · agent-claude · agent-codex · agent-copilot · agent-antigravity · agent-generic
```

## 1. The one rule

**The core knows agents, sessions, workspaces and the project's `.bt/`. A front knows its
surface: a window and an editor, or a terminal.** Anything a second front would have to
re-implement belongs in the core. Anything that names a window, a webview, a tab, a PTY, a TTY,
an ANSI color or a DOM node belongs in a front.

Consequences:

- The core has no binary and depends on no UI toolkit: no `tauri`, no `clap`, no terminal crate.
  A grep for `tauri` over `packages/` finds nothing; `cargo test -p bt-core` runs without a window.
- The core calls **out** only through traits it declares (§4). A front implements them.
- The core speaks **in** through methods, **out** through typed events. It never asks a question
  the way a UI would; it emits an event that carries the options and takes the answer as a method
  call (permission requests today, pipeline gates tomorrow).
- The core's serde types are the contract (§5). Both fronts render them as they are; the desktop's
  IPC and the CLI's `--json` print the same JSON, so the two fronts never disagree on a state word.

## 2. Repository layout

```
Batrak/
├── ARCHITECTURE.md             this file
├── README.md                   what Batrak is, how to build and run each app
├── CLAUDE.md                   working rules for agents (commands, conventions, tests)
├── Cargo.toml                  one workspace: packages/*, apps/cli, apps/desktop/src-tauri; all default members
├── apps/                       what a user runs; each app is a thin front over the packages
│   ├── desktop/
│   │   ├── src-tauri/          `bt_desktop` (lib) + main: commands/, lib.rs, menu, logging, roots/, editor git, PTY terminals
│   │   ├── src/                the Lit frontend: views/, components/, controllers/, hooks/, stores/, styles/
│   │   ├── test/               frontend test helpers
│   │   ├── package.json  pnpm-lock.yaml  rsbuild.config.js  jsconfig.json  web-test-runner.config.mjs  index.html
│   │   └── scripts/
│   └── cli/                    the `batrak` binary (§7)
├── packages/                   what the apps share; a package never depends on an app
│   ├── bt-core/            the library (§3)
│   ├── agent-api/              the `Agent` trait and the types every agent crate shares; no I/O
│   ├── agent-acp/              the generic ACP driver: process, connection, catalog, auth; the fake agent (test-support)
│   ├── agent-kit/              what several agent crates share: npx launches, pinning, downloads
│   └── agent-claude/ agent-codex/ agent-copilot/ agent-antigravity/ agent-generic/
└── docs/specs/                 one spec per feature, status line first
```

`apps/` holds the two fronts; `packages/` holds everything they share. Today every package is a
Rust crate. A JavaScript package goes under `packages/` too the day two apps share one (a web UI
reused by another front, say); until then the desktop's frontend stays inside `apps/desktop/`, and
there is no root `package.json`. The dependency direction is one way: an app depends on packages,
a package never on an app or on another app's files.

**The project's service folder is `.bt/`**: `agents.json`, `workspace.json`,
`local/`, `attachments/`, and later `specs/`, `pipelines/`, `tools.json`. Two letters keep chat refs
and paths short (`@.bt/specs/snackbar/tasks.md`). `.bk` was rejected: it is BitKeeper's repository
folder, and `*.bk` is a common backup ignore pattern that would hide the folder from git.

Commands, from the repo root unless said:

```bash
cargo test --workspace                 # every crate's tests
cargo clippy --all-targets             # no warnings
cargo run -p batrak -- status          # the CLI
cd apps/desktop && pnpm typecheck && pnpm test && pnpm tauri dev
```

## 3. `bt-core`

What it holds, module by module.

| Module | Holds |
| --- | --- |
| `session/` | `Sessions`: lifecycle, turns, permissions, turn slots per folder, sync with the agents' own lists, replay for a client that attaches, subagents, sign-in, the agent's CLI, worktree helpers |
| `workspace/` | `Workspaces`: records in `workspaces.json`, worktree checkout, naming, delete, apply, check out branch |
| `config/` | `.bt/agents.json` and the user's file, merging, trust, on/off switches, the ACP registry, updates, the user-file watcher |
| `release/` | The app's own releases: the manifest, downloading a package, its minisign signature, comparing versions |
| `agents/` | `AgentHub`: which agent crate drives a launch; the one place that names the crates |
| `git/` | the git sessions and workspaces need: `exec` (one path for every call), `lock`, `binary`, `temp_file`, `worktree`, `apply`; `test_repo` behind `test-support`, since the desktop's git tests use it too. The Changes views' git is the desktop's (§7.1) |
| `storage/` | `JsonFile`: atomic JSON documents in app data, cross-process safe (§6) |
| `project/` | the project's `.bt/` folder: creating it, `workspace.json`, and later `specs/`, `pipelines/`, `tools.json` (§8) |
| `util` | `checked_rel`, `write_atomic`, ISO time, `default_shell` |
| `dirs` | `Dirs { data, config, logs }` (§4.1) |
| `api` | re-exports of every type a front renders (§5) |

The crate lives in `packages/bt-core/`, beside the agent crates it depends on.

What stops this split today, measured from the `crate::` paths on 2026-11-05. Everything else
in these modules is already free of Tauri: only `commands/`, `lib.rs`, `menu.rs`, `logging.rs` and
`roots/mod.rs` name it.

| Edge that must go | Where | Fix |
| --- | --- | --- |
| `session` → `terminal` (PTY tabs) | `session/runtime/cli.rs`, and the login in `commands/agents.rs` | `ProgramRunner` (§4.5) |
| `session` → `roots::checked_rel` | `session/runtime/turn.rs`, `workspaces.rs` | `util` |
| `config` → `terminal::shell`, `config` → `session::env`, `config` and `workspace` → `session`'s ISO time | `config/env.rs`, `config/mod.rs`, `config/registry.rs`, `workspace/` | `util` |
| `git/repo.rs` → `git/remote.rs`, `session` → `git/blob.rs` | | both go to the core with `repo` and `session` |

Edges pointing the allowed way stay as they are: `roots` → `git::cache`, `config` and `session`,
`terminal` → `git::exec`, `commands` → all of it. `roots` keeps its `Host` trait and its
`impl Host for AppHandle`, since both stay in the desktop.

Rules inside the core:

- Agent-specific behavior lives in that agent's crate behind `agent_api::Agent`; the core calls the
  hub, never an agent by name.
- Every git call goes through `git::exec`; anything that changes a repository runs under
  `git::lock::with_mutation`, keyed by the common git dir.
- Blocking work is called from `spawn_blocking` by the front; the core's methods say in their doc
  comment whether they block. Work that can be superseded takes a cancel flag.
- `tracing` everywhere; `warn!` only for real failures, since a front shows them to the user.

## 4. Seams: what the core takes from a front

Every trait is declared in the core, implemented by each front, and has a recording fake in the
core's tests.

### 4.1 `Dirs`

```rust
pub struct Dirs { pub data: PathBuf, pub config: PathBuf, pub logs: PathBuf }
impl Dirs {
    pub fn standard() -> Dirs;        // the platform's folders for the identifier `dev.batrak.app`
    pub fn under(root: &Path) -> Dirs; // tests and BATRAK_HOME
}
```

Resolved once by each front, passed down, never read from a global. The desktop passes what Tauri
gives; the CLI resolves the same folders from the identifier, and a test in the desktop crate
asserts the two agree on each OS. `BATRAK_HOME` points both fronts at another root.

Files under `data`: `sessions.json`, `workspaces.json`, `trusted-agents.json`,
`agent-versions.json`, `agent-switches.json`, `acp-registry.json`, `npm/`, `probe/`,
`worktrees/<repo>-<hash>/<slug>`, `sessions/<id>/agent.log`. Under `config`: `agents.json`, the
agents of no project.

### 4.2 `Notifier`: what changed, for everyone

```rust
pub trait Notifier: Send + Sync {
    fn agents_changed(&self, project: Option<&Path>);
    fn sessions_synced(&self, project: &Path, sessions: &[Session], report: &SyncReport);
    fn workspaces_changed(&self, project: &Path);
    fn sign_in(&self, event: &SignInEvent);
    fn notice(&self, level: Level, message: &str);
}
```

Configs, the updater, the registry, the user-file watcher and workspaces call it; `Sessions`
subscribes to `agents_changed` itself (following agents.json is the core's job, not a front's).
The desktop's implementation emits one Tauri event per method to every window; the CLI's prints a
line or nothing. Payloads are the core's structs, never JSON built in a front.

### 4.3 `EventSink` + `Envelope`: one session's stream

```rust
pub struct Envelope { pub session_id: String, pub seq: u64, pub kind: &'static str, pub payload: Value }
pub trait EventSink: Send + Sync { fn send(&self, envelope: &Envelope) -> bool; }
```

A client attaches a sink to a session under its **client id** (§4.6) and gets every event in
order: `update` (raw ACP `SessionUpdate`), `status`, `session`, `activity`, `turn-start`,
`turn-end`, `permission-request`, `config-options`, `subagents`, `snapshot` (for a client attaching
mid-run), `error`, `cli-exited`, and the notices (`queued`, `held`, `prompt-returned`, `overlap`,
`agent-outdated`, `unconfigured`, `untrusted`, `sign-in`). The desktop forwards it over a Tauri channel; the CLI renders it on a TTY.
A question to the user is an event with options, answered by a method
(`respond_permission`, later `respond_gate`): the sink never blocks.

### 4.4 `Launcher`, `SecretStore`, `Fetch`, `Prefetch`

The agent process (a fake in tests), `${env:…}` / `${keychain:…}` resolution at spawn
only, the registry's HTTP, the npm prefetch of an update.

### 4.5 `ProgramRunner`: a program the user watches

```rust
pub trait ProgramRunner: Send + Sync {
    fn run(&self, id: &str, cwd: &Path, program: Program, size: Option<(u16, u16)>, on_exit: OnExit) -> Result<(), String>;
    fn close(&self, id: &str);
    fn busy(&self, id: &str) -> bool;
}
```

Used for a `terminal` / `command` sign-in method and for continuing a session in its agent's own
CLI. The core builds the command line (the agent crate's `CliSpec`, `cli_args` for the session's
picks) and maps the exit (`0` signs in; a closed login cancels; a CLI's exit ends `in_terminal`).
The desktop runs it in a PTY tab of the calling window; the CLI inherits stdio and execs. The PTY
implementation lives in the desktop, not the core.

### 4.6 Clients, not windows

A front attaches as a **client** (`ClientId`): a window label in the desktop, `cli-<pid>` in the
CLI. Sinks, program runners, terminal groups and "shown in another client" are keyed by it.
Nothing in the core says "window".

## 5. The contract: `bt_core::api`

One module re-exports every type a front renders: `Session`, `SessionStatus`, `Envelope`,
`SyncReport`, `Workspace`, `WorkspaceRecord`, `AgentsView`, `AgentRow`, `RegistryRow`,
`RegistryState`, `AgentSummary`, `SignInState`, `Updated`, `DeletePreview`, later `Spec`,
`Pipeline`, `Gate`, `Task`, `McpServer`. They are `serde` types with `camelCase` fields and stay
backward compatible: a front built against an older core still parses a newer one's output
(additive fields with `#[serde(default)]`, no renames without a version step).

The desktop's `commands/` serialize them to the page unchanged; `apps/desktop/src/hooks/<feature>/types.js`
mirrors each in JSDoc. The CLI's `--json` prints them unchanged. A test in the core snapshots the
JSON of each, so a change to the contract is a reviewed diff.

## 6. Two processes, one app data

The desktop and the CLI run side by side on the same files.

- **Writes take the file's lock.** `JsonFile` holds an advisory lock (`<file>.lock`) around
  read-modify-write, so two processes never interleave a `sessions.json` write.
- **Readers reload on change.** The desktop watches its data dir and reloads `sessions.json`,
  `workspaces.json`, `agent-switches.json` and `trusted-agents.json` after a foreign write
  (recognized by an mtime it didn't set), then notifies as if the change were its own. The CLI, a
  short-lived process, reads at start.
- **A running agent has an owner.** `sessions/<id>/owner` holds the pid and client id, written at
  start, removed at stop; a stale one (no such pid) is ignored. A front refuses to send to, resume
  or remove a session another live process owns (`running in Batrak` / `running in the CLI`).
- A project's `.bt/agents.json` edited by either front reaches the other through the watcher
  it already has, like an editor's edit.

A socket to a running desktop, so the CLI drives its sessions instead of its own, is a later step
and changes nothing above.

## 7. The fronts

### 7.1 Desktop (`apps/desktop/`)

- `src-tauri/`: `commands/` (one file per feature, each a thin map from a command to a core
  method), `lib.rs` (the builder, state, window lifecycle), `menu.rs`, `logging.rs` (daily files,
  the notice layer that implements `Notifier::notice`), the editor side that never enters the
  core: `roots/` (snapshot, watcher, Quick Open, Find in Files, open-root groups per window),
  editor git (`status`, `line_counts`, `repo`, `remote`, `branches`, `blob`, `compare`, `revert`, `workspace_changes`, `commit`, `cache`, over the core's `git/`), `github.rs`, `fs`, attachments,
  drops, fonts, about, `app_update/` (the app's own updates, over `tauri-plugin-updater` and the
  core's `release`) and `terminal/` (PTY tabs; implements `ProgramRunner`).
- `src/`: the Lit UI. `hooks/ipc/ipc.js` is the only module that imports
  `@tauri-apps/*`; each feature's hook owns its command names; containers subscribe to stores,
  everything else is presentational. Its own rules live in `apps/desktop/CLAUDE.md` and
  `docs/specs/frontend-structure.md`.

### 7.2 CLI (`apps/cli/`)

The `batrak` binary over the core, clap verbs with no prefix, every one a core method:

| Verb | Core |
| --- | --- |
| `status`, `agents [query] [--updates\|--off]` | `AgentConfigs::view`, `Registry::state`, `Sessions::list` |
| `add <registry id>`, `remove <id>`, `on`/`off <id>`, `default <id>`, `import`, `trust` | `AgentConfigs::*` |
| `update [id\|--all]`, `registry check`, `sign-in <id> [--method]` | `Updater`, `Registry::check`, `Sessions::sign_in` |
| `sessions [--sync]`, `rename`, `rm`, `log [-f]` | `Sessions::sync`, `list`, `rename`, `remove`, `log_path` |
| `run <agent> [prompt] [--workspace\|--new-workspace [--base]] [--model] [--mode]`, `send <id>` | `Sessions::create`, `send_prompt`, an `EventSink` rendered on the TTY |
| `resume <id>` | `Sessions::open_cli` through the inherit-stdio `ProgramRunner` |
| `workspaces`, `workspace new\|rm\|apply\|checkout` | `Workspaces::*` |
| `self update [--check [--json]]` | `release::*`; replacing the binary is the CLI's (`self_update.rs`) |
| later: `spec new\|status\|approve`, `tasks run`, `mcp` | §8 |

Scope: the project whose folder the command runs in (walking up to the first `.bt/`), else the
user's agents; `--project <path>` and `--user` override. `--json` on every listing prints the
contract (§5). Exit codes: 0 after `turn-end`, 1 after `error`, 130 when cancelled.

## 8. Where the next features go

Each one is files in the project as the source of truth, read, written and watched by the core,
rendered by the fronts. The agent never needs Batrak to continue.

- **Specs** (`bt-core` `project/specs`): `.bt/specs/<slug>/{requirements,design,tasks,verify}.md`,
  status in front matter (`draft | review | approved`, `approved_by`, `approved_at`). The core
  parses them, watches them, and notifies `spec_changed`. Editing the file by hand equals the
  agent editing it; approving an earlier stage's file puts the later ones back to `review`.
- **Pipelines as data** (`bt-core` `project/pipelines`): `.bt/pipelines/<name>.json` with
  `stages[] = { id, role, agent, model, skill, gate }` and `edges[] = { from, to, gate }`. The
  stepper, the Routing list and the later board are views of this file; the core is the only
  parser. A pipeline runner drives a session stage by stage: it sends the stage's skill prompt
  (`/spec-design <slug>` for agents with skills, the template's text for the rest) through
  `send_prompt`, watches the stage's file, and raises a **gate**.
- **Gates** are a session event (`gate { stage, options }`) beside `permission-request`, answered by
  `respond_gate`. A session at a gate is `waiting`, the same status a permission gives it. The
  desktop shows the card over the composer; the CLI prints the options and reads one.
- **Tasks** (`tasks.md` as a live list): each task has an owner role, a state and, once started, a
  `sessionId`. Run as subagents under the chat or as workspaces, both through what the core
  already has (`subagents`, `Workspaces::place`). Usage is accumulated per role and per spec.
- **Managed files** (`.bt/tools.json`): templates, skills and subagents the pipeline installs,
  with hashes, in each agent's own format. Synced from Main into every workspace's worktree on
  install, create, open and change; a file edited in a worktree is kept and marked. Lives next to
  `Workspaces::ready`.
- **MCP** (`bt-core` `mcp`): `.mcp.json` reading and status; the merge of `mcpServers` into an agent's
  launch is already `config`'s. Adding one from a registry follows the ACP registry's pattern.
- **Routing**: the pipelines' stages with their agent and model; later the board. No new storage:
  it is the same `pipelines/*.json` drawn as a graph.

Each starts as a module of `bt-core`; it becomes a package of its own under `packages/` only
when it needs dependencies the core should not carry.

## 9. Build order

The order matters: the seams first, with the suites proving nothing changed; the move
second, as renames; the CLI third. One commit per step.

1. **Utilities home** (`util`, `Dirs`): three back-edges go (sessions → roots' path check,
   config → terminal's default shell, three `app.path()` reads).
2. **`Notifier`**: the updater's closure and the "agents changed" fan-out
   (`commands::agents::emit_changed`, which also calls `Sessions::sync_agents`) move behind the
   trait; payloads become structs. `roots` already reach out through `Host` and stay in the desktop,
   so they only call the new fan-out. The desktop's event names and JSON stay, so the frontend tests
   pass unchanged.
3. **`ProgramRunner`**: logins and `open_cli` leave the PTY module behind; the runtime's tests get
   a fake runner.
4. **`bt-core` as a crate** inside the existing workspace; the app re-exports what `commands/`
   names. Acceptance: its tests run without Tauri; no `tauri` in the crate.
5. **`api` module** and the contract snapshot test.
6. **This repository**, in two commits or more, so the moves stay plain renames for blame:
   - **Move, no renames.** `git mv` into §2, nothing else, and every check passes (§10).
   - **Rename the identifiers**, in a commit of its own.
7. **CLI, read-only and config first**: the verbs that need no cross-process work.
8. **Two processes** (§6), then `run`, `send`, `resume`, `sign-in` and the TTY renderer. New code
   from here on: this is where the desktop's behavior can first change, and §6 changes how it
   reloads its own files, so it gets its own tests.
9. **Specs and pipelines in the core**, then their desktop UI and CLI verbs; MCP and routing after.

## 10. Keeping today's features

Steps 1–6 add nothing a user can see.

### 10.1 The gate for every step

Baseline on 2026-11-05: `cargo test --lib` 377 passed and 5 ignored; `pnpm test` 1129 passed
and 1 skipped; `pnpm typecheck` and `cargo clippy --all-targets` clean.

- A step passes when all four checks pass and neither test count drops. A test moves with its code;
  it is never deleted to make a move compile.
- `cargo test --lib` becomes `cargo test --workspace`, so compare the counts by hand once at step 6.
- Through step 6 the page's contract is frozen: the 86 commands, the 8 events (`agents://changed`,
  `agents://sign-in`, `app://notice`, `github://account`, `menu://action`, `roots://changed`,
  `sessions://synced`, `workspaces://changed`) and the session event kinds (§4.3). The frontend's
  tests then prove the page sees no change, and `src/` moves without an edit until the rename.

### 10.2 Where each feature lands

| Feature | Backend lands in | Page |
| --- | --- | --- |
| Chats: ACP sessions, turns, permissions, subagents, sync, replay, prompt history | `bt-core` `session/` | moves as is |
| Workspaces: worktrees, apply, check out, delete, recreate | `bt-core` `workspace/`, `git/` | moves as is |
| Agents tab: `agents.json`, registry, trust, on/off, updates, sign-in | `bt-core` `config/`, `agents/`; the login's PTY through `ProgramRunner` | moves as is |
| An agent's CLI in a terminal | `bt-core` `session/`, through `ProgramRunner`; PTY in the desktop | moves as is |
| Terminals tab | desktop `terminal/` | moves as is |
| File tree, Quick Open, Find in Files, Search pane | desktop `roots/` | moves as is |
| Changes, commit, GitHub | desktop `git/`, `github.rs`, over the core's `git/` | moves as is |
| Editor tabs, comments, Markdown views, drops, attachments, fonts, menus, windows | desktop `commands/`, `menu.rs`, `lib.rs` | moves as is |
| Logs and snackbars | desktop `logging.rs` | moves as is; see §10.3 |

Tests can't cover everything here: at step 6, run the app on macOS, Windows and Linux and walk this
table once, a real agent included (`cargo test real_claude -- --ignored`).

### 10.3 What a move or rename can break silently

None of these fail a compile.

- **Warnings stop reaching the user.** `logging.rs`'s `OWN_TARGETS` names the app's own crate and
  `agent_acp`, and `NoticeLayer` shows only those crates' warnings. Code that moves to `bt_core`
  logs under a new target, so its failures would vanish from the snackbars and the default log level.
  Add the crate at step 4, and every later crate that logs.
- **Quick Open gets 10x slower in dev.** `[profile.dev.package."*"]` must move to the root
  `Cargo.toml`: a member's profile is ignored.
- **The resolver changes.** A virtual workspace root has no edition to imply it, so the root needs
  `resolver = "2"`.
- **Paths outside the code**: `.github/workflows/*.yml` (`working-directory`, the rust cache's
  `workspaces: src-tauri`, `release.yml`'s version check reading `src-tauri/Cargo.toml`),
  `.claude/` (hooks, the `verify` skill, the rules' `paths:`), `tauri.conf.json`,
  `.gitignore`.
- **Names that stay**: the `acp-*` elements and events (they name the protocol, not the product),
  `@symblight/*`, the agent crates.

## 11. Open decisions

- **Frontend package root**: pnpm lives in `apps/desktop/`; a root `package.json` with a pnpm
  workspace only once a JS package appears under `packages/`.
- **`Dirs::standard()` without Tauri**: `directories` must give the same folders Tauri does on
  macOS, Linux and Windows; the comparison test decides, and a mismatch is fixed with a hand-written
  resolver, never by moving files.
- **Session ids in the CLI**: a unique prefix of the app's ids, like a commit hash, or a short
  alias column.
- **A socket to the running desktop** (§6) stays out until files prove insufficient.
