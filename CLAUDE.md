# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev             # Rsbuild dev server (port 1420; full reload, no HMR)
pnpm build           # Build to dist/
pnpm tauri dev       # Run the desktop app (Tauri, src-tauri/)
pnpm typecheck       # tsc over the JSDoc types (no emit); must stay clean
cd src-tauri && cargo test --lib      # backend tests; must pass
cd src-tauri && cargo clippy --all-targets   # no warnings
cd src-tauri && cargo test --lib real_claude -- --ignored --nocapture   # real Claude Code over ACP (network, login)
```

## Architecture

Frontend is **JavaScript with JSDoc types** — no `.ts` sources (only `src/env.d.ts`). Type-checking via
`jsconfig.json` (`checkJs`, `strict`). UI is Lit web components; the Rust backend lives in `src-tauri/`
and is reached through `src/services/ipc.js`.

- `src/components/` — one folder per custom element (see "File structure" below).
- `src/stores/` — global state as nanostores atoms, one file per domain (see "Global state" below).
- `src/services/` — actions and IPC (`project-controller.js`, `session-controller.js`, `ipc.js`, `theme.js`).
- `src/controllers/<feature>/` — Lit `ReactiveController`s (`PascalCaseController.js`), one folder per
  feature, never colocated with the component that first uses them. One `config` object typed by a
  `@typedef`.
- `src/models/types.js` — shared JSDoc typedefs.
- `src/styles/tokens.css` — global app tokens, imported once from `src/main.js`.

Third-party elements: `@symblight/wc-material` (`md-*`), `@symblight/code-editor` (`cdx-*`),
`@symblight/tree-view` (`tvx-*`), `@symblight/chat` (`chx-*`).

### Global state

[nanostores](https://github.com/nanostores/nanostores) atoms in `src/stores/`, named `$camelCase`.

- **State → store, streams → events.** Anything a component renders or another component needs lives in a
  store. One-off happenings stay events: DOM `acp-*` events for UI intents (`acp-file-open`), and
  `projectController`'s `fs-change` for watcher batches. Don't mirror a store into a reactive property or
  re-announce it with an event.
- **Actions live next to their store** (`openTab()` / `closeTab()` in `stores/editor.js`) or, when they
  call the backend, in a service that writes the store (`projectController.open()` / `restore()` →
  `$workspace`). Components call actions; they don't `set()` stores other modules own.
- **Narrow with `computed`.** `$rootId` (from `$workspace`) and `$activePath` (from `$editorTabs`) notify
  only when their slice changes, so subscribe to the narrowest store you need.
- **Components subscribe with `StoreController`** (`src/controllers/store/`):
  `#workspace = new StoreController(this, { store: $workspace })`, read `this.#workspace.value` in
  `render()`. It re-renders the host on change; `onChange(value, oldValue)` runs a side effect (also once
  on connect). Outside a component, or for a one-off read in a handler, use `$store.get()`.
- **Persistence:** `persistentStore(key, initial, { parse, serialize?, listen? })` (`stores/persistent.js`)
  keeps an atom as JSON in `localStorage` under a `brama:` key. `parse` validates what was stored (`null`
  → `initial`), `serialize` drops runtime-only fields (`Workspace.rootId`). `listen: false` for per-window
  state (folder, tabs); leave it on for shared preferences (column widths, settings) so all windows
  stay in sync through `storage` events. Per-window state keyed by something (tabs by project) uses
  `persistentMapStore(prefix, parse)` instead: one item per key, written only through `setKey()`, so two
  windows never overwrite each other's other entries — never `set()` it.
- Persisted today: `$columnWidths` (`brama:layout:column-widths`), `$hiddenColumns`
  (`brama:layout:hidden-columns`, shared; the toolbar's buttons toggle the sessions and file columns), `$workspace` (`brama:workspace`, reopened
  on launch by `projectController.restore()`), `$projectTabs` (`brama:editor:tabs:<project path>`; the
  active project's entry is `$editorTabs`, which shows only files inside it; a tab id is a file's path
  or a view's id (`SETTINGS_TAB_ID`; `CHANGES_TAB_ID`, every changed file expanding into its diff, which a
  click in the Changes side pane opens, expands and scrolls to; `TERMINAL_TAB_ID`, `BROWSER_TAB_ID`); `parseTabId()` tells them apart.
  `TabContentController` (`src/controllers/tab-content/`) picks the view for a tab's content
  (`ContentKind`: a file is `markdown` / `image` (SVG too) by extension, else `code`; a view tab by its
  kind) and renders it with the host's view for that kind; only `readsText()` tabs are read from disk.
  Markdown, image, terminal and browser views are mocks for now. Pinned tabs (`EditorTabs.pinned`) lead the strip and survive Close Others / Close Tabs to the Right / Close All. Everything in `<acp-main-column>` opens as such a
  tab. View tabs need no project: with none open, `$editorTabs` is the `''` entry, which holds only them),
  `$projectExpandedFolders` (`brama:file-tree:expanded:<project path>`, per window like the tabs; the
  active project's entry is `$expandedFolders`, root-relative folders the file tree is controlled by: it
  writes the user's expand/collapse there and expands stored folders as their parents load),
  `$projects` (`brama:projects`, shared; every opened folder is added, `projectController.remove()` drops it
  from the app only), `$collapsedProjects` (`brama:projects:collapsed`) and `$settings` (`brama:settings`,
  shared: appearance and accent, which `services/theme.js` turns into the MD3 palette and `data-theme` on
  `<html>`, and the code editor's font; key dark-only CSS on `:root[data-theme='dark']`, never on
  `prefers-color-scheme`, since Appearance can override the OS). Typedefs for each are in
  `src/models/types.js`.

**Sessions:** `stores/sessions.js` holds `$sessions` (listed), `$draftSessions` (id → project id: a
"New session" with no message yet, not listed) and `$activeSessionId`, which is also the chat's
conversation id; `$activeSession` is `null` for a draft. `sessionController` keeps the active session in
the opened project (`showProject()`: the project's last shown session, its newest, or a new draft),
`create()`s drafts and `start()`s one on its first message. The composer's state is per session
(`$composer` is the active session's entry). One `<chx-chat>` holds every session as a conversation
(messages cached per id, a hidden session's reply keeps streaming), bound by `ChatSessionController`
(`src/controllers/chat-session/`): `activeConversationId`, the draft's first send (put back into
the composer when the backend refuses the session), and each session's unsent composer text and files.
Statuses come from the backend's session events. A draft shows only the composer, centered; the message
list appears with the first message. Replies come over ACP (see "Agents over ACP"); messages live only
in the chat element, and an agent with `session/load` replays them when it starts again.

**Agent comments:** line comments typed in any `cdx-code-editor` live in `$comments` (`stores/comments.js`,
by absolute path, in memory). Every editor's `<cdx-comments>` is controlled through
`EditorCommentsController` (`src/controllers/comments/`): `.comments=${this.#comments.threadsOf(path)}`,
and its submit / edit / delete events become store actions, so one file shown twice (a tab and the
Changes tab) stays in sync. `<acp-comment-bar>` (over `<acp-main-column>`) steps through
`$tabComments` (the active tab's file, or every changed file in Changes) by setting `$commentFocus`: the main column shows the file,
the visible editor of it reveals the thread. Send to agent (`sendToChat()`) clears the comments from the code and hands them to the chat
(`addToChat()`, `stores/chat.js`); `<acp-chat>` takes `$chatInserts` into its composer: a comment as its
own line (file chip `path:line` or `path:from-to`, then the text), a selection as a chip at the caret.
`SelectionActionsController` (`src/controllers/selection-actions/`) shows `<acp-selection-actions>`
(Add to chat / Comment) under the caret of a settled selection in the host's own editors: a manual
`popover` toolbar (top layer), placed by `FloatingController` (`src/controllers/floating/`, Floating UI
`computePosition` + `autoUpdate` against a virtual caret element), so it follows scrolling and hides
while the caret is out of view. Alt+F10 focuses it, arrows move between actions, Escape closes it,
and it closes when focus leaves both it and the editor (focus inside it returns to the editor). Editor
events are composed, so a host also hears its children's editors (the tab view hears the Changes
review's): controllers act only on `editorOf(event, renderRoot)` (`models/editor-events.js`).

### Agents over ACP

- **Config** (`src-tauri/src/config/`): opening a project creates `.brama/` (`agents.json`,
  `workspace.json`, `.gitignore` with `local/`), never overwriting. Agents merge by id: built-in
  (`claude` → `npx -y @agentclientprotocol/claude-agent-acp`) < `<config dir>/brama/agents.json` <
  `.brama/agents.json` (`"disabled": true` hides one). An invalid file keeps its last valid version
  and is reported as `file:line:col`. The watcher flags `.brama/agents.json` (`Changes.config`) →
  reload → `agents://changed`; `.brama/local/` is never in the snapshot. `env` values take
  `${env:NAME}` (login-shell env) and `${keychain:name}` (service `brama`), resolved only at spawn:
  secrets never reach logs, IPC or files. The project's file is the repository's, so it can't make
  the app run anything on its own: an agent whose `command` / `args` / `env` it sets, or any start
  while it lists `mcpServers`, needs the user's trust in that exact `LaunchConfig` for that project
  (`agents_trust`, kept in `<app data>/trusted-agents.json`; a changed launch needs trust again).
  Untrusted, a start fails with an `untrusted` event (the banner's Trust and start) and a probe
  is refused. `${keychain:…}` works only in the user's file, and agents can't write `agents.json`.
- **Sessions** (`src-tauri/src/session/`): `Sessions` owns every session (`sessions.json` in app
  data; all `stopped` after a restart). The agent starts on the first message; at most one active
  `local` session per project. Mode logic sits behind `SessionEnv` (`session/env/`, `local` only);
  every agent path goes through `to_host_path` + `confine` (no `..`, no symlink out, nothing in
  `.git`); writes are atomic. `HOOK(git)` comments in `run_turn` mark the checkpoint points.
  `Sessions::remove` (session row menu → Remove session) stops the agent, unlists the session,
  deletes `sessions/<id>/` (transcript, log) and calls `SessionEnv::discard` (a no-op for `local`).
- **ACP host** (`src-tauri/src/acp/`): the only module using `agent-client-protocol` (pinned). One
  process per session in its own process group (stopped as a group; `process::stop_all` on app
  exit), stderr → `<app data>/sessions/<id>/agent.log`. Dispatch-loop callbacks never wait:
  permission responders are parked until the user answers. Tests run `acp/fake_agent.rs`
  in-process; `real_claude_agent_end_to_end` (ignored) runs the real agent.
- **Frontend**: each session's events come over a Tauri channel (`{ sessionId, seq, kind, payload }`,
  `update` = raw ACP `SessionUpdate`) into `handleSessionEvent` (`services/acp-adapter.js`), which
  maps updates to `<chx-chat>` chunks (text, `thought`, `tool_call`, `plan`) in the turn's stream,
  or replays them through `subscribe` outside a turn (`session/load`). Permission requests and
  notices live in `stores/session-runtime.js`, shown by `<acp-session-banner>`; `$agentList`
  (`services/agent-config.js`) feeds the agent picker. The agent's text renders as Markdown in
  `<acp-markdown>` (marked + DOMPurify, fences in `<chx-code-block>`, links via `open_url`).
- **Config options** (model, thought level, mode): the agent's own, from `session/new` / `session/load`,
  `config_option_update` and every `session/set_config_option` answer, reach the page as
  `config-options` events (an agent with only legacy `modes` gets a stand-in `mode` option set
  through `session/set_mode`). `applyAgentOptions()` (`stores/composer.js`) replaces the session's
  options and caches them per agent (`brama:agents:config-options`), so a new session shows the real
  models before it starts. An agent with nothing cached is probed once per launch
  (`agents_probe_options` → `Sessions::probe_options`: started in `<app data>/probe`, `initialize` +
  `session/new`, no prompt, stopped). A pick goes through `sessionController.setConfigOption()`: shown at once,
  sent if the agent runs, else kept in `ComposerState.chosen` and sent when it starts.
- **History**: each session's conversation is appended to `sessions/<id>/transcript.jsonl` (prompts,
  the turn's updates, turn ends; not `usage_update`, not a `session/load` replay); `session_history`
  returns it and `restoreHistory()` rebuilds the chat the first time a session is shown after a
  reload. Context usage comes from `usage_update` (`setUsage()`).

### Background work

Commands are `async` and push disk/process work to `spawn_blocking`; nothing blocks the IPC thread.
Work that can be superseded must be cancellable, not just have its result dropped: Quick Open and
Find in Files check a flag, and a project scan (`Snapshot::scan_until`) stops when a newer
`open_workspace` from the same window starts (it then fails with `workspace::SUPERSEDED`, which
`projectController` ignores) or when its root closes. The editor reads only the active tab; other
tabs are read, or re-read after a change on disk or a HEAD move, when they become active.

**Open projects:** `projectController` keeps the backend roots (snapshot + watcher) of the last
`KEEP_OPEN` (3) active projects; activating one of them only switches `$workspace`, no scan. Older
ones are closed and scanned again when activated. Only the active root's changes reach the frontend
(`fs-change`); the others' watchers keep their snapshots and git caches current, and views keyed by
root (`gitController`'s stores and commit picks, the Changes tab's expanded files, the file tree's
expanded folders) save their state on switch and restore it, re-checking what may have changed. A
root belongs to the window that opened it: `Workspaces::close_group` closes a window's roots when it
is destroyed, and `close_window_workspaces` when its page loads again (before any open).

### Logging

`tracing` everywhere in Rust (`tracing::info!` / `warn!` / `debug!`, never `println!`), set up in
`src-tauri/src/logging.rs`: daily files `brama.<date>.log` in the app log dir (macOS:
`~/Library/Logs/dev.brama.app`, last 7 kept), plus stderr in dev builds. Default level is
`brama_lib=debug` in dev, `brama_lib=info` in release; `BRAMA_LOG` overrides it (an `EnvFilter`
directive). The panic hook logs every panic, from any thread, with a backtrace. The frontend logs through
`services/logger.js` (`log(level, message)`, `write_log` command, target `frontend`); `main.js`
calls `logUncaughtErrors()` for uncaught errors and unhandled rejections. Log at `info` for
what a user did or what took noticeable time (a scan), `warn` for failures, and `debug` for every
git call; never log file contents.

**Snackbars:** `<acp-snackbars>` (bottom-end, in `<acp-app>`) shows `$notices` (`stores/notices.js`:
`notify(level, message)`, the same message counts up instead of stacking, at most 4, info 5s / warn
8s / errors until dismissed, held while hovered). A `tracing` layer (`NoticeLayer` in `logging.rs`)
sends every `brama_lib` warn/error and panic to all windows as `app://notice`, whatever `BRAMA_LOG`
says — so a `warn!` is user-visible: use it for real failures only. In the frontend, a failed action
with no inline error goes through `reportError(what, err)` (`services/notices.js`: logs + snackbar);
uncaught errors and rejections show one too.

### Git

`src-tauri/src/git/` drives the `git` CLI (never libgit2), so the user's hooks, LFS and credential
helpers apply.

- Every call goes through `exec::run` / `run_with`: closed stdin, pipes drained on threads, a
  timeout, capped output, scrubbed `GIT_DIR`-style variables, `LC_ALL=C`. Use `Mode::Background`
  for refreshes the user didn't ask for (sets `GIT_OPTIONAL_LOCKS=0`, so they never take
  `index.lock`). The executable comes from `binary::git()`. At most 4 git processes run app-wide
  (`exec::MAX_CONCURRENT`); more callers wait for a slot.
- Anything that changes a repository runs inside `lock::with_mutation`, keyed by the common git
  dir, so a checkout and its worktrees are serialized together.
- Commands take root-relative paths only after `workspace::checked_rel()`.
- Commit (`git/commit.rs`, `git_commit`): the files picked in Changes go in as they are in the
  working tree (`commit --only`, untracked ones staged first and unstaged again if it fails, both
  sides of a rename); whatever else is staged stays staged and out. Amend with no files rewords
  only. During a merge, cherry-pick or revert (no partial commits) the picks are staged and the
  whole index committed. Paths go through stdin (`--pathspec-from-file`, `update-index --stdin`),
  never argv; never pass an empty pathspec file (git then commits the whole index). Hooks and
  filters run under `Mode::Hooks`: 10 min timeout, own process group, stopped with SIGTERM first
  so git removes `index.lock`. The tail of their output is the snackbar's error; it isn't logged.
- `worktree` and `apply` (Apply Locally / Check Out Branch) are tested but not exposed yet; sessions
  use them. A dirty worktree is never removed.
- Frontend: `gitController` (`services/git-controller.js`) writes `stores/git.js` for the active root.
  `$gitRepo` (branch, upstream; `git_head`, no file scan) is kept current while a project is open:
  root change, `fs-change` with `git: true`, window focus. `$gitChanges` (changed files; `git_status`
  scans the working tree) is computed **only on demand**: `gitController.watchChanges()` starts it and
  keeps it fresh on every `fs-change` until the returned stop function runs — `<acp-changes-panel>`
  watches while it is the active side pane, `<acp-changes-review>` while its tab is active. Stopping
  keeps the files in the store; the spinner shows only for a root's first status. The files picked
  for the next commit are `$commitSelection` (root-relative paths), shared by both. Changes are files
  only: `git status --untracked-files=all` lists new folders file by file. `$gitHead` changes only when HEAD moves; the editor
  reloads its diff baselines on it.
- **Cached git state** (`git/cache.rs`, one `GitCache` per `Root`): `git_head` / `git_status` reuse the
  last answer while the root's change epoch (bumped by the watcher after every batch that changed
  something) and a fingerprint of the repository files (mtime/size of `HEAD`, `index`, the HEAD ref,
  the upstream ref, `packed-refs`, `config`, `FETCH_HEAD`, `info/exclude` — covers a git dir outside the
  root) are
  unchanged. `git_status` takes the caller's `since` version and replies `unchanged` without the
  files; the frontend then keeps the same `files` array, so views neither rebuild nor re-read diffs.
  Refresh passes `force`. Changes inside ignored folders don't bump the epoch.

### Drag and drop

Reordering uses Pragmatic drag and drop through `SortableController` (`src/controllers/sortable/`):
`new SortableController(this, { selector, getId, axis, container, group?, onReorder })` registers the
items `selector` matches in the host's render root after every render; a drag over `container` reorders.
While dragging, the host hides the dragged item (`dragging`) and translates each item by `offsetOf(id)`,
animated only while dragging, so the others slide aside and open the slot it would land in; the slot
comes from the pointer against the items' midpoints measured when the drag starts (live rects move
mid-slide and make the slot flicker), corrected for the container's scroll since. Tabs use it (`moveTab()`; `group` keeps
pinned tabs among pinned). The library reads
`event.target` at `document` and uses `closest()`, which shadow DOM stops at the outermost host, so
it is patched (`patches/@atlaskit__pragmatic-drag-and-drop@4.0.0.patch`: draggables and drop targets
are found on the composed path, lookups continue through shadow hosts, and the element under the
pointer is looked up inside shadow roots). `container` auto-scrolls along `axis` near its edges
(`-auto-scroll`, patched the same way). Re-check both patches when upgrading.

### Column resizing

`ColumnResizeController` (`src/controllers/resize/`) + `<acp-resize-handle>`, dragged with pointer events
and pointer capture — no drag-and-drop library (Pragmatic drag and drop reads `event.target` at
`document`, which shadow DOM retargets to the outermost host, so it never finds a handle in a shadow root).

- The handle fires `acp-resize-start` / `acp-resize` / `acp-resize-end` (drag),
  `acp-resize-step` (arrow keys) and `acp-resize-reset` (double-click), detail `{ name, delta }`, with
  `delta > 0` always meaning "wider" (`edge="start"` flips the pointer direction).
- A host owns its columns: `new ColumnResizeController(this, { store: $columnWidths, columns: { name: {
  property, min, max } } })`. It handles events whose `name` it knows (and stops them) and writes the
  width to the CSS custom property on the host; a drag stays local until it ends, then lands in the store
  (reset removes the key). Column names are keys of the shared store, so they're unique app-wide. The
  default width is that property's value from `tokens.css` — don't repeat it in JS. Bind
  `controller.column(name)` onto the handle's `value`/`min`/`max`.
- The parent places the handle with a mix class (`z-index: 1; margin-inline: -4px`); the handle draws
  the divider line, so adjacent columns have no border on that side.
- A press becomes a drag after 3px of travel, so a click or the double-click reset stores nothing.
- A drag only moves width between the two columns beside the handle (splitter): on `-start` / `-step`
  the handle measures both rendered widths and the neighbor's CSS `min-width` (`ResizeMeasure`), and the
  change stops where either side hits its limit. A neighbor that's a resizable column too is its
  `partner` (`session` → `agent`) and gets the opposite width; otherwise it's a flex column that takes
  the slack itself.
- **Tauri `dragDropEnabled: false`** (window in `src-tauri/tauri.conf.json`): resizing no longer needs it,
  but any HTML5 drag-and-drop in the page does — with Tauri's native file-drop handler on, wry swallows
  `draggingUpdated`, so the page gets no `dragover` while the button is held.

## Tests first

Work test-driven: before changing behavior, write a test that fails for the missing or broken
behavior, see it fail, then make it pass, then clean up with the tests green. A bug fix starts with a
test that reproduces it.

- **Backend:** tests live next to the code (`#[cfg(test)] mod tests`, or `<module>/tests.rs` when
  long). Agent behavior is tested against the in-process fake agent (`acp/fake_agent.rs`; extend
  its scripts rather than mocking `Connection`), files against temp folders, git against
  `git/test_repo.rs`. Test what a caller sees (events, statuses, files on disk), not internals.
- **Frontend:** there is no test runner yet. Keep logic that needs tests out of components, in plain
  functions (`stores/`, `models/`, `services/acp-adapter.js`), so it can get tests once a runner is
  added; until then `pnpm typecheck` and the app are the check, and say so when reporting.
- Before reporting work done: `cargo test --lib`, `cargo clippy --all-targets` and `pnpm typecheck`
  pass. Say which behavior was verified by a test, which by running the app, and which not at all.

## Commits

One commit per small task. When a task is done and the checks above pass, don't stop at the report:
ask me whether to commit it, showing the files it touches and the proposed message (imperative,
sentence case, no trailing period, like `Run agent sessions over ACP`; a body only when the why isn't
obvious). Commit only after I say yes, only that task's files, never `git add -A` over unrelated
changes. Don't push unless asked.

## Code conventions

- Private class members use native `#field` / `#method()` / `get #x()`, never the `_field` naming
  convention. Declare and initialise private fields in the class body, JSDoc on the declaration
  (`/** @type {number | null} */ #pendingLine = null;`, handlers as arrow-function fields); don't
  assign them in the constructor. Lit reactive properties (`static properties`) keep public names and
  are typed where the constructor initialises them.

### JSDoc

Every JS file is fully typed in JSDoc and checked by `pnpm typecheck` (`checkJs` + `strict`;
`maxNodeModuleJsDepth: 0` keeps tsc out of libraries' shipped JS).

- Each custom element class: `@tag` and a one-line `@summary`, plus `@fires <event> <detail>` for
  every event it dispatches. No prose paragraphs.
- Every function/method with parameters gets `@param` types; add a one-line description when the
  name doesn't say it all. Lifecycle methods (`constructor`, `connectedCallback`, `render`,
  `willUpdate`…) need no comment beyond types.
- Shared shapes are `@typedef`s in `src/models/types.js`, imported with
  `/** @typedef {import('../../models/types.js').X} X */`.
- No `any`. `src/elements.d.ts` maps every `acp-*` tag in `HTMLElementTagNameMap` (the `@symblight`
  libraries ship their own), so `querySelector('acp-x')` is typed — register each new element there.
  Cast an event once at the top of a handler: `/** @type {CustomEvent<{ path: string }>} */ (e).detail`.
- Keep comments minimal otherwise — comment only what isn't obvious from the code (a non-obvious
  constraint, a workaround, a gotcha).

## Styling conventions

- **CSS lives in a `.css` file next to its component**, imported with `?inline` and assigned directly:
  `import styles from './acp-toolbar.css?inline';` → `static styles = styles;`. `scripts/lit-css-loader.cjs`
  (wired in `rsbuild.config.js`) turns the import into a Lit `CSSResult`; `src/env.d.ts` types `*.css?inline` as
  `CSSResultGroup` (it deliberately doesn't reference `@rsbuild/core/types`, whose `*?inline` → `string`
  declaration would win). Never write `css\`…\`` blocks inside component JS.
- SVG icons (`@material-design-icons/svg`) are imported with `?raw` and rendered via `unsafeSVG()`,
  inside `<md-icon>` — size it with `font-size` on a class, don't style `svg` directly.
- **Shared shadow styles:** `src/styles/shadow.css` is the first stylesheet of every shadow root,
  the libraries' included (`src/styles/shadow-styles.js` hooks Lit's `finalizeStyles`; imported
  first in `main.js`). It holds what must match app-wide: thin scrollbars and menu density
  (`md-menu` / `md-menu-item` row height and padding; type sizes stay the library's). It's the one
  place tag selectors are allowed, because it must reach menus inside third-party shadow roots. A
  component sets only what differs (e.g. a menu's `--md-menu-min-width`), never menu density.
- Colors come from the app tokens in `src/styles/tokens.css` (`--md-surface`, `--md-on-surface-variant`,
  `--md-primary`, …, mapped from wc-material's `--md-sys-color-*`) and spacing from `--space-*`. No raw hex.

### BEM

Shadow DOM already scopes styles; BEM is kept for **readability, flat predictable specificity, and
consistency** with the `@symblight` libraries. Skills `bem-css` (selectors, nesting, custom properties)
and `bem-lit-blocks` (block/element/modifier decisions, file structure) in `.claude/skills/` hold the
full rules — load them when writing or reviewing component CSS or structure.

- **Block = the custom element** (the host, `:host`). Classes are named after the tag:
  `acp-tab-view`, `acp-tab-view__tab`, `acp-tab-view__close-icon`.
- **Element** = a node in the component's own `render()`: `block__element`. Flat — no element-of-element
  (`a__b__c` means you found a new block).
- **Modifier** = `block__element_modifier` / `block_modifier` with a **single** underscore
  (`acp-app__files_with-code`, `acp-quick-open__item_selected`) — never `--modifier`. Host
  state/variant is a reflected attribute styled as `:host([attr])`. Content/data attributes are not modifiers.
- A **nested custom element is its own block**, never the parent's element. To place or size it, mix a
  parent element class onto it (`<md-icon class="acp-tab-view__close-icon">`,
  `<acp-file-tree class="acp-file-column__pane">`). A block sets no external geometry (margins, position).
- **No** tag selectors, `*`, `#id`, descendant combinators between entities, resets, or `!important`.
  Outer-tree rules already beat a child's `:host` rules, so a parent hides a child with
  `.parent__pane[hidden] { display: none; }` — no `!important`.
- **Native CSS nesting** only via `&`, for one node's own states: `&:hover`, `&::placeholder`,
  `&[active]`. Write BEM names in full (`&__x` does not concatenate). Bare nesting (`.a { .b {} }`)
  creates a descendant combinator — don't. The `safari >= 15` build target (Lightning CSS) down-compiles nesting.
- Component custom properties are namespaced `--acp-<component>-*` (public) / `--_acp-<component>-*`
  (internal). Theme third-party elements through their own documented properties
  (`--tvx-tree-view-*`, `--cdx-status-bar-*`, `--md-tab-*`).

### File structure

Flex scheme: `src/components/` is a flat list of block folders, each holding the element's JS and CSS
under the tag name:

```
src/components/
├── acp-tab-view/
│   ├── acp-tab-view.js
│   └── acp-tab-view.css
└── acp-toolbar/
    ├── acp-toolbar.js
    └── acp-toolbar.css
```

No category grouping. Components import each other as `'../acp-x/acp-x.js'` and services as
`'../../services/x.js'`.
