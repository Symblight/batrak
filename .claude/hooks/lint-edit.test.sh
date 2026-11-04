#!/usr/bin/env bash
# Table-driven check of lint-edit.sh: each case is "expected exit | tool | path | new text".
# Run: .claude/hooks/lint-edit.test.sh
hook="$(dirname "$0")/lint-edit.sh"
fail=0

check() { # expected tool path text
  local want=$1 tool=$2 path=$3 text=$4 key=new_string
  [[ $tool == Write ]] && key=content
  jq -n --arg t "$tool" --arg p "$path" --arg x "$text" --arg k "$key" \
    '{tool_name: $t, tool_input: ({file_path: $p} + {($k): $x})}' | "$hook" >/dev/null 2>&1
  local got=$?
  if [[ $got != "$want" ]]; then
    echo "FAIL: want exit $want, got $got: $tool $path <<< $text"
    fail=1
  fi
}

# Rust
check 2 Edit  /r/src-tauri/src/foo.rs       'println!("x");'
check 2 Write /r/src-tauri/src/foo.rs       'fn f() { dbg!(1); }'
check 0 Edit  /r/src-tauri/src/foo.rs       'tracing::info!("x");'
check 0 Edit  /r/src-tauri/src/roots/bench.rs 'println!("x");'
check 0 Edit  /r/src-tauri/src/session/runtime/tests.rs 'eprintln!("x");'
# CSS
check 2 Edit  /r/src/components/a/a.css     'a { display: none !important; }'
check 2 Edit  /r/src/components/a/a.css     'a { color: #fff; }'
check 2 Edit  /r/src/components/a/a.css     '.acp-a__b--big { color: red; }'
check 0 Edit  /r/src/styles/tokens.css      ':root { --x: #fff; } a { display: none !important; }'
check 0 Edit  /r/src/components/a/a.css     'a { color: var(--acp-color-primary); } .acp-a__b_big { x: y }'
# JS
check 2 Edit  /r/src/components/a/a.js      'html`<button title="x"></button>`'
check 2 Edit  /r/src/components/a/a.js      'this._size = null;'
check 2 Edit  /r/src/components/a/a.js      'static styles = css`:host {}`;'
check 2 Edit  /r/src/components/a/a.js      "import { \$x } from '../../stores/x/x.js';"
check 2 Edit  /r/src/components/a/a.js      "import { StoreController } from '../../controllers/store/StoreController.js';"
check 0 Edit  /r/src/views/a/a.js           "import { \$x } from '../../stores/x/x.js';"
check 0 Edit  /r/src/components/a/a.js      '/** See `tokens.css`. */ this.#size = null;'
check 0 Edit  /r/src/components/a/__tests__/a.test.js "expect(el.title).to.equal(''); import '../../stores/x/x.js'; this._x"
# Not ours
check 0 Edit  /r/docs/specs/a.md            'println!("x"); title="x"'
check 0 Edit  /r/src/components/a/a.js      'html`<md-tooltip for="a">x</md-tooltip>`'

exit $fail
