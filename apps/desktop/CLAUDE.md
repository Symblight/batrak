# CLAUDE.md — apps/desktop

The desktop app: `src-tauri/` (package `batrak-desktop`, the Tauri commands, the window, the
editor side and the PTY terminals, over `batrak-core`) and `src/` (the Lit UI). The root
`CLAUDE.md` holds the commands, the backend conventions, tests-first, working mode and commits;
this file holds what is specific to the frontend. Paths below are relative to this folder.

Frontend is **JavaScript with JSDoc types** — no `.ts` sources (only `src/env.d.ts`,
`src/elements.d.ts`). Type-checking via `jsconfig.json` (`checkJs`, `strict`). UI is Lit web
components; the Rust backend is reached through the `ipc` bridge (`src/hooks/ipc/ipc.js`, the only
module that imports `@tauri-apps/*`); each feature's Rust commands live in its hook.

- `src/views/` — the container elements: `<acp-app>` and the four columns. A view has no CSS: it extends
  `ViewElement` (light DOM: it renders into itself, `display: contents`, so `renderRoot` is the element and
  its tests use `el.querySelector`, not `el.shadowRoot`) and composes components, with layout from `<acp-panel>`,
  `<acp-pane>` and `<acp-split>` (the app's row of columns is `<acp-column-split>`); inline `style` only for values JS knows (resized widths).
- `src/components/` — every other custom element, one flat folder each (see "File structure" below).
- `src/stores/` — global state as nanostores atoms, one file per domain (see "Global state" below).
- `src/hooks/<feature>/` — one frozen object per feature (`projects`, `sessions`, `git`, …) holding its rules,
  its backend calls and the actions that call them, with private part files (spec: `docs/specs/frontend-structure.md`).
- `src/controllers/<feature>/` — Lit `ReactiveController`s (`PascalCaseController.js`), one folder per
  feature, never colocated with the component that first uses them. One `config` object typed by a
  `@typedef`.
- `src/hooks/<feature>/types.js` — the feature's JSDoc typedefs; they mirror `batrak_core::api`'s types.
- `src/styles/tokens.css` — global app tokens, imported once from `src/main.js`.

Third-party elements: `@symblight/wc-material` (`md-*`), `@symblight/code-editor` (`cdx-*`),
`@symblight/tree-view` (`tvx-*`), `@symblight/chat` (`chx-*`).

### Layers

- **Data layer** (infrastructure): `src/stores/` (nanostores atoms and their actions) and
  `src/hooks/` (backend calls, actions that write stores), plus every browser API that holds or
  fetches state outside the page: `localStorage` / `sessionStorage` (only in `stores/`, through
  `persistent.js`), `history` / `location`, `fetch`, the clipboard, `matchMedia`, and
  `@tauri-apps/*` (only in `hooks/ipc/ipc.js`). Nothing above it talks to these directly.
- **Container components** — `<acp-app>`, `<acp-toolbar-view>`, the columns and the views under
  them (every element in `src/views/`) — are the only components that import from `stores/`. They
  subscribe (`StoreController`), call actions and hooks, and pass data down as properties, through
  their children to the leaves.
- **Every other component is presentational:** data in through properties, intents out as `acp-*`
  events that the column handles (they bubble, composed). No imports from `stores/`, no
  `StoreController`, no storage, network or clipboard APIs; a hook's pure rules may be called, its
  actions never (they go out as events). Where an answer belongs to one request, the container
  calls the child back; a lazy loader is a property; a query is an event answered by a property.
- **Dialogs are rendered only by views.** A component that needs an answer fires an intent and its
  view asks, or takes the view's dialog as a lazy property when it must await the answer.
- A controller counts as part of its host. Data controllers (they read stores or call services)
  are hosted only by a container; pure controllers go anywhere. Shared pure helpers are rules of a
  hook, not of a store module.

### Global state

[nanostores](https://github.com/nanostores/nanostores) atoms in `src/stores/`, named `$camelCase`.

- **State → store, streams → events.** Anything a component renders or another component needs lives in a
  store. One-off happenings stay events: DOM `acp-*` events for UI intents, and
  `projects.onFsChange()` for watcher batches. Don't mirror a store into a reactive property or
  re-announce it with an event.
- **Actions live next to their store** or, when they call the backend, in a hook that writes the
  store. Container components call actions; nobody `set()`s stores other modules own.
- **Narrow with `computed`** and subscribe to the narrowest store you need.
- **Container components subscribe with `StoreController`** (`src/controllers/store/`); outside a
  component, or for a one-off read in a handler, use `$store.get()`.
- **Persistence:** `persistentStore(key, initial, { parse, serialize?, listen? })`
  (`stores/persistent/persistent.js`) keeps an atom as JSON in `localStorage` under a `batrak:` key.
  `listen: false` for per-window state; leave it on for shared preferences so all windows stay in
  sync. Per-window state keyed by something uses `persistentMapStore(prefix, parse)`: written only
  through `setKey()`, never `set()`.

### Subsystem notes

Detailed notes per subsystem live in `.claude/rules/` at the repo root. Each loads on its own when
you read or edit the files in its `paths:`; read it directly when a task depends on a subsystem
without touching its files. Specs are in `docs/specs/`.

### Logging and notices

The frontend logs through `app.log(level, message)` (`hooks/app/app.js`, the `write_log` command);
`main.js` calls `app.init()` for uncaught errors, unhandled rejections and the backend's own
notices. `<acp-snackbars>` shows `$notices` (`stores/notices/notices.js`: `notify(level, message)`).
A failed action with no inline error goes through `app.reportError(what, err)`.

## Frontend tests

`@web/test-runner` (`web-test-runner.config.mjs`, real Chrome, mocha + chai) runs every
`src/**/*.test.js`. Every entity has a folder of its own, with its tests in a `__tests__/` folder
inside it, named after it (`components/x/__tests__/x.test.js`, `hooks/projects/__tests__/rules.test.js`).
Keep logic in plain functions (`stores/`, `hooks/`) and test it directly; test a component through its
properties, events and rendered shadow DOM with `fixture()` from `test/fixture.js`.

**Writing, extending or slimming a frontend test suite: use the `lit-test-suite` skill**: a feature
map first, one test per user-visible behavior (table-driven for variants, not one per property or
key), Arrange-Act-Assert with comments, black-box only, one test written and run at a time, and a
falsifiability check. The root `CLAUDE.md` wins where they differ: the runner is mocha + chai with
`fixture()` from `test/fixture.js` (not `@open-wc/testing`), tests sit in `__tests__/` folders, a
test is added only for behavior no existing test covers, and the Styles rule applies. Name the
skill in the brief of any subagent that writes tests.

## Code conventions

- Private class members use native `#field` / `#method()` / `get #x()`, never `_field`. Declare and
  initialise private fields in the class body, JSDoc on the declaration, handlers as arrow-function
  fields; don't assign them in the constructor. Lit reactive properties keep public names.

### JSDoc

Every JS file is fully typed in JSDoc and checked by `pnpm typecheck` (`checkJs` + `strict`;
`maxNodeModuleJsDepth: 0` keeps tsc out of libraries' shipped JS).

- Each custom element class: `@tag` and a one-line `@summary`, plus `@fires <event> <detail>` for
  every event it dispatches. No prose paragraphs.
- Every function/method with parameters gets `@param` types; a one-line description when the name
  doesn't say it all. Lifecycle methods need no comment beyond types.
- Shared shapes are `@typedef`s in the owning feature's `src/hooks/<feature>/types.js`.
- No `any`. `src/elements.d.ts` maps every `acp-*` tag in `HTMLElementTagNameMap`; register each new
  element there. Cast an event once at the top of a handler.

## Styling conventions

- **CSS lives in a `.css` file next to its component**, imported with `?inline` and assigned directly
  (`static styles = styles;`; `scripts/lit-css-loader.cjs` turns the import into a Lit `CSSResult`).
  Never write `css\`…\`` blocks inside component JS.
- SVG icons (`@material-design-icons/svg`) are imported with `?raw` and rendered via `unsafeSVG()`,
  inside `<md-icon>`; size with `font-size` on a class.
- **Hints are `md-tooltip`, never a `title` attribute** (`<md-tooltip for=${id} show-delay="800">`,
  a sibling of its anchor; rows with ids through keyed `repeat()`). Tests read it with `tooltipOf(el)`.
- **Shared shadow styles:** `src/styles/shadow.css` is the first stylesheet of every shadow root,
  the libraries' included. It is the one place tag selectors are allowed (scrollbars, menu density).
- Colors come from the app tokens in `src/styles/tokens.css` (`--acp-color-*`) and spacing from
  `--acp-space-*`. No raw hex. Scales (type, icons, spacing, corners, state layers, elevation,
  stacking) live in `tokens.css`; a one-off optical value stays a literal.
- **Dark-only CSS keys on `:root[data-theme='dark']`**, never on `prefers-color-scheme`.
- **Derived colors use `color-mix()`** over the tokens, not a new token or an `rgba()` copy.
- **Layout that depends on available space uses container queries**, not `@media` on the viewport.
- **Use native CSS nesting** (`&`) for a node's states and its `@container` / `@media` rules.

### BEM

Shadow DOM already scopes styles; BEM is kept for readability, flat predictable specificity, and
consistency with the `@symblight` libraries. Skills `bem-css` and `bem-lit-blocks` hold the full
rules; load them when writing or reviewing component CSS or structure.

- **Block = the custom element** (`:host`). Classes are named after the tag: `acp-tab-view__tab`.
- **Element** = a node in the component's own `render()`: `block__element`, flat.
- **Modifier** = `block__element_modifier` / `block_modifier` with a **single** underscore, never
  `--modifier`. Host state is a reflected attribute styled as `:host([attr])`.
- A **nested custom element is its own block**; to place or size it, mix a parent element class
  onto it. A block sets no external geometry.
- **No** tag selectors, `*`, `#id`, descendant combinators between entities, resets, or `!important`.
- Component custom properties are namespaced `--acp-<component>-*` (public) /
  `--_acp-<component>-*` (internal); never reuse a token's name.

### File structure

Only `src/views/`, `src/components/`, `src/controllers/`, `src/stores/` and `src/hooks/` hold
folders. Each folder directly under them is one entity and holds its JS and CSS under the tag name
without the `acp-` prefix (`<acp-tab-view>` is `components/tab-view/tab-view.js`) and its tests in
`__tests__/`, and no other folder. No category grouping and no sub-components inside an element's
folder. Elements import each other as `'../x/x.js'`; hooks and stores are one folder per module too.
The `new-component` skill scaffolds one.
