#!/usr/bin/env bash
# PreToolUse (Edit|Write): refuse text that breaks a mechanical CLAUDE.md rule. Only the text being
# written is checked (Edit's new_string, Write's content), so old violations never block an edit.
#   Rust   : println! / eprintln! / dbg!  (use tracing; bench.rs and tests.rs are exempt)
#   CSS    : !important, raw hex colors (tokens.css is exempt), BEM `--modifier` class names
#   JS     : title= attribute (md-tooltip), this._field (native #field), css`` blocks (.css files),
#            stores/ or StoreController in a presentational component (src/components/)
# Test: .claude/hooks/lint-edit.test.sh
input=$(cat)
f=$(jq -r '.tool_input.file_path // ""' <<<"$input")
text=$(jq -r '.tool_input.new_string // .tool_input.content // ""' <<<"$input")

problems=()
has() { grep -Eq -- "$1" <<<"$text"; }
add() { problems+=("$1"); }

case "$f" in
  */bench.rs | */tests.rs | */tests/*) ;;
  *.rs)
    has '\b(e?println|dbg)!' && add "Rust: no println!/eprintln!/dbg!; log with tracing (info!/warn!/debug!)." ;;
esac

case "$f" in
  */styles/tokens.css) ;;
  *.css)
    has '!important' && add "CSS: no !important; outer-tree rules already beat :host rules (use [hidden] on the parent's class)."
    has '#[0-9a-fA-F]{3,8}\b' && add "CSS: no raw hex colors; use --acp-color-* tokens (color-mix() for tints)."
    has '\.acp-[a-z0-9_-]*--[a-z]' && add "CSS: BEM modifiers use a single underscore (block__element_modifier), never --modifier." ;;
esac

case "$f" in
  */__tests__/*) ;;
  *.js)
    has '(^|[^.[:alnum:]_/-])css`' && add "JS: no css\`\` blocks; put styles in a .css file next to the component and import it with ?inline."
    has '[[:space:]]title=' && add "JS: no title attribute; use <md-tooltip for=id show-delay=\"800\">."
    has 'this\._[a-zA-Z]' && add "JS: private members are native #field / #method(), not _field."
    if [[ $f == */src/components/* ]]; then
      has "from '[^']*/stores/|StoreController" && add "Layers: a component under src/components/ is presentational (properties in, acp-* events out). Only views (src/views/) import stores/ or use StoreController." 
    fi ;;
esac

if ((${#problems[@]})); then
  {
    echo "Blocked: $(basename "$f") breaks CLAUDE.md rules:"
    printf ' - %s\n' "${problems[@]}"
  } >&2
  exit 2
fi
exit 0
