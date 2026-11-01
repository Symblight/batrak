---
paths:
  - "src/controllers/resize/**"
  - "src/components/column-split/**"
  - "src/components/resize-handle/**"
  - "src/stores/layout/layout.js"
  - "src-tauri/tauri.conf.json"
---

# Column resizing

`ColumnResizeController` (`src/controllers/resize/`) + `<acp-resize-handle>`, dragged with pointer events
and pointer capture — no drag-and-drop library (Pragmatic drag and drop reads `event.target` at
`document`, which shadow DOM retargets to the outermost host, so it never finds a handle in a shadow root).

- The handle fires `acp-resize-start` / `acp-resize` / `acp-resize-end` (drag),
  `acp-resize-step` (arrow keys) and `acp-resize-reset` (double-click), detail `{ name, delta }`, with
  `delta > 0` always meaning "wider" (`edge="start"` flips the pointer direction).
- `<acp-column-split>` (`src/components/column-split/`) owns the app's columns: panes in named slots, a
  divider beside each resizable one; `<acp-app>` gives it `.columns` (a constant), `.widths`
  (`$columnWidths`), `.hiddenColumns` and `.fillColumns`, and writes the `acp-columns-resize { widths }`
  it fires when a drag ends, a key steps or a divider resets back to `$columnWidths`. The controller reads
  and writes no store: `new ColumnResizeController(this, { columns: () => ({ name: { property, min,
  max, partner } }), widths: () => this.widths, onCommit })`, and applies `widths()` on every update (another
  window's change included). It handles events whose `name` it knows (and stops them) and re-renders
  the host, which binds `controller.columnStyle(name)` (inline `flex-basis` / `width`) on the column —
  never a custom property on the host, whose change restyles the whole app every frame; a drag stays
  local until it ends, then goes out through `onCommit` to the store (reset removes the key). Column names are keys of the
  shared store, so they're unique app-wide. The default width is that property's value on `:root`
  from `tokens.css` — don't repeat it in JS. Bind `controller.column(name)` onto the handle's
  `value`/`min`/`max`.
- The parent places the handle with a mix class (`acp-split__handle`, styled by `<acp-split>`); the handle draws
  the divider line, so adjacent columns have no border on that side.
- A press becomes a drag after 3px of travel, so a click or the double-click reset stores nothing.
- A drag only moves width between the two columns beside the handle (splitter): on `-start` / `-step`
  the handle measures both rendered widths and the neighbor's CSS `min-width` (`ResizeMeasure`), and the
  change stops where either side hits its limit. A neighbor that's a resizable column too is its
  `partner` (`session` → `agent`) and gets the opposite width; otherwise it's a flex column that takes
  the slack itself.
- **Tauri `dragDropEnabled: true`** (window in `src-tauri/tauri.conf.json`): files dropped from the OS
  arrive as the webview's native drag events (see `terminals.md`). Resizing doesn't depend on it
  (pointer events), but HTML5 drag-and-drop in the page does: with the native handler on, wry
  swallows `draggingUpdated` on macOS (no `dragover` while the button is held) and Windows disables
  HTML5 drag and drop in the webview — so in-page dragging must use pointer events.
