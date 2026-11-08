@AGENTS.md

# CLAUDE.md

`AGENTS.md` (imported above) holds the project's instructions for every agent. This file holds
only what is specific to Claude Code.

## Working mode

Invoke the `ub-mode` skill at the start of every task that changes code, and follow it. Where it
differs from `AGENTS.md`, `AGENTS.md` wins. Its `crapper` / `dryer` / `mutator` steps are skipped
while those tools aren't installed.

## Claude Code setup

- The `verify` skill runs the four required checks and ends with the commit proposal.
- `.claude/rules/*.md` load on their own when you read or edit the files in their `paths:`.
- The `rust-reviewer` agent reviews backend changes against these rules.
- Writing or slimming a frontend test suite uses the `lit-test-suite` skill (see
  `apps/desktop/CLAUDE.md`).
- The hooks in `.claude/hooks/` enforce the git rules (`git add -A` / `.` and `git worktree add`
  blocked, `git push` asks), the generated files and patches, and the mechanical code rules
  (`lint-edit.sh`). A block from one is a rule from `AGENTS.md`, not something to work around.
