import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import expandIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import openIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import '../diff-counts/diff-counts.js';
import '../file-icon/file-icon.js';
import { chat } from '../../hooks/chat/chat.js';
import { toolCalls } from '../../hooks/tool-calls/tool-calls.js';
import styles from './reply-work.css?inline';

/** @typedef {import('../../hooks/sessions/types.js').ToolCallView} ToolCallView */
/** @typedef {import('../../hooks/sessions/types.js').WorkStep} WorkStep */
/** @typedef {ToolCallView['locations'][number]} ToolCallLocation */

/**
 * A keydown listener that runs `act` on Enter or Space, as a button's click.
 * @param {() => void} act
 */
const onActivateKey = (act) => (/** @type {KeyboardEvent} */ e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  act();
};

/**
 * @tag acp-reply-work
 * @summary What a reply did before its answer, as one row: a live line while a call runs, else a summary; expands to a card of its tool calls.
 * @fires acp-tool-location-click `{ path, line? }` A file chip of the summary or a call's row was clicked.
 */
export class AcpReplyWork extends LitElement {
  static properties = {
    steps: { attribute: false },
    /** The reply still runs: the line, not the summary. */
    live: { type: Boolean, reflect: true },
    expanded: { type: Boolean, reflect: true },
    waiting: { type: Boolean, reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {WorkStep[]} */
    this.steps = [];
    /** @type {boolean} */
    this.live = false;
    /** @type {boolean} */
    this.expanded = false;
    /** A call waits for the user's permission: accents the row. */
    this.waiting = false;
  }

  /** The calls whose rows are open, by id. */
  #open = new Set();

  /** Now, while the reply runs: ticks once a second. */
  #now = Date.now();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #ticker;

  connectedCallback() {
    super.connectedCallback();
    this.#syncTicker();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.#ticker);
    this.#ticker = undefined;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('steps') || changed.has('live')) {
      this.waiting = this.live && this.#calls.some((c) => c.status === 'awaiting-permission');
      this.#syncTicker();
    }
  }

  get #calls() {
    return this.steps.map((step) => step.call);
  }

  /**
   * The reply runs and so does a call: the live line. Between calls the text below may be the answer
   * (ACP doesn't say until the turn ends), so the row shows what it did so far, not a spinner.
   */
  get #working() {
    return this.live && toolCalls.liveLine(this.#calls) !== null;
  }

  #syncTicker() {
    const live = this.#working && this.isConnected && this.#calls.some((c) => c.startedAt !== null);
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

  /** Since the first call started, until now (a call runs) or the last one ended; `''` when a time is unknown. */
  get #time() {
    const calls = this.#calls;
    const starts = calls.map((c) => c.startedAt);
    if (!starts.length || starts.some((t) => t === null)) return '';
    const start = Math.min(.../** @type {number[]} */ (starts));
    if (this.#working) return chat.formatElapsed(Math.max(this.#now, start) - start);
    const ends = calls.map((c) => c.endedAt);
    if (ends.some((t) => t === null)) return '';
    return chat.formatElapsed(Math.max(.../** @type {number[]} */ (ends)) - start);
  }

  #toggle() {
    this.expanded = !this.expanded;
  }

  /**
   * @param {MouseEvent} e
   * @param {ToolCallLocation} location
   */
  #openFile(e, location) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('acp-tool-location-click', { detail: location, bubbles: true, composed: true }));
  }

  #liveHead() {
    const { label = '', command = '' } = toolCalls.liveLine(this.#calls) ?? {};
    return html`<md-progress-circular class="acp-reply-work__spinner" indeterminate></md-progress-circular>
      <span class="acp-reply-work__label"
        >${label}${command ? html` <code class="acp-reply-work__live-command">${command}</code>` : nothing}</span
      >`;
  }

  #summaryHead() {
    const calls = this.#calls;
    const { clauses, failed, added, removed } = toolCalls.summaryOf(calls);
    const located = (/** @type {string} */ path) => calls.flatMap((c) => c.locations).find((l) => l.path === path) ?? { path };
    return html`<span class="acp-reply-work__label">
        ${clauses.map(({ text, path }, i) => html`${i ? ', ' : ''}${text}${path === undefined ? nothing : html` ${this.#file(located(path))}`}`)}${failed ? html` <span class="acp-reply-work__failed">· ${failed} failed</span>` : nothing}
      </span>
      <acp-diff-counts .added=${added} .removed=${removed}></acp-diff-counts>`;
  }

  /** @param {ToolCallLocation} location A file chip, which opens the file. */
  #file(location) {
    const { path } = location;
    return html`<span class="acp-reply-work__file" @click=${(/** @type {MouseEvent} */ e) => this.#openFile(e, location)}
      ><acp-file-icon class="acp-reply-work__file-icon" .name=${path}></acp-file-icon>${path.slice(path.lastIndexOf('/') + 1)}</span
    >`;
  }

  /** @param {string} id */
  #toggleCall(id) {
    if (!this.#open.delete(id)) this.#open.add(id);
    this.requestUpdate();
  }

  /**
   * A call's row: what it did, its file and counts; open, its error and command.
   * @param {ToolCallView} call
   */
  #callRow(call) {
    const { text, path } = toolCalls.rowOf(call);
    const open = this.#open.has(call.toolCallId);
    const toggle = () => this.#toggleCall(call.toolCallId);
    const failed = call.status === 'failed';
    return html`<div class="acp-reply-work__call ${failed ? 'acp-reply-work__call_failed' : ''}">
      <div
        class="acp-reply-work__row"
        role="button"
        tabindex="0"
        aria-expanded=${String(open)}
        @click=${toggle}
        @keydown=${onActivateKey(toggle)}
      >
        <span class="acp-reply-work__row-label">${text}</span> ${path === undefined ? nothing : this.#file(call.locations[0])}
        <acp-diff-counts .added=${call.diff?.added ?? null} .removed=${call.diff?.removed ?? null}></acp-diff-counts>
        <md-icon class="acp-reply-work__row-chevron">${unsafeSVG(openIcon)}</md-icon>
      </div>
      ${open
        ? html`<div class="acp-reply-work__detail">
            ${call.error ? html`<pre class="acp-reply-work__error">${call.error}</pre>` : nothing}
            ${call.command && call.command !== call.label ? html`<code class="acp-reply-work__command">${call.command}</code>` : nothing}
          </div>`
        : nothing}
    </div>`;
  }

  render() {
    const time = this.#time;
    return html`
      <div
        class="acp-reply-work__head"
        role="button"
        tabindex="0"
        aria-expanded=${String(this.expanded)}
        @click=${this.#toggle}
        @keydown=${onActivateKey(() => this.#toggle())}
      >
        ${this.#working ? this.#liveHead() : this.#summaryHead()} ${time ? html`<span class="acp-reply-work__time">${time}</span>` : nothing}
        <md-icon class="acp-reply-work__chevron">${unsafeSVG(expandIcon)}</md-icon>
      </div>
      ${this.expanded
        ? html`<div class="acp-reply-work__steps">${repeat(this.#calls, (c) => c.toolCallId, (c) => this.#callRow(c))}</div>`
        : nothing}
    `;
  }
}

customElements.define('acp-reply-work', AcpReplyWork);
