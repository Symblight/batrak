# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev             # Rsbuild dev server (port 1420; full reload, no HMR)
pnpm build           # Build to dist/
pnpm tauri dev       # Run the desktop app (Tauri, src-tauri/)
pnpm typecheck       # tsc over the JSDoc types (no emit); must stay clean
pnpm test            # frontend tests: @web/test-runner in Chrome; must pass
cd src-tauri && cargo test --lib      # backend tests; must pass
cd src-tauri && cargo clippy --all-targets   # no warnings
cd src-tauri && cargo test --lib real_claude -- --ignored --nocapture   # real Claude Code over ACP (network, login)
cd src-tauri && cargo test --lib real_registry -- --ignored   # the real ACP registry and its ETag (network)
cd src-tauri && cargo test --lib real_npm -- --ignored        # a real `npm cache add` prefetch (network, npm)
```

## Architecture

`src-tauri/` is a Cargo workspace: the app, plus one crate per agent kind under `src-tauri/crates/`
(`agent-api`'s `Agent` trait, `agent-generic`, …; spec: `docs/specs/agent-plugins.md`), all default
members, so the commands above check every crate. Agent-specific behavior goes in its crate, never in
the app.

Frontend is **JavaScript with JSDoc types** — no `.ts` sources (only `src/env.d.ts`). Type-checking via
`jsconfig.json` (`checkJs`, `strict`). UI is Lit web components; the Rust backend lives in `src-tauri/`
and is reached through the `ipc` bridge (`src/hooks/ipc/ipc.js`); each feature's Rust commands live in its hook.

- `src/views/` — the container elements: `<acp-app>` and the four columns. A view has no CSS: it extends
  `ViewElement` (light DOM: it renders into itself, `display: contents`, so `renderRoot` is the element and
  its tests use `el.querySelector`, not `el.shadowRoot`) and composes components, with layout from `<acp-panel>`,
  `<acp-pane>` and `<acp-split>` (the app's row of columns is `<acp-column-split>`); inline `style` only for values JS knows (resized widths).
- `src/components/` — every other custom element, one flat folder each (see "File structure" below). The
  Settings, Agents, Search and Changes elements are here until their views exist (see
  `docs/specs/frontend-structure.md`).
- `src/stores/` — global state as nanostores atoms, one file per domain (see "Global state" below).
- `src/hooks/<feature>/` — one frozen object per feature (`projects`, `sessions`, `git`, …) holding its rules,
  its backend calls and the actions that call them, with private part files (spec: `docs/specs/frontend-structure.md`).
- `src/controllers/<feature>/` — Lit `ReactiveController`s (`PascalCaseController.js`), one folder per
  feature, never colocated with the component that first uses them. One `config` object typed by a
  `@typedef`.
- `src/hooks/<feature>/types.js` — the feature's JSDoc typedefs (what its hook, stores and components share).
- `src/styles/tokens.css` — global app tokens, imported once from `src/main.js`.

Third-party elements: `@symblight/wc-material` (`md-*`), `@symblight/code-editor` (`cdx-*`),
`@symblight/tree-view` (`tvx-*`), `@symblight/chat` (`chx-*`).

### Layers

- **Data layer** (infrastructure): `src/stores/` (nanostores atoms and their actions) and
  `src/hooks/` (backend calls, actions that write stores), plus every browser API that holds or
  fetches state outside the page: `localStorage` / `sessionStorage` (only in `stores/`, through
  `persistent.js`), `history` / `location`, `fetch`, the clipboard, `matchMedia`, and
  `@tauri-apps/*` (only in `hooks/ipc/ipc.js`). Nothing above it talks to these directly.
- **Container components** — `<acp-app>`, the columns (`<acp-session-column>`,
  `<acp-agent-column>`, `<acp-main-column>`, `<acp-file-column>`) and the views under them (every element in
  `src/views/`: `<acp-settings-view>`, `<acp-files-view>`, …) — are the only components that import
  from `stores/`. They subscribe (`StoreController`), call actions and hooks, and pass
  data down as properties, through their children to the leaves (`<acp-chat>` hands the composer's
  pickers theirs, `<acp-tab-view>` the Settings, Agents and Changes tabs theirs).
- **Every other component is presentational:** data in through properties, intents out as `acp-*`
  events that the column handles (they bubble, composed, through the components in between). No
  imports from `stores/`, no `StoreController`, no storage, network or clipboard APIs; a hook's pure
  rules may be called, its actions never (they go out as events).
  A child that needs data gets a property; one that must change data fires an event. Where an answer
  belongs to one request, the container calls the child back (`<acp-changes-panel>`'s
  `commitFinished()`, `fillAmendMessage()`; `saveFinished()` of `<acp-agent-form>` and `<acp-agents-view>`); a lazy loader is a property (`<acp-file-tree>`'s
  `listDir`); a query is an event answered by a property (`acp-quick-open-query` → `files`,
  `acp-chat-file-query` → `fileOptions`, `acp-search` → `results`, `acp-agents-query` → `view`).
- A controller counts as part of its host. The data controllers (they read stores or call services)
  are hosted only by a container: `ChatSessionController`, `ChatPartsController` (`<acp-chat-view>`),
  `TabFilesController` (open tabs' files: reads, baselines, drafts, kept in memory while another
  project is shown, saves; a save over a file
  changed on disk since its draft started, `changedOnDisk`, is refused until the tab view's
  Overwrite / Reload dialog answers; a text file deleted on disk stays shown, `deletedOnDisk`, and
  a save creates it again, like VS Code) and `ChangesReviewController`
  (the Changes tab's expanded files and diffs; `<acp-changes-tab>`), `SessionChangesController` (a
  worktree session's Changes tab; `<acp-session-changes-tab>`), `FindInFilesController` (`<acp-search-pane>`, for the
  Search pane, and `<acp-search-view>`, for the search dialog; one backend slot each).
  The others are pure and go anywhere: `EditorCommentsController` takes the host's `comments` /
  `commentFocus` and fires `acp-comment-add` / `-edit` / `-delete` / `-revealed`,
  `SelectionActionsController` fires `acp-chat-add`; `FloatingController`, `SortableController`, `TreeNavigationController` (the roving Tab stop and WAI-ARIA keys of a tree whose rows are elements: session list, Changes review),
  `ContextMenuController`, `TabContentController`. Shared pure helpers are rules of a hook
  (`composer.configOf()`), not of a store module.

### Global state

[nanostores](https://github.com/nanostores/nanostores) atoms in `src/stores/`, named `$camelCase`.

- **State → store, streams → events.** Anything a component renders or another component needs lives in a
  store. One-off happenings stay events: DOM `acp-*` events for UI intents (`acp-file-open`), and
  `projects.onFsChange()` for watcher batches. Don't mirror a store into a reactive property or
  re-announce it with an event.
- **Actions live next to their store** (`openTab()` / `closeTab()` in `stores/editor/editor.js`) or, when they
  call the backend, in a service that writes the store (`projects.open()` / `restore()` (`hooks/projects/`) →
  `$workspace`). Container components call actions (see "Layers"); nobody `set()`s stores other modules own.
- **Narrow with `computed`.** `$rootId` (from `$workspace`) and `$activePath` (from `$editorTabs`) notify
  only when their slice changes, so subscribe to the narrowest store you need.
- **Container components subscribe with `StoreController`** (`src/controllers/store/`):
  `#workspace = new StoreController(this, { store: $workspace })`, read `this.#workspace.value` in
  `render()`. It re-renders the host on change; `onChange(value, oldValue)` runs a side effect (also once
  on connect). Outside a component, or for a one-off read in a handler, use `$store.get()`.
- **Persistence:** `persistentStore(key, initial, { parse, serialize?, listen? })` (`stores/persistent/persistent.js`)
  keeps an atom as JSON in `localStorage` under a `brama:` key. `parse` validates what was stored (`null`
  → `initial`), `serialize` drops runtime-only fields (`Workspace.rootId`). `listen: false` for per-window
  state (folder, tabs); leave it on for shared preferences (column widths, settings) so all windows
  stay in sync through `storage` events. Per-window state keyed by something (tabs by project) uses
  `persistentMapStore(prefix, parse)` instead: one item per key, written only through `setKey()`, so two
  windows never overwrite each other's other entries — never `set()` it.

### Subsystem notes

Detailed notes per subsystem live in `.claude/rules/`. Each loads on its own when you read or edit
the files in its `paths:`; read it directly when a task depends on a subsystem without touching its
files. Specs are in `docs/specs/`.

- `persisted-state.md` — what's persisted and under which key, tab ids and view tabs, `TabContentController`.
- `sessions.md` — session stores and the `sessions` hook, the backend runtime (sync, turn slots,
  worktrees, remove), ACP host, the adapter, session folders, config options, history.
- `agent-config.md` — `.brama/agents.json`, the Agents tab, writing the file, on/off, the ACP registry,
  updates, following the list, secrets and trust, signing in.
- `editor-comments.md` — agent comments and the selection toolbar.
- `search.md` — the search dialog and the Search pane: slots, shared blocks, folder and mask filters,
  persistence.
- `terminals.md`, `git.md` (commit, worktree / apply, frontend stores, cached state),
  `drag-drop.md`, `column-resize.md`.

### Background work

Commands are `async` and push disk/process work to `spawn_blocking`; nothing blocks the IPC thread.
Work that can be superseded must be cancellable, not just have its result dropped: Quick Open and
Find in Files check a flag, and a project scan (`Snapshot::scan_until`) stops when a newer
`open_workspace` from the same window starts (it then fails with `workspace::SUPERSEDED`, which
`projects` ignores) or when its root closes. The editor reads only the active tab; other
tabs are read, or re-read after a change on disk or a HEAD move, when they become active.

**Open projects:** the `projects` hook keeps the backend roots (snapshot + watcher) of the last
`KEEP_OPEN` (3) active projects; activating one of them only switches `$workspace`, no scan. Older
ones are closed and scanned again when activated. Only the active root's changes reach the frontend
(`fs-change`); the others' watchers keep their snapshots and git caches current, and views keyed by
root (the `git` hook's stores and commit picks, the Changes tab's expanded files, the file tree's
expanded folders) save their state on switch and restore it, re-checking what may have changed. A
root belongs to the window that opened it: `Workspaces::close_group` closes a window's roots when it
is destroyed, and `close_window_workspaces` when its page loads again (before any open).

### Logging

`tracing` everywhere in Rust (`tracing::info!` / `warn!` / `debug!`, never `println!`), set up in
`src-tauri/src/logging.rs`: daily files `brama.<date>.log` in the app log dir (macOS:
`~/Library/Logs/dev.brama.app`, last 7 kept), plus stderr in dev builds. Default level is
`brama_lib=debug` in dev, `brama_lib=info` in release (and the same for the agent crates that log,
`agent_acp`: `OWN_TARGETS` in `logging.rs`, where a new logging crate goes too); `BRAMA_LOG` overrides it (an `EnvFilter`
directive). The panic hook logs every panic, from any thread, with a backtrace. The frontend logs through
`app.log(level, message)` (`hooks/app/app.js`, `write_log` command, target `frontend`); `main.js`
calls `app.init()` for uncaught errors, unhandled rejections and the backend's own notices. Log at `info` for
what a user did or what took noticeable time (a scan), `warn` for failures, and `debug` for every
git call; never log file contents.

**Snackbars:** `<acp-snackbars>` (bottom-end, in `<acp-app>`) shows `$notices` (`stores/notices/notices.js`:
`notify(level, message)`, the same message counts up instead of stacking, at most 4, info 5s / warn
8s / errors until dismissed, held while hovered). A `tracing` layer (`NoticeLayer` in `logging.rs`)
sends every warn/error of ours (`brama_lib`, `agent_acp`) and panic to all windows as `app://notice`, whatever `BRAMA_LOG`
says — so a `warn!` is user-visible: use it for real failures only. In the frontend, a failed action
with no inline error goes through `app.reportError(what, err)` (`hooks/app/app.js`: logs + snackbar);
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

## Tests first

Work test-driven: before changing behavior, write a test that fails for the missing or broken
behavior, see it fail, then make it pass, then clean up with the tests green. A bug fix starts with a
test that reproduces it.

- **Styles:** a change that is only CSS (a component's `.css`, `shadow.css`, `tokens.css`) gets no
  test, and no test asserts computed styles or custom properties, unless I allow it for that change.

- **Backend:** tests live next to the code (`#[cfg(test)] mod tests`, or `<module>/tests.rs` when
  long). Agent behavior is tested against the in-process fake agent (`crates/agent-acp/src/fake_agent.rs`, the `test-support` feature; extend
  its scripts rather than mocking `Connection`), files against temp folders, git against
  `git/test_repo.rs`. Test what a caller sees (events, statuses, files on disk), not internals.
- **Frontend:** `@web/test-runner` (`web-test-runner.config.mjs`, real Chrome, mocha + chai) runs
  every `src/**/*.test.js`. Every entity has a folder of its own, with its tests in a `__tests__/` folder inside it, named
  after it (`components/x/__tests__/x.test.js`, `hooks/projects/__tests__/rules.test.js`). Keep logic in plain functions
  (`stores/`, `hooks/`) and test it directly; test a component through its
  properties, events and rendered shadow DOM with `fixture()` from `test/fixture.js`.
- **Writing, extending or slimming a frontend test suite: use the `lit-test-suite` skill**
  (`/lit-test-suite`): a feature map first, one test per user-visible behavior (table-driven for
  variants, not one per property or key), Arrange-Act-Assert with comments, black-box only, one test
  written and run at a time, and a falsifiability check (break the guarded line, see it fail). This
  file wins where they differ: the runner is mocha + chai with `fixture()` from `test/fixture.js`
  (not `@open-wc/testing`), tests sit in `__tests__/` folders, a test is added only for behavior no
  existing test covers, and the Styles rule above applies. Name the skill in the brief of any
  subagent that writes tests.
- Before reporting work done: `cargo test --lib`, `cargo clippy --all-targets`, `pnpm typecheck` and
  `pnpm test` pass. Say which behavior was verified by a test, which by running the app, and which not at all.

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
- Shared shapes are `@typedef`s in the owning feature's `src/hooks/<feature>/types.js`, imported with
  `/** @typedef {import('../../hooks/<feature>/types.js').X} X */`.
- No `any`. `src/elements.d.ts` maps every `acp-*` tag in `HTMLElementTagNameMap` (the `@symblight`
  libraries ship their own), so `querySelector('acp-x')` is typed — register each new element there.
  Cast an event once at the top of a handler: `/** @type {CustomEvent<{ path: string }>} */ (e).detail`.
- Keep comments minimal otherwise — comment only what isn't obvious from the code (a non-obvious
  constraint, a workaround, a gotcha).

## Styling conventions

- **CSS lives in a `.css` file next to its component**, imported with `?inline` and assigned directly:
  `import styles from './toolbar.css?inline';` → `static styles = styles;`. `scripts/lit-css-loader.cjs`
  (wired in `rsbuild.config.js`) turns the import into a Lit `CSSResult`; `src/env.d.ts` types `*.css?inline` as
  `CSSResultGroup` (it deliberately doesn't reference `@rsbuild/core/types`, whose `*?inline` → `string`
  declaration would win). Never write `css\`…\`` blocks inside component JS.
- SVG icons (`@material-design-icons/svg`) are imported with `?raw` and rendered via `unsafeSVG()`,
  inside `<md-icon>` — size it with `font-size` on a class, don't style `svg` directly.
- **Hints are `md-tooltip`, never a `title` attribute.** Give the anchor an `id` unique in the shadow
  root and render `<md-tooltip for=${id} show-delay="800">…</md-tooltip>` beside it (a sibling, not
  inside a row whose text is read). The tooltip finds its anchor only when it connects, so render
  rows with ids through keyed `repeat()`. Among slotted children give the tooltip a slot too (a
  banner's `actions`; `trailing` in an `md-menu-item`, whose default slot is its typeahead label). Don't anchor one on a row that holds buttons with their
  own tooltips: put it on the row's text instead. A long path gets
  `style="width: max-content; max-inline-size: none"`. Tests read it with `tooltipOf(el)` from
  `test/fixture.js` and check `[title]` is gone.
- **Shared shadow styles:** `src/styles/shadow.css` is the first stylesheet of every shadow root,
  the libraries' included (`src/styles/shadow-styles.js` hooks Lit's `finalizeStyles`; imported
  first in `main.js`). It holds what must match app-wide: thin scrollbars and menu density
  (`md-menu` / `md-menu-item` row height and padding; type sizes stay the library's). It's the one
  place tag selectors are allowed, because it must reach menus inside third-party shadow roots. A
  component sets only what differs (e.g. a menu's `--md-menu-min-width`), never menu density.
- Colors come from the app tokens in `src/styles/tokens.css` (`--acp-color-surface`, `--acp-color-on-surface-variant`,
  `--acp-color-primary`, …, mapped from wc-material's `--md-sys-color-*`) and spacing from `--acp-space-*`. No raw hex.
- **Scales live in `tokens.css`; no literals for them in components:** type (`--acp-font-size-xs/sm/md/lg`,
  `--acp-font-weight-medium`), icons (`--acp-icon-size-xs…lg`, set as `font-size` on the icon's class), spacing
  (`--acp-space-0-5…4`), corners (`--acp-shape-corner-extra-small/small/medium/full`), state layers
  (`--acp-state-hover/focus/pressed/disabled`), elevation (`--acp-elevation-*`), stacking (`--acp-z-*`), column limits
  and `md-button` vertical padding (`--acp-button-block-space-compact/regular`). A one-off optical value stays
  a literal; add a token once a second place needs it. Prefer logical properties (`margin-inline-start`,
  `inset-block-end`, `text-align: start`).
- **Dark-only CSS keys on `:root[data-theme='dark']`**, never on `prefers-color-scheme`: Appearance
  (`$settings`, applied by `settings.syncTheme()`, `hooks/settings/settings.js`) can override the OS.
- **Derived colors use `color-mix()`** over those tokens (hover/pressed tints, translucent fills,
  borders: `color-mix(in srgb, var(--acp-color-primary) 12%, transparent)`), not a new token or an `rgba()`
  copy of one, so they follow the theme and accent.
- **Layout that depends on available space uses container queries** (`container-type: inline-size` on
  the host or a wrapper, `@container (width < …)`), not `@media` on the viewport: columns are resized
  and hidden, so a component's width isn't the window's. Name the container
  (`container-name: acp-<component>`) when a rule must target a specific one.
- **Use native CSS nesting** (`&`) for a node's states and its `@container` / `@media` rules, kept
  inside the selector they change (rules in "BEM" below).

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
  `&[active]`, `@container (…) { … }`. Write BEM names in full (`&__x` does not concatenate). Bare nesting (`.a { .b {} }`)
  creates a descendant combinator — don't. The `safari >= 18.2` build target (Tauri's WebKit on current macOS; no older fallbacks) keeps nesting, `@scope` and `scrollbar-color` native.
- App tokens in `tokens.css` are `--acp-<name>` (`--acp-space-2`, `--acp-color-primary`), so a component's public property must not reuse a token's name.
- Component custom properties are namespaced `--acp-<component>-*` (public) / `--_acp-<component>-*`
  (internal). Theme third-party elements through their own documented properties
  (`--tvx-tree-view-*`, `--cdx-status-bar-*`, `--md-tab-*`).

### File structure

Only `src/views/`, `src/components/`, `src/controllers/`, `src/stores/` (and the models and services still being
moved out) hold folders. Each folder directly under them is one entity (an element, a controller, a module)
and holds its JS and CSS under the tag name without the `acp-` prefix (`<acp-tab-view>` is
`components/tab-view/tab-view.js`) and its tests in `__tests__/`, and no other folder:

```
src/components/
├── tab-view/
│   ├── tab-view.js
│   ├── tab-view.css
│   └── __tests__/
│       └── tab-view.test.js
└── toolbar/
    ├── toolbar.js
    ├── toolbar.css
    └── __tests__/
        └── toolbar.test.js
```

A view (`src/views/agent-column/agent-column.js`) is laid out the same way. The element's tests live in a
`__tests__/` folder inside its own folder, not in a global tree. No category grouping and no sub-components inside an
element's folder: a part with a tag of its own is a component in `src/components/`. Elements import each other as
`'../x/x.js'` (a view imports `'../../components/x/x.js'`); hooks and stores are one folder per
module as well (`'../../hooks/x/x.js'`, tests in `hooks/x/__tests__/`).
