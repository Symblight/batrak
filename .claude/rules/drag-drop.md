---
paths:
  - "src/controllers/sortable/**"
  - "src/components/acp-tab-strip/**"
  - "patches/**"
---

# Drag and drop

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
