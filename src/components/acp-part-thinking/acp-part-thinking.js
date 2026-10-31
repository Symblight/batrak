import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import thoughtIcon from '@material-design-icons/svg/outlined/psychology.svg?raw';
import stoppedIcon from '@material-design-icons/svg/outlined/pause_circle.svg?raw';
import expandIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import { formatElapsed, splitThought } from '../../models/thinking/thinking.js';
import styles from './acp-part-thinking.css?inline';

/** @typedef {'streaming' | 'done' | 'stopped'} ThinkingStatus */

/** How long a thought that just ended keeps its last lines before it folds. */
const HOLD_MS = 600;

/**
 * @tag acp-part-thinking
 * @summary The agent's thought in its reply: live while it streams (morphing indicator, shimmering label, elapsed time, its last lines), then one line "Thought for 12s" that expands to the text.
 * @fires acp-thinking-toggle `{ open }` The user expanded or folded it.
 */
export class AcpPartThinking extends LitElement {
  static properties = {
    text: { type: String },
    status: { type: String, reflect: true },
    /** When the thought started (ms since epoch); `null` when unknown (history). */
    startedAt: { attribute: false },
    /** When it ended; `null` while it streams or when unknown. */
    endedAt: { attribute: false },
    open: { type: Boolean, reflect: true },
    /** Show the last lines while it streams folded. */
    peek: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.text = '';
    /** @type {ThinkingStatus} */
    this.status = 'streaming';
    /** @type {number | null} */
    this.startedAt = null;
    /** @type {number | null} */
    this.endedAt = null;
    /** @type {boolean} */
    this.open = false;
    /** @type {boolean} */
    this.peek = true;
  }

  /** Now, while it streams: ticks once a second. */
  #now = Date.now();
  /** @type {number | null} When it was seen to end, for an end the stream didn't time (a stopped turn). */
  #seenEnd = null;
  /** Keeps the last lines shown for a moment after it ends. */
  #holding = false;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #ticker;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #holdTimer;

  connectedCallback() {
    super.connectedCallback();
    this.#syncTicker();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.#ticker);
    this.#ticker = undefined;
    clearTimeout(this.#holdTimer);
    this.#holding = false;
  }

  /** @param {Map<string, unknown>} changed */
  willUpdate(changed) {
    if (changed.has('startedAt')) this.#syncTicker();
    if (changed.has('status')) {
      const ended = changed.get('status') === 'streaming' && this.status !== 'streaming';
      if (this.status === 'streaming') this.#seenEnd = null;
      else if (ended) this.#seenEnd = Date.now();
      if (ended && this.peek && !this.open && this.isConnected) this.#hold();
      this.#syncTicker();
    }
  }

  #hold() {
    this.#holding = true;
    clearTimeout(this.#holdTimer);
    this.#holdTimer = setTimeout(() => {
      this.#holding = false;
      this.requestUpdate();
    }, HOLD_MS);
  }

  #syncTicker() {
    const live = this.status === 'streaming' && this.startedAt !== null && this.isConnected;
    if (live && this.#ticker === undefined) {
      this.#now = Date.now();
      this.#ticker = setInterval(() => {
        this.#now = Date.now();
        this.requestUpdate();
      }, 1000);
    } else if (!live && this.#ticker !== undefined) {
      clearInterval(this.#ticker);
      this.#ticker = undefined;
    }
  }

  /** How long it has thought, `null` when unknown. */
  get #elapsed() {
    if (this.startedAt === null) return null;
    const end = this.status === 'streaming' ? Math.max(this.#now, this.startedAt) : (this.endedAt ?? this.#seenEnd);
    return end === null ? null : end - this.startedAt;
  }

  /**
   * @param {string} title
   * @param {string} time
   * @returns {[label: string, time: string]}
   */
  #heading(title, time) {
    if (this.status === 'streaming') return [title || 'Thinking', time];
    if (this.status === 'stopped') return ['Thinking stopped', time && `· ${time}`];
    if (title) return [title, time && `· ${time}`];
    if (time) return [`Thought for ${time}`, ''];
    return [this.#elapsed === null ? 'Thought' : 'Thought briefly', ''];
  }

  #onToggle() {
    this.open = !this.open;
    this.#holding = false;
    this.dispatchEvent(
      new CustomEvent('acp-thinking-toggle', { detail: { open: this.open }, bubbles: true, composed: true }),
    );
  }

  render() {
    const { title, body } = splitThought(this.text);
    const elapsed = this.#elapsed;
    const [label, time] = this.#heading(title, elapsed === null ? '' : formatElapsed(elapsed));
    const streaming = this.status === 'streaming';
    const peeking = !this.open && this.peek && (streaming || this.#holding);
    const expandable = body.trim() !== '';
    return html`
      <button
        class="acp-part-thinking__head"
        type="button"
        aria-expanded=${expandable ? String(this.open) : nothing}
        aria-controls=${expandable ? 'body' : nothing}
        ?disabled=${!expandable}
        @click=${this.#onToggle}
      >
        <span class="acp-part-thinking__indicator">
          <span class="acp-part-thinking__shape"></span>
          <md-icon class="acp-part-thinking__icon">
            ${unsafeSVG(this.status === 'stopped' ? stoppedIcon : thoughtIcon)}
          </md-icon>
        </span>
        <span class="acp-part-thinking__label">${label}</span>
        ${time ? html`<span class="acp-part-thinking__time">${time}</span>` : nothing}
        ${expandable ? html`<md-icon class="acp-part-thinking__chevron">${unsafeSVG(expandIcon)}</md-icon>` : nothing}
      </button>
      ${expandable
        ? html`<div
            id="body"
            class=${classMap({
              'acp-part-thinking__body': true,
              'acp-part-thinking__body_shown': this.open || peeking,
            })}
            role="region"
            aria-label=${label}
          >
            <div class="acp-part-thinking__clip">
              <div
                class=${classMap({ 'acp-part-thinking__text': true, 'acp-part-thinking__text_peek': peeking })}
                aria-live="off"
              >
                ${body}
              </div>
            </div>
          </div>`
        : nothing}
    `;
  }
}

customElements.define('acp-part-thinking', AcpPartThinking);
