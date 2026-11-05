---
name: bem-css
description: >
  Write and review CSS for Lit / shadow-DOM web components under BEM discipline. Use this
  skill whenever the work is about the *styles themselves*: writing a component's `.css`
  file, choosing or reviewing selectors, deciding class names (`block__element_modifier`),
  using native CSS nesting, naming CSS custom properties (`--<wc>-*`), styling host/slotted/
  part (`:host([mod])`, `::slotted`, `::part`), managing specificity with `:where()`, or
  auditing CSS for tag/`*`/`#id`/`!important`/reset/cross-block-combinator violations.
  Trigger it for "review this CSS", "why is this selector winning", "how should I name this
  class", "can I nest this", "how do I expose a theming variable" — even if the user does not
  say "BEM". For deciding *what is a block vs element vs modifier* or how to structure the
  component tree, use `bem-lit-blocks` instead. For MD3 tokens/mechanics use `build-web-component`.
---

# BEM CSS for Shadow-DOM Components

BEM was invented to fake style encapsulation in a **global** stylesheet: long, prefixed
class names guarantee no collisions because every selector is namespaced by hand.

Shadow DOM gives that encapsulation **for real** — external CSS can't leak in, your CSS
can't leak out. So inside a component the reason to keep BEM is *not* collision avoidance.
Keep it for **readability**, **predictable specificity** (flat, single-class selectors keep
the cascade boring and overridable), and **library consistency**. When a rule below looks
redundant ("tag selectors are safe in shadow DOM!"), it's kept for readability/specificity,
not scoping.

---

## Class-name syntax

```
Block:    .block                       .checkbox
Element:  .block__element              .checkbox__box
Modifier: .block__element_modifier     .checkbox__box_checked
          .block_modifier              .checkbox_disabled
```

Double underscore `__` before an element, single underscore `_` before a modifier. **No
camelCase, no double underscore on modifiers, no element-of-element** (`a__b__c` is wrong —
that's a new block). The root element inside a component's `render()` carries the bare block
class (`.checkbox`); the host itself is the block too (see `:host` below).

---

## Hard rules

Each rule notes *why it still matters under Shadow DOM.*

**1. No type/tag selectors for structure.**
```css
.logo a { }       /* bad — couples style to markup */
.logo__link { }   /* good — style the role, not the tag */
```
Tag selectors are collision-safe in shadow DOM but read poorly and break when markup shifts.

**2. No universal selector `*`.**
```css
* { margin: 0 }        /* bad — blunt, unpredictable */
.page { margin: 0 }    /* good — explicit */
```

**3. No resets / normalizers.** They spray dozens of rules that mostly never apply, and the
shadow boundary already resets most inherited styling. Set what you actually need, where you need it.

**4. No `#id` selectors for styling.** IDs are scoped in shadow DOM (no collisions) but carry
high, hard-to-override specificity. Use classes; reserve `id` for `aria-*` / `for` wiring.

**5. No descendant *combinator* between entities** — this is about the space combinator, not
nesting syntax (see below).
```css
.block_blah .elem   { }  /* bad — one block reaches into another; 0,2,0 */
.block__elem        { }  /* good — flat, single class; 0,1,0 */
```
A block must not depend on where it sits.

**6. No `!important`.** If you reach for it, the specificity is already wrong — flatten
instead. Use `:where(...)` (specificity 0) for rules a parent theme should be able to beat.

---

## Native CSS nesting

Nesting is **encouraged** as *co-location* — never to build names or reach across entities.
It is not Sass; two things differ:

- **No string concatenation.** `&__box` / `&_active` do **not** produce `.block__box` /
  `.block_active`. Native nesting has no concatenation, and a `type&`-shaped selector like
  `&__box` makes the whole rule invalid. Write BEM names **in full**. (A feature: you can't
  accidentally invent element-of-element.)
- **Bare nesting inserts a descendant combinator.** `.a { .b {} }` → `.a .b {}` — rule 5's
  coupling plus `0,2,0`. Always use `&` to keep a compound.

Use nesting for **one node's own** states, variants, and responsive rules:

```css
.checkbox__box {                     /* full BEM name, flat */
  border: 2px solid var(--md-checkbox-outline-color);

  &:hover          { /* .checkbox__box:hover — compound via &, 0,1,1 */ }
  &[data-checked]  { /* state on the node itself */ }
  @media (prefers-reduced-motion) { transition: none; }
}
```
```css
.checkbox { .checkbox__box { } }   /* ❌ → .checkbox .checkbox__box — coupling + 0,2,0 */
```

Gotchas: `&` takes the specificity of the **most specific** selector in the parent list
(fine for single-class blocks). If a bundler (Lightning CSS / PostCSS) post-processes
`?inline` CSS, confirm its `browserslist` target matches native-nesting support so it isn't
down-compiled into legacy syntax.

---

## Styling the host, states, slots, parts

```css
:host            { display: inline-flex; }          /* the block */
:host([disabled]){ opacity: 0.38; pointer-events: none; }  /* modifier via reflected attr */
:host([opened])  { }                                /* variant modifier */

.checkbox__box_checked { }                           /* element modifier (class) */

::slotted(img)   { border-radius: 50%; }             /* light-DOM children passed via <slot> */
::part(track)    { }                                 /* only when you deliberately expose part= */
```

- Modifiers live as **`:host([attr])`** (host state) or **`block__element_modifier`** classes
  (internal element state) — never as hidden state buried in a descendant selector.
- `:host` rules stay flat; there are few of them.
- Expose `part=` only when you *intend* a public styling contract — it's as binding as an API.

---

## CSS custom properties (the theming API)

Custom properties **pierce the shadow boundary** (unlike normal rules), so they're your
public theming surface — and the one thing that can collide across components. Namespace with
the component name.

```
--<wc-name>-<role>          e.g.  --md-button-bg-color
--<wc-name>-<part>-<role>   e.g.  --md-checkbox-box-outline-color
```

```css
:host {
  /* PUBLIC — documented, meant to be overridden by a consumer/theme */
  --md-button-bg-color: var(--md-sys-color-primary);
  --md-button-label-color: var(--md-sys-color-on-primary);

  /* INTERNAL — derived, not a contract (leading _ signals "private") */
  --_md-button-state-opacity: 0;
}
```

- Map public props from design-system tokens (`--md-sys-color-*`), never raw hex.
- `:where(.block__element)` gives zero-specificity rules a parent can override without `!important`.

---

## Good / bad quick reference

```
✅  :host([opened]) .menu__list { … }     modifier attr + own element
❌  md-menu[opened] .list { … }            tag + external, leaks intent

✅  .card__title { font: … }               role-named element
❌  .card h2 { font: … }                    structure-coupled tag selector

✅  .box { &:hover { … } }                 nesting for the node's own state
❌  .card { .card__title { … } }            bare nesting → descendant combinator

✅  --md-card-elevation: …                  namespaced custom prop
❌  --elevation: …                          unnamespaced, collides via inheritance
```

---

## Review checklist

- [ ] Class names are `block` / `block__element` / `*_modifier`; no camelCase, no element-of-element.
- [ ] No tag, `*`, `#id`, or cross-block descendant selectors; no `!important`; no reset/normalizer.
- [ ] Native nesting only via `&`; BEM names written in full, never assembled by nesting.
- [ ] State/variant is a `:host([mod])` attr or `*_modifier` class — never hidden in a descendant selector.
- [ ] Custom properties namespaced `--<wc>-*`; public vs. internal (`--_wc-*`) separated; colors from tokens, no raw hex.
- [ ] `:where()` used for rules meant to stay overridable; `::part` exposed only where a public contract is intended.

## See also

- `bem-lit-blocks` — deciding *what* is a block/element/modifier, component tree, file structure.
- `build-web-component` — MD3 tokens, state layers, `:host` setup, `?inline` import mechanics.