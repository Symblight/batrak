# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev             # Vite dev server (port 1420)
pnpm build           # Build to dist/
pnpm tauri dev       # Run the desktop app (Tauri, src-tauri/)
pnpm typecheck       # tsc over the JSDoc types (no emit); must stay clean
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
  state (folder, tabs); leave it on for shared preferences (column widths, later theme) so all windows
  stay in sync through `storage` events. Per-window state keyed by something (tabs by project) uses
  `persistentMapStore(prefix, parse)` instead: one item per key, written only through `setKey()`, so two
  windows never overwrite each other's other entries — never `set()` it.
- Persisted today: `$columnWidths` (`brama:layout:column-widths`), `$workspace` (`brama:workspace`, reopened
  on launch by `projectController.restore()`), `$projectTabs` (`brama:editor:tabs:<project path>`; the
  active project's entry is `$editorTabs`, which shows only files inside it),
  `$projects` (`brama:projects`, shared; every opened folder is added, `projectController.remove()` drops it
  from the app only) and `$collapsedProjects` (`brama:projects:collapsed`). Typedefs for each are in
  `src/models/types.js`.

### Column resizing

`ColumnResizeController` (`src/controllers/resize/`) + `<acp-resize-handle>`, built on Pragmatic drag and
drop (`@atlaskit/pragmatic-drag-and-drop`).

- The handle is the draggable; it fires `acp-resize-start` / `acp-resize` / `acp-resize-end` (drag),
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
- **Shadow DOM patch:** Pragmatic's element adapter looks draggables up by `event.target` at `document`,
  which is retargeted to `<acp-app>` for anything in a shadow root. `patches/@atlaskit__pragmatic-drag-and-drop@4.0.0.patch`
  (pnpm `patchedDependencies`) makes it search `event.composedPath()`. Re-create it when upgrading the
  package (`pnpm patch @atlaskit/pragmatic-drag-and-drop`); without it no drag ever starts.
- **Tauri `dragDropEnabled: false`** (window in `src-tauri/tauri.conf.json`) is required: with Tauri's
  native file-drop handler on, wry swallows `draggingUpdated`, so the page gets no `dragover` while the
  button is held and the column only jumps on release. Need native file drops later? Handle them as
  HTML5 `drop` events in the page instead of re-enabling it.

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
  `import styles from './acp-toolbar.css?inline';` → `static styles = styles;`. `rollup-plugin-postcss-lit`
  (`vite.config.js`) turns the import into a Lit `CSSResult`; `src/env.d.ts` types `*.css?inline` as
  `CSSResultGroup` (it deliberately doesn't reference `vite/client`, whose `*?inline` → `string`
  declaration would win). Never write `css\`…\`` blocks inside component JS.
- SVG icons (`@material-design-icons/svg`) are imported with `?raw` and rendered via `unsafeSVG()`,
  inside `<md-icon>` — size it with `font-size` on a class, don't style `svg` directly.
- Colors come from the app tokens in `src/styles/tokens.css` (`--md-surface`, `--md-on-surface-variant`,
  `--md-primary`, …, mapped from wc-material's `--md-sys-color-*`) and spacing from `--space-*`. No raw hex.

### BEM

Shadow DOM already scopes styles; BEM is kept for **readability, flat predictable specificity, and
consistency** with the `@symblight` libraries. Skills `bem-css` (selectors, nesting, custom properties)
and `bem-lit-blocks` (block/element/modifier decisions, file structure) in `.claude/skills/` hold the
full rules — load them when writing or reviewing component CSS or structure.

- **Block = the custom element** (the host, `:host`). Classes are named after the tag:
  `acp-code-editor`, `acp-code-editor__tab`, `acp-code-editor__close-icon`.
- **Element** = a node in the component's own `render()`: `block__element`. Flat — no element-of-element
  (`a__b__c` means you found a new block).
- **Modifier** = `block__element_modifier` / `block_modifier` with a **single** underscore
  (`acp-editor-column__side_with-code`, `acp-quick-open__item_selected`) — never `--modifier`. Host
  state/variant is a reflected attribute styled as `:host([attr])`. Content/data attributes are not modifiers.
- A **nested custom element is its own block**, never the parent's element. To place or size it, mix a
  parent element class onto it (`<md-icon class="acp-code-editor__close-icon">`,
  `<acp-file-tree class="acp-editor-column__pane">`). A block sets no external geometry (margins, position).
- **No** tag selectors, `*`, `#id`, descendant combinators between entities, resets, or `!important`.
  Outer-tree rules already beat a child's `:host` rules, so a parent hides a child with
  `.parent__pane[hidden] { display: none; }` — no `!important`.
- **Native CSS nesting** only via `&`, for one node's own states: `&:hover`, `&::placeholder`,
  `&[active]`. Write BEM names in full (`&__x` does not concatenate). Bare nesting (`.a { .b {} }`)
  creates a descendant combinator — don't. The `safari15` build target down-compiles nesting.
- Component custom properties are namespaced `--acp-<component>-*` (public) / `--_acp-<component>-*`
  (internal). Theme third-party elements through their own documented properties
  (`--tvx-tree-view-*`, `--cdx-status-bar-*`, `--md-tab-*`).

### File structure

Flex scheme: `src/components/` is a flat list of block folders, each holding the element's JS and CSS
under the tag name:

```
src/components/
├── acp-code-editor/
│   ├── acp-code-editor.js
│   └── acp-code-editor.css
└── acp-toolbar/
    ├── acp-toolbar.js
    └── acp-toolbar.css
```

No category grouping. Components import each other as `'../acp-x/acp-x.js'` and services as
`'../../services/x.js'`.
