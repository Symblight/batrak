# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Batrak is an agent-first client for AI coding agents over ACP: one core library, `batrak-core`,
and two fronts over it, a desktop app and a CLI. `ARCHITECTURE.md` says how the pieces fit and
where new code goes; read it before a change that adds a module or crosses a crate. The specs are
in `docs/specs/` (`docs/specs/README.md` says how one is written).

## Commands

Cargo runs from the repo root, pnpm from `apps/desktop`.

```bash
cargo test --workspace                   # backend tests, every crate; must pass
cargo clippy --all-targets               # no warnings
cargo run -p batrak -- --version         # the CLI (a stub until docs/specs/cli.md)
cargo test -p batrak-core real_claude -- --ignored --nocapture   # real Claude Code over ACP (network, login)
cargo test -p batrak-core real_registry -- --ignored             # the real ACP registry and its ETag (network)
cargo test -p batrak-core real_npm -- --ignored                  # a real `npm cache add` prefetch (network, npm)

cd apps/desktop
pnpm dev             # Rsbuild dev server (port 1420; full reload, no HMR)
pnpm build           # Build to dist/
pnpm tauri dev       # Run the desktop app
pnpm typecheck       # tsc over the JSDoc types (no emit); must stay clean
pnpm test            # frontend tests: @web/test-runner in Chrome; must pass
```

`BATRAK_HOME=<folder>` points both apps at another app-data root.

## Layout

```
apps/desktop/        the Tauri app: src-tauri/ (batrak_desktop: commands, window, editor, PTY terminals) and src/ (the Lit UI)
apps/cli/            the `batrak` binary
packages/batrak-core the library both apps use: sessions, workspaces, agents, config, the project's .bt/
packages/agent-*     the Agent trait (agent-api), the ACP driver (agent-acp), shared npx mechanics (agent-kit), one crate per agent kind
docs/specs/          one spec per feature
```

- **The one rule** (`ARCHITECTURE.md` §1): the core knows agents, sessions, workspaces and
  `.bt/`; a front knows its surface. Anything a second front would re-implement goes in
  `batrak-core`. Anything that names a window, a tab, a PTY, a TTY or a DOM node goes in an app.
  `packages/` never depends on `apps/`; no `tauri`, `clap` or terminal crate in a package.
- **Agent-specific behavior goes in that agent's crate** (`packages/agent-*`, behind
  `agent_api::Agent`; spec `docs/specs/agent-plugins.md`), never in the core or an app. The core
  asks the hub (`agents::AgentHub`) and never names an agent.
- **The core calls out only through its traits** (`Dirs`, `Notifier`, `EventSink`, `Launcher`,
  `SecretStore`, `ProgramRunner`; `ARCHITECTURE.md` §4) and answers the user's questions as events
  with options plus a method for the answer. Never a blocking question, never a UI concept.
- **The contract is `batrak_core::api`**: the serde types both fronts render. A change there is a
  reviewed diff of its snapshot test; fields are added with `#[serde(default)]`, never renamed.
- **The frontend's rules** (layers, stores, styling, BEM, file structure) are in
  `apps/desktop/CLAUDE.md`, read when working under that folder.

### Backend conventions

- Commands are `async` and push disk/process work to `spawn_blocking`; nothing blocks the IPC
  thread. Work that can be superseded is cancellable (a flag), not just dropped.
- `tracing` everywhere (`info!` for what a user did or what took noticeable time, `warn!` for
  real failures only, since the desktop shows them as snackbars, `debug!` for every git call;
  never `println!`, never file contents). A crate that logs is listed in the desktop's
  `logging.rs` `OWN_TARGETS`, or its warnings never reach the user.
- Git is the `git` CLI only, through `git::exec::run` / `run_with` (`Mode::Background` for
  refreshes the user didn't ask for); anything that changes a repository runs inside
  `git::lock::with_mutation`. Root-relative paths go through `checked_rel()` first.
- Every path an agent gives is confined to its session's folder (no `..`, no symlink out,
  nothing in `.git`); writes are atomic.
- Cross-platform: macOS, Windows and Linux. Unix-only code sits behind `cfg(unix)` with a Windows
  path beside it; say which platforms a change was verified on.

## Tests first

Work test-driven: before changing behavior, write a test that fails for the missing or broken
behavior, see it fail, then make it pass, then clean up with the tests green. A bug fix starts with a
test that reproduces it.

- **Styles:** a change that is only CSS gets no test, and no test asserts computed styles or
  custom properties, unless I allow it for that change.
- **Backend:** tests live next to the code (`#[cfg(test)] mod tests`, or `<module>/tests.rs` when
  long). Agent behavior is tested against the in-process fake agent
  (`packages/agent-acp/src/fake_agent.rs`, the `test-support` feature; extend its scripts rather
  than mocking `Connection`), files against temp folders, git against `batrak-core`'s
  `git/test_repo.rs` (`test-support`). The core's traits have recording fakes. Test what a caller
  sees (events, statuses, files on disk), not internals.
- **Frontend:** see `apps/desktop/CLAUDE.md`; writing or slimming a frontend suite uses the
  `lit-test-suite` skill.
- A test is added only for behavior no existing test covers. Test counts never drop to make
  something compile: a test moves with its code.
- Before reporting work done: `cargo test --workspace`, `cargo clippy --all-targets`,
  `pnpm typecheck` and `pnpm test` pass (the `verify` skill runs them). Say which behavior was
  verified by a test, which by running the app, and which not at all.

## Working mode

Invoke the `ub-mode` skill at the start of every task that changes code, and follow it. Where it
differs from this file, this file wins: commit only after I say yes and never push unless asked
(not "commit often, push at the end"), no worktrees (so no worktree cleanup), and its
`crapper` / `dryer` / `mutator` steps are skipped while those tools aren't installed.

Prefer the smallest change that works; no caps, options or subsystems unless a real failure needs
them. New UI controls use compact sizes and dense rows.

## Commits

One commit per small task. When a task is done and the checks above pass, don't stop at the report:
ask me whether to commit it, showing the files it touches and the proposed message (imperative,
sentence case, no trailing period, like `Run agent sessions over ACP`; a body only when the why isn't
obvious). Commit only after I say yes, only that task's files, never `git add -A` over unrelated
changes. Don't push unless asked.

## Code conventions

- Rust: no `unwrap()` / `expect()` / indexing that can panic on user input or I/O; errors carry
  context. Clippy warning-free (`-D warnings` in CI); no `allow` to silence something real.
- JavaScript: JSDoc-typed, no `.ts` sources, native `#private` members, no `any`; the full set is
  in `apps/desktop/CLAUDE.md`.
- Comments say what isn't obvious from the code (a constraint, a workaround, a gotcha), nothing
  else.
- Generated files (`Cargo.lock`, `pnpm-lock.yaml`) change only through their tools; dependency
  patches through `pnpm patch`. The hooks in `.claude/hooks/` enforce these and the git rules.
