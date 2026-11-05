# packages

What the apps share. A package never depends on an app, and never names a window, a tab, a PTY, a
TTY or a DOM node.

- `batrak-core/` — agents, sessions, workspaces, the project's `.bt/`, and the traits the apps
  implement (`ARCHITECTURE.md` §3–§5)
- `agent-api/` — the `Agent` trait and the types every agent crate shares; no I/O
- `agent-acp/` — the generic ACP driver and the in-process fake agent for tests
- `agent-kit/` — what several agent crates share: npx launches, pinning, downloads
- `agent-claude/`, `agent-codex/`, `agent-copilot/`, `agent-antigravity/`, `agent-generic/` — one
  crate per agent kind (spec: `docs/specs/agent-plugins.md`)

A new feature starts as a module of `batrak-core` and becomes a package of its own only when it
needs dependencies the core should not carry.
