---
paths:
  - "src/controllers/sortable/**"
  - "src/components/acp-tab-strip/**"
---

# Drag and drop

In-page reordering never uses the HTML5 drag API: Tauri's native file drop is on
(`dragDropEnabled: true`, for real paths of files dropped from the OS), and with it wry swallows the
page's drag events (macOS: `draggingEntered` / `-Updated` / `performDragOperation` never reach
WKWebView; Windows: drops into the page are off). So no drag-and-drop library either (Pragmatic drag
and drop was removed for this; `@symblight/tree-view` still bundles it for its `reordering`, which the
app leaves off — it would not work).

`SortableController` (`src/controllers/sortable/`), Pointer Events only:
`new SortableController(this, { selector, getId, axis, container, group?, onReorder })`.

- It listens for `pointerdown` on `container` (in the host's render root, re-found after every render);
  the pressed item is the first element on the composed path that `selector` matches, so it works
  through shadow DOM. Main button only (not Control-click, macOS's context menu); other buttons are
  left alone.
- The press listens at `window`, capturing (`pointermove` / `pointerup` / `pointercancel`, `keydown`,
  `blur`), and becomes a drag after 3px of travel: then it measures the items and sets pointer
  capture on the dragged one. A press without travel stays a click; the click a drag's release fires
  is swallowed (one-shot capturing listener, gone after the task). Escape cancels a drag (the rest of
  the press does nothing), as do `pointercancel`, window blur and the host disconnecting. A native
  `dragstart` inside `container` is prevented.
- While dragging, the host marks the dragged item (`dragging`) and translates each item by
  `offsetOf(id)`, animated only while dragging. The dragged item's offset is the pointer's travel
  along `axis` (plus the container's scroll since), so it follows the pointer — the host raises it
  and shows it on a surface, since there's no native drag image; the others slide aside to open the
  slot it would land in. The slot comes from the pointer against the items' midpoints measured when
  the drag starts (live rects move mid-slide and make the slot flicker), corrected for the
  container's scroll since; outside `container`'s rect there is no slot and a release puts it back.
  The reorder lands in the same update that drops the offsets, so nothing jumps; it's skipped if the
  list changed during the drag.
- `container` auto-scrolls along `axis` (a `requestAnimationFrame` loop during the drag): within
  48px (at most a quarter of its size) of either end, faster closer to the edge, `behavior: 'instant'`
  so a `scroll-behavior: smooth` container doesn't animate each step.
- Tabs use it (`moveTab()`; `group` keeps pinned tabs among pinned). Tests drive it with synthetic
  `PointerEvent`s in `acp-tab-strip`'s tests.
