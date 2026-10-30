#!/usr/bin/env bash
# PreToolUse (Edit|Write|NotebookEdit): lock files and dependency patches change only through their tools.
f=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')

case "$f" in
  */pnpm-lock.yaml | */Cargo.lock)
    echo "Blocked: $(basename "$f") is generated. Change dependencies with pnpm / cargo instead." >&2
    exit 2 ;;
  */patches/*.patch)
    echo "Blocked: dependency patches are made with 'pnpm patch' + 'pnpm patch-commit', not edited by hand." >&2
    exit 2 ;;
esac
exit 0
