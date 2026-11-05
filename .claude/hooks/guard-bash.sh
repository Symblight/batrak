#!/usr/bin/env bash
# PreToolUse (Bash): enforce CLAUDE.md's git rules.
#   git add -A / --all / .   → denied (stage only the task's files)
#   git worktree add         → denied (work in the user's checkout)
#   git push                 → asks (push only when the user asked)
cmd=$(jq -r '.tool_input.command // ""')

deny() {
  echo "$1" >&2
  exit 2
}

if grep -Eq '(^|[^[:alnum:]_-])git[[:space:]]+([^;&|]*[[:space:]])?add[[:space:]]+([^;&|]*[[:space:]])?(-A|--all|\.)([[:space:]]|$|[;&|])' <<<"$cmd"; then
  deny "Blocked: 'git add -A' / 'git add .' stages unrelated changes. Add only this task's files by path (CLAUDE.md, Commits)."
fi

if grep -Eq '(^|[^[:alnum:]_-])git[[:space:]]+([^;&|]*[[:space:]])?worktree[[:space:]]+add([[:space:]]|$)' <<<"$cmd"; then
  deny "Blocked: no git worktrees in this project; work in the user's checkout."
fi

if grep -Eq '(^|[^[:alnum:]_-])git[[:space:]]+([^;&|]*[[:space:]])?push([[:space:]]|$|[;&|])' <<<"$cmd"; then
  jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask",
    permissionDecisionReason: "git push: push only when the user asked for it (CLAUDE.md)."}}'
fi
exit 0
