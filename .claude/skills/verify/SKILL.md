---
name: verify
description: Run this project's required checks (cargo test, cargo clippy, pnpm typecheck, pnpm test) and report them the way AGENTS.md asks, ending with the commit proposal. Use when a task is done, before reporting it done, or when the user asks to verify / run the checks.
---

# Verify

AGENTS.md requires all four checks to pass before work is reported done.

## 1. Run the checks

Run the backend and frontend in parallel (separate Bash calls in one message). Cargo runs from the
repo root, pnpm from `apps/desktop`:

- `cargo test --workspace 2>&1 | tail -40`
- `cargo clippy --all-targets 2>&1 | grep -E '^(warning|error)' -A6 | head -80; echo "clippy exit: ${PIPESTATUS[0]}"`
- `cd apps/desktop && pnpm typecheck 2>&1 | tail -40`
- `cd apps/desktop && pnpm test 2>&1 | tail -60`

Clippy passes only with **no warnings**, not just exit 0. `pnpm test` runs real Chrome; a single timeout
can be flaky, so rerun once before calling it a failure, and say that you did.

Don't run the `--ignored` tests (network, login) unless the user asks.

## 2. On failure

Show the failing test names / errors with `file:line`. If the failure is in code this task touched,
fix it and rerun that check. If it's unrelated to the task (compare `git diff --stat`), say so; don't fix
it unasked.

## 3. Report

A short table: check → pass / fail (counts, e.g. `cargo test: 412 passed`). Test counts never drop
unless the task deleted a test on purpose; say so if they did.

Then, as AGENTS.md asks, say which behavior was verified:
- **by a test** (name the tests added or changed),
- **by running the app** (only if you actually did),
- **not at all**.

## 4. Commit proposal

When everything passes, don't commit. Ask, showing:
- the files this task touched (from `git status --short`; leave out unrelated changes already in the tree),
- a proposed message: imperative, sentence case, no trailing period (`Run agent sessions over ACP`),
  a body only when the why isn't obvious.

Commit only after the user says yes, adding those files by path (never `git add -A` / `.`). Don't push.
