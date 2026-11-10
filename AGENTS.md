# AGENTS.md

Working rules for every coding agent in this repository. `ARCHITECTURE.md` says how the pieces fit
and where new code goes; read it before a change that adds a module or crosses a crate.
`apps/desktop/AGENTS.md` adds the frontend's rules; it applies under `apps/desktop/`, and the rules
here still apply there.

## What this is

Batrak is an agent-first client for AI coding agents over ACP (Agent Client Protocol). One library,
`bt-core` (`packages/bt-core`), holds agents, sessions, workspaces, config and a project's `.bt/`
folder. Two fronts render it: the desktop app (Tauri + Lit, `apps/desktop`) and the CLI (`batrak`,
`apps/cli`).

Specs are in `docs/specs/`, one per feature (`docs/specs/README.md` says how one is written). The
whole `docs/` folder is git-ignored ("specs stay local"), so a fresh clone has none of them. Check
that a spec file exists before you cite it, and don't try to commit one.

## Commands

Cargo runs from the repo root, pnpm from `apps/desktop`. Rust stable; Node (CI uses the LTS) with
the pnpm version in `apps/desktop/package.json` (`packageManager`).

The four checks that must pass before a task is reported done:

```bash
cargo test --workspace                        # every crate's tests
cargo clippy --all-targets -- -D warnings     # no warnings: CI fails on any
cd apps/desktop && pnpm typecheck             # tsc over the JSDoc types, no emit; must stay clean
cd apps/desktop && pnpm test                  # frontend tests in Chrome (@web/test-runner); must pass
```

Running the apps:

```bash
cargo run -p batrak -- --version              # the CLI (a stub until docs/specs/cli.md)
cd apps/desktop
pnpm install --frozen-lockfile                # what CI runs
pnpm dev                                      # Rsbuild dev server, port 1420 (full reload, no HMR)
pnpm build                                    # build to dist/
pnpm tauri dev                                # the desktop app
```

`BATRAK_HOME=<folder>` points both apps at another app-data root; use it to try things without
touching real data.

These tests need the network or a login. Don't run them unless the user asks:

```bash
cargo test -p bt-core real_claude -- --ignored --nocapture   # real Claude Code over ACP (login)
cargo test -p bt-core real_registry -- --ignored             # the ACP registry and its ETag
cargo test -p bt-core real_npm -- --ignored                  # a real `npm cache add` prefetch
cargo test -p bt-core real_release -- --ignored              # the published batrak-cli.json parses
cargo test -p agent-acp --test real_tool_calls codex -- --ignored --nocapture  # re-record an agent's tool calls (claude, codex, copilot; login)
```

Gotchas that the commands above don't show:

- `tauri::generate_context!` embeds `apps/desktop/dist/` at compile time, tests included. CI runs
  `pnpm build` in `apps/desktop` before its cargo steps; do the same on a fresh checkout.
- Some `@symblight/*` packages are git dependencies pinned over SSH in `pnpm-lock.yaml`. If
  `pnpm install` asks for an SSH key, make git fetch them over HTTPS the way
  `.github/actions/setup/action.yml` does (`url."https://github.com/".insteadOf` for
  `git@github.com:`, `ssh://git@github.com/` and `https://git@github.com/`).
- `pnpm test` drives the installed Chrome (`channel: 'chrome'` in `apps/desktop/web-test-runner.config.mjs`).
- CI runs the desktop's Rust tests on macOS, the CLI's on Windows and the frontend on Ubuntu. Say
  which platform a change was verified on.

## Layout

```
apps/desktop/          the Tauri app: src-tauri/ (bt_desktop: commands, window, editor, PTY terminals) and src/ (the Lit UI)
apps/cli/              the `batrak` binary
packages/bt-core/      the library both apps use: sessions, workspaces, agents, config, the project's .bt/
packages/agent-*/      the Agent trait (agent-api), the ACP driver (agent-acp), shared npx mechanics (agent-kit), one crate per agent kind
docs/specs/            one spec per feature (local only, see above)
.claude/rules/         per-subsystem notes (see "Subsystem notes")
```

`packages/` never depends on `apps/`. An app depends on packages, never on another app.

## Architecture rules

- **The one rule** (`ARCHITECTURE.md` §1): the core knows agents, sessions, workspaces and `.bt/`; a
  front knows its surface. Anything a second front would re-implement goes in `bt-core`. Anything
  that names a window, a tab, a PTY, a TTY or a DOM node goes in an app. No `tauri`, `clap` or
  terminal crate in a package.
- **Agent-specific behavior goes in that agent's crate** (`packages/agent-*`, behind
  `agent_api::Agent`; spec `docs/specs/agent-plugins.md`), never in the core or an app. The core asks
  the hub (`agents::AgentHub`) and never names an agent.
- **The core calls out only through its traits** (`Notifier`, `EventSink`, `Launcher`,
  `SecretStore`, `ProgramRunner`; `ARCHITECTURE.md` §4). `Dirs` is a struct (§4.1). The core answers
  the user's questions as events with options plus a method for the answer. Never a blocking
  question, never a UI concept.
- **The contract is `bt_core::api`** (`packages/bt-core/src/api.rs`): the serde types both fronts
  render. Add fields with `#[serde(default)]`; never rename one.

## Backend conventions (Rust)

- Commands are `async`, and disk or process work goes to `spawn_blocking`; nothing blocks the IPC
  thread. Work that can be superseded is cancellable (a flag), not just dropped.
- `tracing` everywhere. `info!` for what a user did or what took noticeable time; `warn!` for real
  failures only, since the desktop shows them as snackbars; `debug!` for every git call. Never
  `println!`, `eprintln!` or `dbg!`, and never file contents. A crate that logs is listed in the
  desktop's `apps/desktop/src-tauri/src/logging.rs` `OWN_TARGETS`, or its warnings never reach the
  user.
- Git is the `git` CLI only, through `git::exec::run` / `run_with` (`Mode::Background` for refreshes
  the user didn't ask for). Anything that changes a repository runs inside
  `git::lock::with_mutation`. Root-relative paths go through `checked_rel()` (`bt-core` `util.rs`)
  first.
- Every path an agent gives is confined to its session's folder: no `..`, no symlink out, nothing in
  `.git`. Writes are atomic.
- Cross-platform: macOS, Windows and Linux. Unix-only code sits behind `cfg(unix)` with a Windows
  path beside it.
- No `unwrap()`, `expect()`, or indexing that can panic on user input or I/O. Errors carry context.
  Clippy stays warning-free; no `#[allow]` to silence something real.

## Tests first

Work test-driven. Before changing behavior, write a test that fails for the missing or broken
behavior, see it fail, make it pass, then clean up with the tests green. A bug fix starts with a test
that reproduces it.

- **Styles:** a change that is only CSS gets no test. No test asserts computed styles or custom
  properties unless the user allows it for that change.
- **Backend:** tests live next to the code (`#[cfg(test)] mod tests`, or `<module>/tests.rs` when
  long; `session/runtime/tests/` is the split example). Agent behavior is tested against the
  in-process fake agent (`packages/agent-acp/src/fake_agent.rs`, the `test-support` feature). Extend
  its scripts rather than mocking `Connection`. Files are tested against temp folders, and git
  against `bt-core`'s `git/test_repo.rs` (`test-support`). The core's traits have recording fakes.
  Test what a caller sees (events, statuses, files on disk), not internals.
- **Frontend:** see `apps/desktop/AGENTS.md`.
- A test is added only for behavior no existing test covers. Test counts never drop to make
  something compile: a test moves with its code.
- A test file is 500 lines at most. Past that, split it by concern (`<module>/tests/<concern>.rs`,
  shared helpers in `tests/mod.rs`).
- Before a task is reported done, the four checks pass. Say which behavior a test verified, which
  you verified by running the app, and which you did not verify at all.

## Git and commits

- **Commit only after the user says yes.** When a task is done and the checks pass, don't commit.
  Ask, showing the files the task touches and the proposed message: imperative, sentence case, no
  trailing period, like `Run agent sessions over ACP`. Add a body only when the why isn't obvious.
- **Stage only the task's files, by path.** Never `git add -A` or `git add .`; the working tree may
  hold other people's uncommitted changes, and those stay out of your commit. Check `git status`
  before you start and leave changes that aren't yours alone.
- **Don't push** unless the user asks.
- **No git worktrees** (`git worktree add` is blocked). Work in the user's checkout.
- The project's hooks in `.claude/hooks/` enforce the git rules (`git add -A` / `.`, `git worktree
  add`, `git push` asks).

## Code conventions

- Prefer the smallest change that works. No caps, options or subsystems unless a real failure needs
  them.
- Comments say what isn't obvious from the code: a constraint, a workaround, a gotcha. Nothing else.
- Generated files change only through their tools: `Cargo.lock` through cargo, `pnpm-lock.yaml`
  through pnpm. Dependency patches go through `pnpm patch` and `pnpm patch-commit`, never by hand in
  a `patches/*.patch` file. `.claude/hooks/guard-files.sh` blocks the hand edits.
- Frontend sources are JavaScript with JSDoc types; there are no `.ts` sources (only the `.d.ts`
  files in `apps/desktop/src/`). Details in `apps/desktop/AGENTS.md`.
- `.claude/hooks/lint-edit.sh` refuses an edit that adds `println!`, `eprintln!` or `dbg!` to Rust
  (tests exempt); `!important`, a raw hex color (outside `tokens.css`) or a `--modifier` BEM class to
  CSS; a `title=` attribute, `this._field`, or a `css` template literal to JS. Write them right the
  first time.

## Subsystem notes

`.claude/rules/*.md` hold the notes for one subsystem each: sessions, git, terminals, agent config,
search, persisted state, drag and drop, column resizing, editor comments. Each file's `paths:` front
matter lists the files it covers. Read the one for the files you change; the notes are plain
Markdown and apply to every agent.
