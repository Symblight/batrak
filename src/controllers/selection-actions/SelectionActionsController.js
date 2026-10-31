import { html, nothing } from 'lit';
import { flip, hide, offset, shift } from '@floating-ui/dom';
import '../../components/selection-actions/selection-actions.js';
import { FloatingController } from '../floating/FloatingController.js';
import { editorOf } from '../../models/editor-events/editor-events.js';

/** @typedef {import('lit').ReactiveControllerHost & import('lit').LitElement} ReactiveElementHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {HTMLElementTagNameMap['cdx-code-editor']} CdxCodeEditor */
/** @typedef {import('@floating-ui/dom').VirtualElement} VirtualElement */

/**
 * @typedef {Object} SelectionActionsConfig
 * @property {(file: string) => string | null} pathOf Absolute path of an editor's `filename`.
 */

/**
 * @typedef {Object} Shown
 * @property {CdxCodeEditor} editor
 * @property {VirtualElement} caret The selection's head, which the actions are anchored to.
 */

/** A keyboard selection settles this long before the actions show; a mouse one on release. */
const SETTLE_MS = 200;
/** Gap between the caret's line and the actions, and their least distance from the window's edges, px. */
const GAP = 6;

/**
 * Shows `<acp-selection-actions>` under the caret of a non-empty selection in one of the host's
 * `cdx-code-editor`s: Add to chat (an `acp-chat-add` event with its `path:from-to` chip) and Comment (the
 * editor's comment field on the selected range). Placed by a `FloatingController`: it follows the caret
 * as the code scrolls, flips above it near the window's bottom and hides while it's scrolled out of
 * view. The host renders `controller.render()`.
 * @fires acp-chat-add {{ inserts: { path: string, fromLine: number, toLine: number, body: string }[] }}
 * @implements {ReactiveController}
 */
export class SelectionActionsController {
  /** @type {ReactiveElementHost} */
  #host;
  /** @type {SelectionActionsConfig} */
  #config;
  /** @type {Shown | null} */
  #shown = null;
  /** @type {CdxCodeEditor | null} Its selection changed; shown once it settles. */
  #pending = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  /** A mouse selection is being dragged: wait for the release. */
  #pressed = false;
  /** @type {FloatingController} */
  #floating;

  /**
   * @param {ReactiveElementHost} host
   * @param {SelectionActionsConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
    this.#floating = new FloatingController(host, {
      floating: () => host.renderRoot.querySelector('acp-selection-actions'),
      reference: () => this.#shown?.caret ?? null,
      placement: 'bottom-start',
      middleware: [offset(GAP), flip({ padding: GAP }), shift({ padding: GAP }), hide()],
    });
  }

  hostConnected() {
    this.#host.addEventListener('cdx-selection-change', this.#onSelectionChange);
    this.#host.addEventListener('pointerdown', this.#onPointerDown);
    this.#host.addEventListener('keydown', this.#onKeydown);
    window.addEventListener('pointerup', this.#onPointerUp);
  }

  hostDisconnected() {
    this.#host.removeEventListener('cdx-selection-change', this.#onSelectionChange);
    this.#host.removeEventListener('pointerdown', this.#onPointerDown);
    this.#host.removeEventListener('keydown', this.#onKeydown);
    window.removeEventListener('pointerup', this.#onPointerUp);
    clearTimeout(this.#timer);
    this.#pending = null;
    this.#shown?.editor.removeEventListener('focusout', this.#onFocusOut);
    this.#shown = null;
  }

  #onSelectionChange = (/** @type {Event} */ e) => {
    const editor = editorOf(e, this.#host.renderRoot);
    if (!editor) return;
    const { selection } = /** @type {HTMLElementEventMap['cdx-selection-change']} */ (e).detail;
    clearTimeout(this.#timer);
    if (selection.main.empty) {
      this.#pending = null;
      this.#hide();
      return;
    }
    this.#pending = editor;
    if (this.#shown) this.#hide(); // follows the selection: shown again where it settles
    if (!this.#pressed) this.#timer = setTimeout(this.#show, SETTLE_MS);
  };

  #onPointerDown = (/** @type {PointerEvent} */ e) => {
    if (e.composedPath().some((node) => node instanceof HTMLElement && node.localName === 'acp-selection-actions')) return;
    this.#pressed = e.button === 0;
    this.#hide();
  };

  #onPointerUp = () => {
    if (!this.#pressed) return;
    this.#pressed = false;
    if (this.#pending) this.#show();
  };

  /** In the shown editor: Escape closes the actions, Alt+F10 (`FOCUS_SHORTCUT`) moves focus into them. */
  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    const shown = this.#shown;
    if (!shown || editorOf(e, this.#host.renderRoot) !== shown.editor) return;
    if (e.key === 'Escape') this.#hide();
    else if (e.altKey && e.key === 'F10') {
      e.preventDefault();
      this.#popover?.focus();
    }
  };

  /**
   * Focus left the editor or the actions: they close unless it went from one to the other. Checked
   * once focus has landed; a window losing focus (another app) keeps them.
   */
  #onFocusOut = () => {
    setTimeout(() => {
      const shown = this.#shown;
      if (!shown || !document.hasFocus()) return;
      if (shown.editor.matches(':focus-within') || this.#popover?.matches(':focus-within')) return;
      this.#hide();
    });
  };

  /** @returns {HTMLElementTagNameMap['acp-selection-actions'] | null} */
  get #popover() {
    return this.#host.renderRoot.querySelector('acp-selection-actions');
  }

  /** Shows the actions at the pending editor's caret. */
  #show = () => {
    const editor = this.#pending;
    this.#pending = null;
    const view = editor?.view;
    if (!editor || !view || view.state.selection.main.empty) return;
    /** @type {DOMRect} Last known: the caret's line may scroll out of CodeMirror's rendered range. */
    let rect = new DOMRect();
    /** @type {VirtualElement} */
    const caret = {
      // autoUpdate listens to the context element's scrolling ancestors, not to the element itself: the
      // content, so CodeMirror's scroller is one of them and the actions stay on the caret's line.
      contextElement: view.contentDOM,
      getBoundingClientRect: () => {
        const coords = view.coordsAtPos(view.state.selection.main.head);
        if (coords) rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
        return rect;
      },
    };
    this.#hide();
    this.#shown = { editor, caret };
    editor.addEventListener('focusout', this.#onFocusOut);
    this.#host.requestUpdate();
  };

  /** Closes the actions; focus inside them goes back to their editor. */
  #hide = () => {
    const shown = this.#shown;
    if (!shown) return;
    if (this.#popover?.matches(':focus-within')) shown.editor.focus();
    shown.editor.removeEventListener('focusout', this.#onFocusOut);
    this.#shown = null;
    this.#host.requestUpdate();
  };

  /**
   * The selection's whole lines, 1-based; one ending at a line's start leaves that line out.
   * @param {CdxCodeEditor} editor
   */
  #selectedLines(editor) {
    const state = editor.view?.state;
    if (!state) return null;
    const { from, to } = state.selection.main;
    const fromLine = state.doc.lineAt(from).number;
    const end = state.doc.lineAt(to);
    const toLine = end.from === to && end.number > fromLine ? end.number - 1 : end.number;
    return { from, to, fromLine, toLine };
  }

  #addToChat() {
    const editor = this.#shown?.editor;
    const lines = editor && this.#selectedLines(editor);
    const path = editor && this.#config.pathOf(editor.filename);
    this.#hide();
    if (!lines || !path) return;
    const inserts = [{ path, fromLine: lines.fromLine, toLine: lines.toLine, body: '' }];
    this.#host.dispatchEvent(new CustomEvent('acp-chat-add', { detail: { inserts }, bubbles: true, composed: true }));
  }

  /** Opens the comment field under the selection's last line, on the selected range. */
  #comment() {
    const editor = this.#shown?.editor;
    const lines = editor && this.#selectedLines(editor);
    this.#hide();
    if (!editor || !lines) return;
    editor.comments.open(lines.toLine, { range: { from: lines.from, to: lines.to } });
  }

  render() {
    const shown = this.#shown;
    // Gone with its tab, or hidden in an inactive one.
    if (!shown || !shown.editor.isConnected || shown.editor.getClientRects().length === 0) return nothing;
    return html`<acp-selection-actions
      @acp-selection-chat=${() => this.#addToChat()}
      @acp-selection-comment=${() => this.#comment()}
      @acp-selection-dismiss=${this.#hide}
      @focusout=${this.#onFocusOut}
    ></acp-selection-actions>`;
  }
}
