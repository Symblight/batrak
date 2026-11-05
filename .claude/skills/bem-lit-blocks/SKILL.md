---
name: bem-lit-blocks
description: >
  Design the block architecture of Lit / LitElement components using BEM (Block / Element /
  Modifier / Mix). Use this skill for *structural* decisions: naming a custom element, deciding
  what is a block vs an element vs a separate composed block, choosing whether an attribute is a
  modifier or plain data, mapping BEM onto host / `render()` / reflected attributes, laying out
  the `components/` folder (flex scheme), deciding what goes in a shared ui-kit as a mix, or
  reviewing a component tree for correct block/element/composition boundaries. Trigger it for
  "is this the right block/element split?", "should this be its own component or a part?",
  "should this be a modifier or a prop?", "how do I structure these components?", "where does
  this file go?" — even when the user does not say "BEM". For writing the actual CSS
  (selectors, nesting, custom properties) use `bem-css`; for MD3 mechanics use `build-web-component`.
---

# BEM Block Design for Lit Components

BEM's Block / Element / Modifier / Mix vocabulary maps cleanly onto web-component structure.
This skill is about the **architecture** — what each part *is* and where it lives. The CSS
that styles it belongs to `bem-css`.

---

## The core mapping (BEM ↔ Lit)

| BEM entity | Web-component realization |
|---|---|
| **Block** | the custom element itself (the host) |
| **Element** | a node created inside the host's own `render()` (its shadow DOM) |
| **Modifier** | a *state/variant* reflected attribute on the host, or a state class on an element |
| **Mix** | several BEM entities on one DOM node — the mechanism for composition & placement |

```ts
@customElement("md-checkbox")            // Block  = md-checkbox
export class MdCheckbox extends LitElement {
  @property({ type: Boolean, reflect: true }) disabled = false; // Modifier (state attr)
  @property({ type: String }) label = "";                       // data — NOT a modifier

  render() {
    return html`
      <div class="checkbox">                                <!-- block root -->
        <span class="checkbox__box"></span>                 <!-- Element -->
        <span class="checkbox__label">${this.label}</span>  <!-- Element -->
      </div>`;
  }
}
```

Custom-element name **is** the block name. The root node in `render()` carries the bare block
class; parts inside it are elements.

---

## Element vs. composed block — the decision that trips people up

An **element** lives in *its own* shadow DOM and is meaningless outside its block
(`checkbox__box` cannot exist without `md-checkbox`).

A **separate custom element placed inside another** is *its own block* — composition, not an
element of the parent — even when the markup looks nested:

```html
<md-place-card>
  <md-rating value="4.5"></md-rating>    <!-- own block: reusable elsewhere -->
  <md-photo-gallery></md-photo-gallery>  <!-- own block: reusable elsewhere -->
</md-place-card>
```

**Rule of thumb:** can it be reused outside the parent? → it's a **block** (composition).
Can it not? → it's an **element**. Never name a reusable child `parent__child`. A nested
custom element is never the parent's element.

---

## Modifier vs. data attribute

Only *state* and *variant* attributes are modifiers. Content/data attributes are not — don't
model them as modifiers or try to style off them as state.

```
disabled, opened, selected, size="large", variant="outlined"   → modifiers
label, value, href, place-id, field, src                        → data
```

Modifiers take two shapes: a reflected boolean/enum attribute on the host (`:host([opened])`)
or a state class on an internal element (`checkbox__box_checked`).

---

## The four laws

**Block** — answers *"what is it?"* (`menu`, `button`, `checkbox`; name by meaning, not by
looks). A block is **context-free**: it must not set external geometry — no margins,
positioning, or sizes that affect the layout *around* it. Placement is the parent's job.

```css
.button { margin-left: 24px; position: absolute; }  /* ❌ block dictates its own placement */
.button { display: inline-flex; padding: 0 16px; }  /* ✅ block owns only its internals */
```

**Element** — always *part of* a block, never standalone, and **optional** (not every block
has elements). Named `block__element`, flat — there is no element-of-element.

**Modifier** — a flag for a state or variant (see above). One shape on the host, one on an
element.

**Mix** — several BEM entities on **one** node. This is how a context-free block gets *placed*
inside another block, and how new components are built from existing ones:

```html
<header class="header">
  <div class="logo header__logo">…</div>     <!-- reusable block + parent's element -->
  <div class="search header__search">…</div>
</header>
```
`logo` stays context-free; `header__logo` supplies the margins/placement. In web components
the same idea appears as a wrapper element (or slotted-container class) in the parent that
positions the child block — the child never positions itself.

---

## File structure — the *flex* scheme

BEM allows `nested`, `flat`, and `flex`. Use **flex**: complex blocks get nested folders,
simple blocks stay flat. One directory per block.

```
src/components/            ← FLAT list of blocks (no forms/ or layout/ grouping)
├── button/
│   ├── button.ts
│   └── button.css
├── checkbox/
│   ├── checkbox.ts
│   └── checkbox.css
└── menu/                  ← a big block may split elements/modifiers into their own files
    ├── menu.ts
    ├── menu.css
    ├── menu__item.css
    └── menu_dense.css
```

- **`components/` is a flat list** — the block name carries the meaning; don't group by category.
- **Elements are flat** — `menu__item`, never `menu__list__item`. Element-of-element means you
  actually found a new block.
- **Every block is universal** — usable in any context precisely because it sets no external geometry.
- **ui-kit / redefinition levels** — shared primitives are consumed as **mixes** on higher-level
  blocks, not by editing the primitive. Override at the composition point, not in the source block.

---

## Architecture review checklist

- [ ] Custom-element name = block name; `render()` root carries the bare block class.
- [ ] Reusable children are their own blocks (composition), not `parent__child` elements.
- [ ] Elements are flat (`block__element`), never element-of-element.
- [ ] Each attribute classified: state/variant → modifier; content → data.
- [ ] Block sets **no** external geometry — placement lives on a mix / wrapper in the parent.
- [ ] Shared primitives reused via mixes, not by editing the primitive block.
- [ ] `components/` is a flat list of block folders (flex scheme).

## See also

- `bem-css` — selectors, native nesting, `:host([mod])`, custom-property naming, specificity.
- `build-web-component` — MD3 tokens, state layers, `?inline` import, component TS template.