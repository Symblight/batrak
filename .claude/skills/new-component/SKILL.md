---
name: new-component
description: Scaffold a new Lit custom element (presentational component in src/components/, or container view in src/views/) the way AGENTS.md lays it out - folder, JS, CSS, test, elements.d.ts entry. Use when adding a new `acp-*` element.
disable-model-invocation: true
argument-hint: <tag-name e.g. acp-foo-bar> [view]
---

# New component

Every path below is relative to `apps/desktop/` (the frontend lives there); run `pnpm` from that folder.

Arguments: the tag (`acp-foo-bar`) and optionally `view` (a container in `src/views/`). Default: a
presentational component in `src/components/`. If the tag is missing or already exists in
`src/elements.d.ts`, stop and ask.

`name` below is the tag without `acp-` (`foo-bar`); `ClassName` is `AcpFooBar`.

## 1. Decide what it is (AGENTS.md, "Layers")

- **Component** (default): data in through properties, intents out as bubbling, composed `acp-*`
  events. No imports from `stores/`, no `StoreController`, no storage / network / clipboard. A hook's
  pure rules may be imported, its actions never.
- **View**: only for a container that reads stores / calls hooks. Extends `ViewElement`, has **no CSS
  file**, renders into itself (light DOM), composes components and uses `<acp-panel>` / `<acp-pane>` /
  `<acp-split>` for layout.
- If the user's description has a part that deserves its own tag, that part is a separate component
  in `src/components/`, never a sub-folder. Load `bem-lit-blocks` if the block / element split is unclear.

## 2. Test first

AGENTS.md works test-first. Before the element has behavior, write the test for the first
user-visible behavior (properties in, events and shadow DOM out) in `__tests__/name.test.js`, run it
with `pnpm test --files <path>` and see it fail, then implement. Start from
`templates/component.test.js`. Use the `lit-test-suite` skill for anything beyond the first test; add
a test only for behavior no existing test covers. CSS-only work gets no test, and no test asserts
computed styles.

## 3. Create the files

Folder is `src/components/name/` (or `src/views/name/`):

| File | Source |
|------|--------|
| `name.js` | `templates/component.js` (view: `templates/view.js`) |
| `name.css` | `templates/component.css` (components only; views have none) |
| `__tests__/name.test.js` | `templates/component.test.js` |

Replace the placeholders (`NAME`, `ClassName`, `acp-NAME`). Then:

- Register it in `src/elements.d.ts`: a `import type { ClassName } from './components/name/name.js';`
  line and an `'acp-name': ClassName;` entry in `HTMLElementTagNameMap` (views: `./views/name/name.js`).
- JSDoc: `@tag`, a one-line `@summary`, and a `@fires <event> <detail>` for every event it dispatches.
  Fully typed, no `any`. Shared shapes are typedefs in the owning `src/hooks/<feature>/types.js`.
- Private members are native `#field` / `#method()`, declared in the class body with JSDoc, never
  assigned in the constructor. Lit reactive properties keep public names and are typed where the
  constructor initialises them.
- Import it where it's used (`'../name/name.js'`; from a view `'../../components/name/name.js'`).

## 4. Styling (components only; read `bem-css` if unsure)

- `import styles from './name.css?inline'; static styles = styles;`, never `css\`\``.
- Block = the host (`:host`); classes `acp-name__element`, modifiers `acp-name__element_modifier`
  (single underscore, never `--`). Flat elements. Host state is a reflected attribute: `:host([attr])`.
- No tag selectors, `*`, `#id`, descendant combinators, resets or `!important`. Native nesting with `&`
  only, for one node's own states and `@container`.
- Colors, spacing, type, icons, corners, state layers, z-index: `--acp-*` tokens from
  `src/styles/tokens.css`. No raw hex. Derived colors with `color-mix()`. Logical properties.
- Space-dependent layout uses `@container`, not `@media`. Dark-only CSS keys on `:root[data-theme='dark']`.
- Hints are `md-tooltip` (`for=id`, `show-delay="800"`), never `title`. Icons: `?raw` SVG via
  `unsafeSVG()` inside `<md-icon>`, sized with `font-size` on a class.
- New controls are compact (small sizes, dense rows). Interactive ones get WAI-ARIA roles and keyboard
  support.

## 5. Check and report

Run `pnpm typecheck` and the new test file; then use the `verify` skill if the task is otherwise
done. Say which behavior a test covers and which only running the app would show. Do not commit;
AGENTS.md asks first, showing the files and a proposed message.
