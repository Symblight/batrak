import { html, nothing } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import '@symblight/wc-material/tooltip';
import { comments } from '../../hooks/comments/comments.js';

/** @typedef {import('lit').ReactiveControllerHost & import('lit').LitElement} ReactiveElementHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('@codemirror/view').EditorView} EditorView */

/**
 * @typedef {Object} ReadOnlyHintConfig
 * @property {() => boolean} readOnly Whether the host's editor refuses edits now.
 */

/**
 * Read-only, CodeMirror fires nothing for a refused edit. These reach the text itself: typing, Enter and
 * IME (`beforeinput`), and what it handles on its own: paste, cut, drop, and the keys of `DELETE_KEYS`,
 * whose `beforeinput` its keymap prevents.
 */
const ATTEMPTS = ['beforeinput', 'paste', 'cut', 'drop', 'keydown'];
const DELETE_KEYS = new Set(['Backspace', 'Delete']);
const ANCHOR_ID = 'acp-read-only-hint-anchor';
const SUBHEAD = 'This file is read-only';
const TEXT = 'Ask the agent to make this change.';
/** How long the hint stays unless hovered; leaving it closes it. */
const SHOWN_MS = 6000;

/**
 * Tells why nothing happens when a read-only file's text is edited: a rich tooltip at the caret, and
 * a status region announcing it once per showing, so key repeat stays quiet. Focus stays in the
 * editor. It closes on a caret move, Escape, a click elsewhere, focus leaving the editor, or by
 * itself. The host renders `controller.render()`.
 * @implements {ReactiveController}
 */
export class ReadOnlyHintController {
  /** @type {ReactiveElementHost} */
  #host;
  /** @type {ReadOnlyHintConfig} */
  #config;
  /** Where the anchor sits, the caret's top: viewport px. */
  #at = { left: 0, top: 0 };
  /** What the status region says. */
  #announced = '';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;

  /**
   * @param {ReactiveElementHost} host
   * @param {ReadOnlyHintConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  hostConnected() {
    // Captured: CodeMirror handles these on the text itself.
    for (const type of ATTEMPTS) this.#host.addEventListener(type, this.#onAttempt, true);
    this.#host.addEventListener('cdx-selection-change', this.#close);
    this.#host.addEventListener('focusout', this.#onFocusOut);
  }

  hostDisconnected() {
    for (const type of ATTEMPTS) this.#host.removeEventListener(type, this.#onAttempt, true);
    this.#host.removeEventListener('cdx-selection-change', this.#close);
    this.#host.removeEventListener('focusout', this.#onFocusOut);
    clearTimeout(this.#timer);
  }

  /** @returns {HTMLElementTagNameMap['md-rich-tooltip'] | null} */
  get #tooltip() {
    return this.#host.renderRoot.querySelector('md-rich-tooltip');
  }

  /** @param {Event} e */
  #onAttempt = (e) => {
    if (!this.#config.readOnly() || (e instanceof KeyboardEvent && !DELETE_KEYS.has(e.key))) return;
    const view = comments.editorOf(e, this.#host.renderRoot)?.view;
    if (!view) return;
    // Not a field of a comment or the search panel, which take text of their own.
    const target = e.composedPath()[0];
    if (target instanceof HTMLElement && target.isContentEditable && view.contentDOM.contains(target)) this.#show(view);
  };

  /** @param {EditorView} view */
  async #show(view) {
    const coords = view.coordsAtPos(view.state.selection.main.head);
    // No coordinates: the caret is scrolled out of view.
    const { left, top } = coords ?? view.dom.getBoundingClientRect();
    this.#at = { left, top };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(this.#close, SHOWN_MS);
    const repeat = this.#tooltip?.open;
    // A new showing is announced even if it says what the last one did: the region changes.
    if (!repeat) {
      this.#announced = '';
      this.#host.requestUpdate();
      await this.#host.updateComplete;
    }
    this.#announced = TEXT;
    this.#host.requestUpdate();
    await this.#host.updateComplete;
    this.#tooltip?.show();
  }

  #close = () => {
    clearTimeout(this.#timer);
    if (!this.#tooltip?.open) return;
    this.#tooltip.hide();
    this.#announced = '';
    this.#host.requestUpdate();
  };

  /** Focus left the editor (another tab, a field): checked once it has landed; another app leaving keeps it. */
  #onFocusOut = () => {
    setTimeout(() => {
      if (document.hasFocus() && !this.#host.matches(':focus-within')) this.#close();
    });
  };

  render() {
    if (!this.#config.readOnly()) return nothing;
    const { left, top } = this.#at;
    return html`<div
        id=${ANCHOR_ID}
        class="acp-code-view__caret-anchor"
        style=${styleMap({ left: `${left}px`, top: `${top}px` })}
      ></div>
      <md-rich-tooltip class="acp-code-view__hint" for=${ANCHOR_ID} positioning="popover" @pointerenter=${() => clearTimeout(this.#timer)}>
        <span slot="subhead">${SUBHEAD}</span>
        ${TEXT}
      </md-rich-tooltip>
      <span class="acp-code-view__status" role="status">${this.#announced}</span>`;
  }
}
