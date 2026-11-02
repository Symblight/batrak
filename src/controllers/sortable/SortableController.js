import { DropTargetController } from '../drop-target/DropTargetController.js';

/** @typedef {import('lit').LitElement} SortableHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */

/** Pointer travel in px before a press becomes a drag, so a click stays a click. */
const DRAG_THRESHOLD = 3;
/** px from either end of the container, along `axis`, where a drag scrolls it. */
const SCROLL_EDGE = 48;
/** px per frame the container scrolls by with the pointer at its very edge. */
const SCROLL_SPEED = 12;

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
 * @property {() => string | null} [dropTo] The name of the `DropTargetController`s the items may be dragged
 *   to, another host's list; over one, the item is handed over on release (its `drop`) instead of reordered here.
 */

/**
 * @typedef {Object} SortablePress
 * @property {number} pointerId
 * @property {number} x clientX where it started.
 * @property {number} y
 * @property {Element} element The pressed item.
 * @property {string} id
 * @property {boolean} moved Became a drag (dropped or cancelled since, it still swallows its click).
 */

/**
 * @typedef {Object} SortableDrag
 * @property {string} id
 * @property {Element} element
 * @property {(string | null)[]} ids The list's ids when the drag started.
 * @property {number} start Its index in the list.
 * @property {number} step px the others move by to make room: its size plus the gap after it.
 * @property {number[]} mids The other items' midpoints along `axis` when the drag started, before any
 *   moved: measured live, a slide in flight would move them and flip the landing spot back and forth.
 * @property {number} scroll The container's scroll offset then; auto-scroll shifts every midpoint.
 * @property {number} origin The pointer along `axis` then.
 * @property {{ x: number, y: number }} pointer The pointer now.
 * @property {number | null} index Where it would land, in the list without it; `null` outside the
 *   container.
 * @property {DropTargetController | null} target The drop target it is over.
 */

/**
 * Reorders the host's items by dragging them with the pointer (Pointer Events and pointer capture, no
 * HTML5 drag and drop: Tauri's native file drop swallows those events in the webview). A press on an
 * item becomes a drag after `DRAG_THRESHOLD` px; Escape or `pointercancel` cancels it, and the click
 * that ends a drag is swallowed. While an item is dragged the host renders `offsetOf(id)` as a
 * translation: the dragged item follows the pointer along `axis`, the others make room where it would
 * land (animated only while `dragging` is set). The landing spot comes from the pointer against the
 * items' resting midpoints, so items moving under the pointer don't change it. A drag crosses hosts only to a `DropTargetController` named by `dropTo`.
 * @implements {ReactiveController}
 */
export class SortableController {
  /** @type {SortableHost} */
  #host;
  /** @type {SortableConfig} */
  #config;
  /** @type {HTMLElement | null} Where presses are listened for. */
  #container = null;
  /** @type {SortablePress | null} */
  #press = null;
  /** @type {SortableDrag | null} */
  #drag = null;
  /** @type {number} The auto-scroll frame. */
  #frame = 0;

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
   * @returns {{ x: number, y: number } | null} Where to draw the dragged item when it can be dropped on
   *   another host's list and the pointer has left its own container (a list that scrolls would clip it).
   */
  get ghost() {
    const drag = this.#drag;
    return drag && drag.index === null && this.#config.dropTo?.() ? drag.pointer : null;
  }

  /**
   * @param {string} id
   * @returns {number} px to translate `id` by along `axis`: the dragged item to stay under the pointer,
   *   the others to make room for it.
   */
  offsetOf(id) {
    const drag = this.#drag;
    if (!drag) return 0;
    // Inside the container: scrolled since, the item moved with the content and the pointer didn't.
    if (id === drag.id) return this.#along(drag.pointer) - drag.origin + this.#scrollOffset() - drag.scroll;
    if (drag.index === null) return 0;
    const i = drag.ids.indexOf(id);
    if (i === -1) return 0;
    const without = i > drag.start ? i - 1 : i;
    const landed = without >= drag.index ? without + 1 : without;
    return (landed - i) * drag.step;
  }

  hostConnected() {
    // The container is listened to from `hostUpdated()`; a reattached host may not render again by itself.
    this.#host.requestUpdate();
  }

  hostUpdated() {
    const element = /** @type {HTMLElement | null} */ (this.#host.renderRoot.querySelector(this.#config.container));
    if (element === this.#container) return;
    this.#container?.removeEventListener('pointerdown', this.#onPointerdown);
    this.#container?.removeEventListener('dragstart', this.#onDragstart);
    this.#container = element;
    element?.addEventListener('pointerdown', this.#onPointerdown);
    element?.addEventListener('dragstart', this.#onDragstart);
  }

  hostDisconnected() {
    this.#container?.removeEventListener('pointerdown', this.#onPointerdown);
    this.#container?.removeEventListener('dragstart', this.#onDragstart);
    this.#container = null;
    this.#endPress();
  }

  /** @returns {Element[]} The items, in list order. */
  #elements() {
    return [...this.#host.renderRoot.querySelectorAll(this.#config.selector)];
  }

  /**
   * @param {{ x: number, y: number }} point
   * @returns {number} Its coordinate along `axis`.
   */
  #along({ x, y }) {
    return this.#config.axis === 'horizontal' ? x : y;
  }

  /** @returns {number} How far the container is scrolled along `axis`. */
  #scrollOffset() {
    const element = this.#container;
    if (!element) return 0;
    return this.#config.axis === 'horizontal' ? element.scrollLeft : element.scrollTop;
  }

  /** No native drag (an image, a selection) may start from an item: the page's would be swallowed. */
  #onDragstart = (/** @type {Event} */ e) => e.preventDefault();

  /** @param {PointerEvent} e */
  #onPointerdown = (e) => {
    // The main button only; Control-click is the context menu on macOS.
    if (e.button !== 0 || !e.isPrimary || e.ctrlKey || this.#press) return;
    const elements = this.#elements();
    const element = /** @type {Element | undefined} */ (
      e.composedPath().find((node) => node instanceof Element && elements.includes(node))
    );
    const id = element ? this.#config.getId(element) : null;
    if (!element || id === null) return;
    this.#press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, element, id, moved: false };
    // At the window, capturing: the pointer's events reach it whatever stops them on the way.
    window.addEventListener('pointermove', this.#onPointermove, true);
    window.addEventListener('pointerup', this.#onPointerup, true);
    window.addEventListener('pointercancel', this.#onPointercancel, true);
    window.addEventListener('keydown', this.#onKeydown, true);
    window.addEventListener('blur', this.#cancel);
  };

  /** @param {PointerEvent} e */
  #onPointermove = (e) => {
    const press = this.#press;
    if (e.pointerId !== press?.pointerId) return;
    // The main button is up: its release went elsewhere, this is a hover.
    if (!(e.buttons & 1)) {
      this.#endPress();
      return;
    }
    const pointer = { x: e.clientX, y: e.clientY };
    if (!press.moved) {
      if (Math.hypot(pointer.x - press.x, pointer.y - press.y) < DRAG_THRESHOLD) return;
      press.moved = true;
      this.#start(press);
    }
    const drag = this.#drag;
    if (!drag) return;
    drag.pointer = pointer;
    this.#move(drag);
  };

  /** @param {PointerEvent} e */
  #onPointerup = (e) => {
    const press = this.#press;
    if (e.pointerId !== press?.pointerId) return;
    const drag = this.#drag;
    if (drag) {
      drag.pointer = { x: e.clientX, y: e.clientY };
      this.#move(drag);
      this.#finish(true);
    }
    // The click this release is about to fire would activate the item.
    if (press.moved) this.#swallowClick();
    this.#endPress();
  };

  /** @param {PointerEvent} e */
  #onPointercancel = (e) => {
    if (e.pointerId === this.#press?.pointerId) this.#endPress();
  };

  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (e.key !== 'Escape' || !this.#drag) return;
    e.preventDefault();
    e.stopPropagation();
    // The press goes on until release, as a drag no more.
    this.#finish(false);
  };

  #cancel = () => this.#endPress();

  #swallowClick() {
    /** @param {Event} e */
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    // A click comes right after its release, in the same task; there may be none (released elsewhere).
    setTimeout(() => window.removeEventListener('click', swallow, true));
  }

  /** Ends the press, and the drag (not dropped) if one is on. */
  #endPress() {
    window.removeEventListener('pointermove', this.#onPointermove, true);
    window.removeEventListener('pointerup', this.#onPointerup, true);
    window.removeEventListener('pointercancel', this.#onPointercancel, true);
    window.removeEventListener('keydown', this.#onKeydown, true);
    window.removeEventListener('blur', this.#cancel);
    if (this.#drag) this.#finish(false);
    this.#press = null;
  }

  /** @param {SortablePress} press */
  #start(press) {
    const { element, id } = press;
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
    const mids = elements
      .filter((other) => other !== element)
      .map((other) => {
        const r = other.getBoundingClientRect();
        return horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      });
    this.#drag = {
      id,
      element,
      ids: elements.map(this.#config.getId),
      start,
      step: (horizontal ? rect.width : rect.height) + Math.max(0, gap),
      mids,
      scroll: this.#scrollOffset(),
      origin: this.#along(press),
      pointer: { x: press.x, y: press.y },
      index: start,
      target: null,
    };
    try {
      element.setPointerCapture(press.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): the window still gets its events.
    }
    this.#frame = requestAnimationFrame(this.#autoScroll);
    this.#host.requestUpdate();
  }

  /**
   * Updates where the dragged item would land; the host re-renders it under the pointer.
   * @param {SortableDrag} drag
   */
  #move(drag) {
    const rect = this.#container?.getBoundingClientRect();
    const { x, y } = drag.pointer;
    const over = !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    drag.index = over ? this.#indexAt(drag) : null;
    const name = this.#config.dropTo?.() ?? null;
    const target = name && !over ? DropTargetController.at(name, drag.id, drag.pointer) : null;
    if (target !== drag.target) drag.target?.leave();
    drag.target = target;
    target?.over(drag.id, drag.pointer, drag.step);
    this.#host.requestUpdate();
  }

  /**
   * Ends the drag.
   * @param {boolean} drop Reorder to where it would land, else put it back.
   */
  #finish(drop) {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    cancelAnimationFrame(this.#frame);
    try {
      drag.element.releasePointerCapture(this.#press?.pointerId ?? 0);
    } catch {
      // Already released.
    }
    this.#host.requestUpdate();
    if (drag.target) {
      // Another host's list takes it, or it goes back.
      if (drop) drag.target.drop(drag.id, drag.pointer);
      else drag.target.leave();
      return;
    }
    // Lands in the same update: the host drops the offsets and their transition together with the
    // reorder, which puts every item where its offset showed it, so nothing jumps.
    if (!drop || drag.index === null || drag.index === drag.start) return;
    // The index is into the list as it was when the drag started; if it changed since, skip.
    const ids = this.#elements().map(this.#config.getId);
    if (ids.length === drag.ids.length && ids.every((id, i) => id === drag.ids[i])) {
      this.#config.onReorder(drag.id, drag.index);
    }
  }

  /** Each frame of a drag: scrolls the container while the pointer is near either end of it. */
  #autoScroll = () => {
    const drag = this.#drag;
    const element = this.#container;
    if (!drag || !element) return;
    this.#frame = requestAnimationFrame(this.#autoScroll);
    const horizontal = this.#config.axis === 'horizontal';
    const rect = element.getBoundingClientRect();
    const { x, y } = drag.pointer;
    if (horizontal ? y < rect.top || y > rect.bottom : x < rect.left || x > rect.right) return;
    const [low, high] = horizontal ? [rect.left, rect.right] : [rect.top, rect.bottom];
    const edge = Math.min(SCROLL_EDGE, (high - low) / 4);
    const pointer = horizontal ? x : y;
    // Faster the closer it is to the edge, or past it.
    const speed = (/** @type {number} */ distance) => Math.ceil(SCROLL_SPEED * (1 - distance / edge));
    let delta = 0;
    if (pointer < low + edge) delta = -speed(Math.max(0, pointer - low));
    else if (pointer > high - edge) delta = speed(Math.max(0, high - pointer));
    if (delta === 0) return;
    const before = this.#scrollOffset();
    // `instant`: a container with `scroll-behavior: smooth` would otherwise animate each step.
    element.scrollBy({ [horizontal ? 'left' : 'top']: delta, behavior: 'instant' });
    if (this.#scrollOffset() !== before) this.#move(drag);
  };

  /**
   * @param {SortableDrag} drag
   * @returns {number} Index in the list without the dragged item, kept within its group.
   */
  #indexAt(drag) {
    const { group } = this.#config;
    // In the coordinates the midpoints were measured in.
    const pointer = this.#along(drag.pointer) + this.#scrollOffset() - drag.scroll;
    const index = drag.mids.filter((mid) => mid < pointer).length;
    if (!group) return index;
    const own = group(drag.id);
    const others = drag.ids.filter((id) => id !== drag.id);
    const members = others.flatMap((id, i) => (group(id ?? '') === own ? [i] : []));
    if (members.length === 0) return drag.start;
    return Math.min(Math.max(index, members[0]), members[members.length - 1] + 1);
  }
}
