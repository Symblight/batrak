import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

/** @typedef {import('lit').LitElement} SortableHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('@atlaskit/pragmatic-drag-and-drop/types').DragLocationHistory} DragLocationHistory */

/**
 * @typedef {Object} SortableConfig
 * @property {string} selector The items, in the host's render root; their DOM order is the list's.
 * @property {(element: Element) => string | null} getId
 * @property {'horizontal' | 'vertical'} axis
 * @property {string} container The element, in the host's render root, holding the items: a drag over
 *   it reorders, and it scrolls along `axis` while a drag is near its edges.
 * @property {(id: string) => string} [group] Items move only among their group; each group must be
 *   one contiguous run of the list. One group by default.
 * @property {(id: string, index: number) => void} onReorder Move `id` to `index` of the list without it.
 */

/**
 * @typedef {Object} SortableDrag
 * @property {string} id
 * @property {(string | null)[]} ids The list's ids when the drag started.
 * @property {number} start Its index in the list.
 * @property {number} step px the others move by to make room: its size plus the gap after it.
 * @property {number[]} mids The other items' midpoints along `axis` when the drag started, before any
 *   moved: measured live, a slide in flight would move them and flip the landing spot back and forth.
 * @property {number} scroll The container's scroll offset then; auto-scroll shifts every midpoint.
 * @property {number | null} index Where it would land, in the list without it; `null` outside the
 *   container.
 */

/**
 * Reorders the host's items by drag and drop (Pragmatic drag and drop, patched for shadow DOM). After
 * every render it registers the items `selector` matches as draggables and forgets removed ones. While
 * an item is dragged the others make room where it would land: the host renders `offsetOf(id)` as a
 * translation, animated only while `dragging` is set, and hides the dragged item (the native preview
 * follows the pointer). The landing spot comes from the pointer against the items' resting midpoints,
 * so items moving under the pointer don't change it. Drags never cross hosts.
 * @implements {ReactiveController}
 */
export class SortableController {
  /** @type {SortableHost} */
  #host;
  /** @type {SortableConfig} */
  #config;
  /** Marks this host's drags in their data (`sortable`). */
  #key = Symbol('sortable');
  /** @type {Map<Element, () => void>} Registered items and their cleanup. */
  #items = new Map();
  /** @type {{ element: Element, cleanup: () => void } | null} */
  #container = null;
  /** @type {(() => void) | null} */
  #stopMonitor = null;
  /** @type {SortableDrag | null} */
  #drag = null;

  /**
   * @param {SortableHost} host
   * @param {SortableConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  /** @returns {string | null} Id of the item being dragged. */
  get dragging() {
    return this.#drag?.id ?? null;
  }

  /**
   * @param {string} id
   * @returns {number} px to translate `id` by along `axis`, making room for the dragged item.
   */
  offsetOf(id) {
    const drag = this.#drag;
    if (!drag || drag.index === null || id === drag.id) return 0;
    const i = drag.ids.indexOf(id);
    if (i === -1) return 0;
    const without = i > drag.start ? i - 1 : i;
    const landed = without >= drag.index ? without + 1 : without;
    return (landed - i) * drag.step;
  }

  hostConnected() {
    // Items are registered in `hostUpdated()`; a reattached host may not render again by itself.
    this.#host.requestUpdate();
    this.#stopMonitor = monitorForElements({
      canMonitor: ({ source }) => source.data.sortable === this.#key,
      onDragStart: ({ source }) => this.#start(String(source.data.id), source.element),
      onDrag: ({ location }) => this.#move(location),
      onDrop: ({ location }) => {
        this.#move(location);
        const drag = this.#drag;
        this.#drag = null;
        this.#host.requestUpdate();
        // Lands in the same update: the host drops the offsets and their transition together with
        // the reorder, which puts every item where its offset showed it, so nothing jumps.
        if (!drag || drag.index === null || drag.index === drag.start) return;
        // The index is into the list as it was when the drag started; if it changed since, skip.
        const ids = this.#elements().map(this.#config.getId);
        if (ids.length === drag.ids.length && ids.every((id, i) => id === drag.ids[i])) {
          this.#config.onReorder(drag.id, drag.index);
        }
      },
    });
  }

  hostUpdated() {
    this.#syncContainer();
    const elements = new Set(this.#elements());
    for (const [element, cleanup] of this.#items) {
      if (elements.has(element)) continue;
      cleanup();
      this.#items.delete(element);
    }
    for (const element of elements) {
      if (this.#items.has(element) || !(element instanceof HTMLElement)) continue;
      const getInitialData = () => ({ sortable: this.#key, id: this.#config.getId(element) });
      this.#items.set(element, draggable({ element, getInitialData }));
    }
  }

  hostDisconnected() {
    for (const cleanup of this.#items.values()) cleanup();
    this.#items.clear();
    this.#container?.cleanup();
    this.#container = null;
    this.#stopMonitor?.();
    this.#stopMonitor = null;
    this.#drag = null;
  }

  /** @returns {Element[]} The items, in list order. */
  #elements() {
    return [...this.#host.renderRoot.querySelectorAll(this.#config.selector)];
  }

  /** Registers the container as drop target and for auto-scroll, again if it was re-rendered. */
  #syncContainer() {
    const element = this.#host.renderRoot.querySelector(this.#config.container);
    if (element === (this.#container?.element ?? null)) return;
    this.#container?.cleanup();
    const ours = (/** @type {{ source: { data: Record<string, unknown> } }} */ { source }) =>
      source.data.sortable === this.#key;
    this.#container = element && {
      element,
      cleanup: combine(
        dropTargetForElements({ element, canDrop: ours }),
        autoScrollForElements({ element, canScroll: ours, getAllowedAxis: () => this.#config.axis }),
      ),
    };
  }

  /**
   * @param {string} id
   * @param {HTMLElement} element The dragged item.
   */
  #start(id, element) {
    const elements = this.#elements();
    const start = elements.indexOf(element);
    if (start === -1) return;
    const horizontal = this.#config.axis === 'horizontal';
    const rect = element.getBoundingClientRect();
    // The gap to a neighbor too, so the room made matches the slot the item leaves.
    const next = elements[start + 1]?.getBoundingClientRect();
    const prev = elements[start - 1]?.getBoundingClientRect();
    let gap = 0;
    if (next) gap = horizontal ? next.left - rect.right : next.top - rect.bottom;
    else if (prev) gap = horizontal ? rect.left - prev.right : rect.top - prev.bottom;
    const ids = elements.map(this.#config.getId);
    const mids = elements
      .filter((other) => other !== element)
      .map((other) => {
        const r = other.getBoundingClientRect();
        return horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      });
    this.#drag = {
      id,
      ids,
      start,
      step: (horizontal ? rect.width : rect.height) + Math.max(0, gap),
      mids,
      scroll: this.#scrollOffset(),
      index: start,
    };
    this.#host.requestUpdate();
  }

  /** @returns {number} How far the container is scrolled along `axis`. */
  #scrollOffset() {
    const element = this.#container?.element;
    if (!element) return 0;
    return this.#config.axis === 'horizontal' ? element.scrollLeft : element.scrollTop;
  }

  /**
   * Updates where the dragged item would land.
   * @param {DragLocationHistory} location
   */
  #move(location) {
    const drag = this.#drag;
    if (!drag) return;
    const over = location.current.dropTargets.some((target) => target.element === this.#container?.element);
    const index = over ? this.#indexAt(drag, location.current.input) : null;
    if (index === drag.index) return;
    drag.index = index;
    this.#host.requestUpdate();
  }

  /**
   * @param {SortableDrag} drag
   * @param {{ clientX: number, clientY: number }} input
   * @returns {number} Index in the list without the dragged item, kept within its group.
   */
  #indexAt(drag, { clientX, clientY }) {
    const { axis, group } = this.#config;
    // In the coordinates the midpoints were measured in.
    const pointer = (axis === 'horizontal' ? clientX : clientY) + this.#scrollOffset() - drag.scroll;
    const index = drag.mids.filter((mid) => mid < pointer).length;
    if (!group) return index;
    const own = group(drag.id);
    const others = drag.ids.filter((id) => id !== drag.id);
    const members = others.flatMap((id, i) => (group(id ?? '') === own ? [i] : []));
    if (members.length === 0) return drag.start;
    return Math.min(Math.max(index, members[0]), members[members.length - 1] + 1);
  }
}
