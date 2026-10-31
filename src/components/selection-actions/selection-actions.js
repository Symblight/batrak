import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import chatIcon from '@material-design-icons/svg/outlined/chat_bubble_outline.svg?raw';
import addCommentIcon from '@material-design-icons/svg/outlined/add_comment.svg?raw';
import styles from './selection-actions.css?inline';

/** Moves focus from the editor into the actions (the ARIA "go to toolbar" key). */
export const FOCUS_SHORTCUT = 'Alt+F10';

/**
 * @tag acp-selection-actions
 * @summary Popover toolbar (MD3 connected button group) under a code selection: add it to the chat as a chip, or comment on it.
 * @fires acp-selection-chat
 * @fires acp-selection-comment
 * @fires acp-selection-dismiss Escape inside it: close and give focus back to the editor.
 */
export class AcpSelectionActions extends LitElement {
  static styles = styles;

  connectedCallback() {
    super.connectedCallback();
    // Manual: it opens and closes with its selection, as its controller decides; no light dismiss.
    this.popover = 'manual';
    this.showPopover();
    // A press here must not take focus (and so the selection) from the editor.
    this.addEventListener('pointerdown', this.#keepFocus);
  }

  disconnectedCallback() {
    this.removeEventListener('pointerdown', this.#keepFocus);
    super.disconnectedCallback();
  }

  #keepFocus = (/** @type {Event} */ e) => e.preventDefault();

  /** @returns {HTMLElement[]} */
  get #buttons() {
    return [...this.renderRoot.querySelectorAll('md-button')];
  }

  /** Focuses the first action: keyboard entry from the editor. */
  focus() {
    this.#buttons[0]?.focus();
  }

  /** Toolbar keys: arrows, Home and End move between the actions; Escape closes. */
  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('acp-selection-dismiss', { bubbles: true, composed: true }));
      return;
    }
    const buttons = this.#buttons;
    const current = buttons.findIndex((b) => b.matches(':focus-within'));
    const next = /** @type {Record<string, number>} */ ({
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      Home: 0,
      End: buttons.length - 1,
    })[e.key];
    if (next === undefined) return;
    e.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  /** @param {'acp-selection-chat' | 'acp-selection-comment'} type */
  #fire(type) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  }

  render() {
    return html`<div
      class="acp-selection-actions__group"
      role="toolbar"
      aria-label="Selection actions"
      aria-orientation="horizontal"
      aria-keyshortcuts=${FOCUS_SHORTCUT}
      @keydown=${this.#onKeydown}
    >
      <md-button
        class="acp-selection-actions__action acp-selection-actions__action_leading"
        variant="tonal"
        @click=${() => this.#fire('acp-selection-chat')}
      >
        <md-icon slot="icon" class="acp-selection-actions__icon" aria-hidden="true">${unsafeSVG(chatIcon)}</md-icon>
        Add to chat
      </md-button>
      <md-button
        class="acp-selection-actions__action acp-selection-actions__action_trailing"
        variant="tonal"
        @click=${() => this.#fire('acp-selection-comment')}
      >
        <md-icon slot="icon" class="acp-selection-actions__icon" aria-hidden="true">${unsafeSVG(addCommentIcon)}</md-icon>
        Comment
      </md-button>
    </div>`;
  }
}

customElements.define('acp-selection-actions', AcpSelectionActions);
