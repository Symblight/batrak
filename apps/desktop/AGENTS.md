# AGENTS.md — apps/desktop

The desktop app: `src-tauri/` (package `bt-desktop`: the Tauri commands, the window, the editor side
and the PTY terminals, over `bt-core`) and `src/` (the Lit UI). The root `AGENTS.md` applies here
too: its commands, backend conventions, tests-first rule, git and commit rules, and code conventions.
This file adds the frontend's rules. Paths below are relative to this folder.

## Stack

The frontend is **JavaScript with JSDoc types**, with no `.ts` sources (only `src/env.d.ts` and
`src/elements.d.ts`). Type-checking runs through `jsconfig.json` (`checkJs`, `strict`). The UI is Lit
web components. The Rust backend is reached through the `ipc` bridge (`src/hooks/ipc/ipc.js`, the
only module that imports `@tauri-apps/*`); each feature's Rust commands live in its hook.

Third-party elements: `@symblight/wc-material` (`md-*`), `@symblight/code-editor` (`cdx-*`),
`@symblight/tree-view` (`tvx-*`), `@symblight/chat` (`chx-*`).

## Where code goes

- `src/views/`: the container elements, `<acp-app>` and the four columns. A view has no CSS. It
  extends `ViewElement` (`src/components/view-element/`), which renders into light DOM
  (`display: contents`), so `renderRoot` is the element itself and tests use `el.querySelector`,
  not `el.shadowRoot`. A view composes components, with layout from `<acp-panel>`, `<acp-pane>` and
  `<acp-split>` (the app's row of columns is `<acp-column-split>`). Inline `style` only for values JS
  knows, such as resized widths.
- `src/components/`: every other custom element, one flat folder each.
- `src/stores/`: global state as nanostores atoms, one file per domain.
- `src/hooks/<feature>/`: one frozen object per feature (`projects`, `sessions`, `git`, …) holding
  its rules, its backend calls and the actions that call them, with private part files (spec:
  `docs/specs/frontend-structure.md`).
- `src/controllers/<feature>/`: Lit `ReactiveController`s (`PascalCaseController.js`), one folder per
  feature, never colocated with the component that first uses them. One `config` object typed by a
  `@typedef`.
- `src/hooks/<feature>/types.js`: the feature's JSDoc typedefs. They mirror `bt_core::api`'s types.
- `src/styles/tokens.css`: the global app tokens, imported once from `src/main.js`.
- `src/styles/shadow.css`: the first stylesheet of every shadow root (`src/styles/shadow-styles.js`),
  the libraries' included.

## Layers

- **Data layer** (infrastructure): `src/stores/` and `src/hooks/`, plus every browser API that holds
  or fetches state outside the page: `localStorage` / `sessionStorage` (only in `stores/`, through
  `persistent.js`), `history` / `location`, `fetch`, the clipboard, `matchMedia`, and `@tauri-apps/*`
  (only in `hooks/ipc/ipc.js`). Nothing above it talks to these directly.
- **Container components** (`<acp-app>`, `<acp-toolbar-view>`, the columns, and every element in
  `src/views/`) are the only components that import from `stores/`. They subscribe
  (`StoreController`), call actions and hooks, and pass data down as properties, through their
  children to the leaves.
- **Every other component is presentational.** Data comes in through properties; intents go out as
  `acp-*` events that the column handles (they bubble and are composed). No imports from `stores/`,
  no `StoreController`, no storage, network or clipboard APIs. A hook's pure rules may be called,
  its actions never (they go out as events). Where an answer belongs to one request, the container
  calls the child back. A lazy loader is a property. A query is an event answered by a property.
- **Dialogs are rendered only by views.** A component that needs an answer fires an intent and its
  view asks, or takes the view's dialog as a lazy property when it must await the answer.
- A controller counts as part of its host. Data controllers (they read stores or call services) are
  hosted only by a container; pure controllers go anywhere. Shared pure helpers are rules of a hook,
  not of a store module.

## Global state

[nanostores](https://github.com/nanostores/nanostores) atoms in `src/stores/`, named `$camelCase`.

- **State goes in a store; streams are events.** Anything a component renders or another component
  needs lives in a store. One-off happenings stay events: DOM `acp-*` events for UI intents, and
  `projects.onFsChange()` for watcher batches. Don't mirror a store into a reactive property or
  re-announce it with an event.
- **Actions live next to their store**, or, when they call the backend, in a hook that writes the
  store. Container components call actions. Nobody `set()`s a store that another module owns.
- **Narrow with `computed`**, and subscribe to the narrowest store you need.
- **Container components subscribe with `StoreController`** (`src/controllers/store/`). Outside a
  component, or for a one-off read in a handler, use `$store.get()`.
- **Persistence:** `persistentStore(key, initial, { parse, serialize?, listen? })`
  (`stores/persistent/persistent.js`) keeps an atom as JSON in `localStorage` under a `batrak:` key.
  `listen: false` for per-window state; leave it on for shared preferences so all windows stay in
  sync. Per-window state keyed by something uses `persistentMapStore(prefix, parse)`, written only
  through `setKey()`, never `set()`.

## Subsystem notes

The per-subsystem notes are in `.claude/rules/` at the repo root (see the root `AGENTS.md`). Read the
one for a subsystem when a task touches its files.

## Logging and notices

The frontend logs through `app.log(level, message)` (`hooks/app/app.js`, the `write_log` command).
`main.js` calls `app.init()` for uncaught errors, unhandled rejections and the backend's own notices.
`<acp-snackbars>` shows `$notices` (`stores/notices/notices.js`: `notify(level, message)`). A failed
action with no inline error goes through `app.reportError(what, err)`.

## Frontend tests

`@web/test-runner` (`web-test-runner.config.mjs`, real Chrome, mocha + chai) runs every
`src/**/*.test.js`. Each entity has a folder of its own, and its tests sit in a `__tests__/` folder
inside it, named after it: `components/x/__tests__/x.test.js`, `hooks/projects/__tests__/rules.test.js`.

- Use mocha and chai (`expect` from `test/fixture.js`, which re-exports `@esm-bundle/chai`), with
  `fixture()` from `test/fixture.js` to render. Not `@open-wc/testing`.
- Keep logic in plain functions (`stores/`, `hooks/`) and test them directly. Test a component through
  its properties, events and rendered DOM.
- A test is added only for behavior no existing test covers.
- When writing, extending or slimming a suite:
  - draw a feature map first;
  - write one test per user-visible behavior, table-driven for variants (not one per property or key);
  - arrange, act and assert, with a comment on each part;
  - test black-box only;
  - write and run one test at a time;
  - check that each test can fail (falsifiability): break the behavior and see it go red.

## Code conventions

- Private class members use native `#field`, `#method()` and `get #x()`, never `_field`. Declare and
  initialise private fields in the class body, with JSDoc on the declaration. Handlers are
  arrow-function fields. Don't assign private fields in the constructor. Lit reactive properties keep
  their public names.
- Each function or method that takes parameters gets `@param` types. Add a one-line description when
  the name doesn't say it all. Lifecycle methods need types and no comment.
- Shared shapes are `@typedef`s in the owning feature's `src/hooks/<feature>/types.js`.
- No `any`. Cast an event once, at the top of its handler.

### JSDoc

Every JS file is fully typed in JSDoc and checked by `pnpm typecheck` (`checkJs` and `strict`;
`maxNodeModuleJsDepth: 0` keeps tsc out of libraries' shipped JS).

- Each custom element class gets `@tag` and a one-line `@summary`, plus `@fires <event> <detail>` for
  every event it dispatches. No prose paragraphs.
- `src/elements.d.ts` maps every `acp-*` tag in `HTMLElementTagNameMap`. Register each new element there.

## Styling

- **CSS lives in a `.css` file next to its component.** It is imported with `?inline` and assigned
  directly (`static styles = styles;`). `apps/desktop/scripts/lit-css-loader.cjs` turns the import
  into a Lit `CSSResult`. Never write a `css` template-literal block inside component JS.
- **SVG icons** (`@material-design-icons/svg`) are imported with `?raw` and rendered with
  `unsafeSVG()`, inside `<md-icon>`. Size them with `font-size` on a class.
- **Hints are `md-tooltip`, never a `title` attribute**: `<md-tooltip for=${id} show-delay="800">`, a
  sibling of its anchor. Rows with ids use keyed `repeat()`. Tests read a tooltip with `tooltipOf(el)`.
- **Shared shadow styles:** `src/styles/shadow.css` is the one place tag selectors are allowed
  (scrollbars, menu density).
- Colors come from the app tokens in `src/styles/tokens.css` (`--acp-color-*`), spacing from
  `--acp-space-*`. No raw hex. The scales (type, icons, spacing, corners, state layers, elevation,
  stacking) live in `tokens.css`. A one-off optical value stays a literal.
- **Dark-only CSS keys on `:root[data-theme='dark']`**, never on `prefers-color-scheme`.
- **Derived colors use `color-mix()`** over the tokens, not a new token or an `rgba()` copy.
- **Layout that depends on available space uses container queries**, not `@media` on the viewport.
- **Use native CSS nesting** (`&`) for a node's states and its `@container` and `@media` rules.
- New UI controls use compact sizes and dense rows.

### BEM

Shadow DOM already scopes styles. BEM stays for readability, flat predictable specificity, and
consistency with the `@symblight` libraries. The rules below are the working set.

- **Block = the custom element** (`:host`). Classes are named after the tag: `acp-tab-view__tab`.
- **Element** = a node in the component's own `render()`: `block__element`, flat.
- **Modifier** = `block__element_modifier` or `block_modifier`, with a **single** underscore, never
  `--modifier`. Host state is a reflected attribute, styled as `:host([attr])`.
- A **nested custom element is its own block**. To place or size it, mix a parent element's class
  onto it. A block sets no external geometry.
- **No** tag selectors, `*`, `#id`, descendant combinators between entities, resets, or `!important`.
  Outer-tree rules already beat `:host` rules; use `[hidden]` on the parent's class instead.
- Component custom properties are namespaced `--acp-<component>-*` (public) or
  `--_acp-<component>-*` (internal). Never reuse a token's name.

## File structure

Only `src/views/`, `src/components/`, `src/controllers/`, `src/stores/` and `src/hooks/` hold folders.
Each folder directly under them is one entity. It holds its JS and CSS under the tag name without the
`acp-` prefix (`<acp-tab-view>` is `components/tab-view/tab-view.js`), and its tests in `__tests__/`.
No other folders: no category grouping and no sub-components inside an element's folder. Elements
import each other as `'../x/x.js'`. Hooks and stores are one folder per module too.

To scaffold a new element, copy the templates in `.claude/skills/new-component/templates/`.
