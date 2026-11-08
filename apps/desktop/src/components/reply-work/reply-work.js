import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { ChxToolCall } from '@symblight/chat/agent';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import expandIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import '../diff-counts/diff-counts.js';
import '../file-icon/file-icon.js';
import '../markdown/markdown.js';
import '../part-thinking/part-thinking.js';
import { chat } from '../../hooks/chat/chat.js';
import { toolCalls } from '../../hooks/tool-calls/tool-calls.js';
import styles from './reply-work.css?inline';

/** @typedef {import('../../hooks/sessions/types.js').ToolCallView} ToolCallView */
/** @typedef {import('../../hooks/sessions/types.js').WorkStep} WorkStep */
/** @typedef {{ path: string, line?: number }} ChxToolCallLocation */

/**
 * @tag acp-reply-work
 * @summary What a reply did before its answer, as one row: a live line while it runs, then a summary; expands to its tool calls, narration and thoughts.
 * @fires acp-tool-location-click `{ path, line? }` A file chip of the summary was clicked.
 */
export class AcpReplyWork extends LitElement {
  static properties = {
    steps: { attribute: false },
    /** The reply still runs: the line, not the summary. */
    live: { type: Boolean, reflect: true },
    expanded: { type: Boolean, reflect: true },
    /** Builds a call row's file chip (`chx-tool-call`'s `buildLocation`); its own when unset. */
    buildLocation: { attribute: false },
    /** Rewrites a narration's rendered nodes (file refs into chips), as a reply's text. */
    decorate: { attribute: false },
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
    /** @type {((location: ChxToolCallLocation) => HTMLElement) | null} */
    this.buildLocation = null;
    /** @type {((root: ParentNode) => void) | null} */
    this.decorate = null;
    /** A call waits for the user's permission: accents the row. */
    this.waiting = false;
  }

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
    return this.steps.flatMap((step) => (step.kind === 'tool' ? [step.call] : []));
  }

  #syncTicker() {
    const live = this.live && this.isConnected && this.#calls.some((c) => c.startedAt !== null);
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

  /** Since the first call started, until now (live) or the last one ended; `''` when a time is unknown. */
  get #time() {
    const calls = this.#calls;
    const starts = calls.map((c) => c.startedAt);
    if (!starts.length || starts.some((t) => t === null)) return '';
    const start = Math.min(.../** @type {number[]} */ (starts));
    if (this.live) return chat.formatElapsed(Math.max(this.#now, start) - start);
    const ends = calls.map((c) => c.endedAt);
    if (ends.some((t) => t === null)) return '';
    return chat.formatElapsed(Math.max(.../** @type {number[]} */ (ends)) - start);
  }

  #toggle() {
    this.expanded = !this.expanded;
  }

  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.#toggle();
  };

  /**
   * @param {MouseEvent} e
   * @param {ChxToolCallLocation} location
   */
  #openFile(e, location) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('acp-tool-location-click', { detail: location, bubbles: true, composed: true }));
  }

  #liveHead() {
    const { label } = toolCalls.liveLine(this.steps);
    return html`<md-progress-circular class="acp-reply-work__spinner" indeterminate></md-progress-circular>
      <span class="acp-reply-work__label">${label}</span>`;
  }

  #summaryHead() {
    const calls = this.#calls;
    const { clauses, failed, added, removed } = toolCalls.summaryOf(calls);
    const located = (/** @type {string} */ path) => calls.flatMap((c) => c.locations).find((l) => l.path === path) ?? { path };
    return html`<span class="acp-reply-work__label">
        ${clauses.map(
          ({ text, path }, i) =>
            html`${i ? ', ' : ''}${text}${path === undefined
              ? nothing
              : html` <span class="acp-reply-work__file" @click=${(/** @type {MouseEvent} */ e) => this.#openFile(e, located(path))}
                  ><acp-file-icon class="acp-reply-work__file-icon" .name=${path}></acp-file-icon>${path.slice(path.lastIndexOf('/') + 1)}</span
                >`}`,
        )}${failed ? html` <span class="acp-reply-work__failed">· ${failed} failed</span>` : nothing}
      </span>
      <acp-diff-counts .added=${added} .removed=${removed}></acp-diff-counts>`;
  }

  /** @param {ToolCallView} call */
  #callRow(call) {
    return html`<chx-tool-call
      class="acp-reply-work__call"
      .toolCallId=${call.toolCallId}
      .label=${call.label}
      .kind=${call.kind}
      .status=${call.status}
      .locations=${call.locations}
      .error=${call.error}
      .additions=${call.diff?.added || undefined}
      .deletions=${call.diff?.removed || undefined}
      .buildLocation=${this.buildLocation ?? ChxToolCall.prototype.buildLocation}
      >${call.command ? html`<code class="acp-reply-work__command">${call.command}</code>` : nothing}</chx-tool-call
    >`;
  }

  /** @param {WorkStep} step */
  #step(step) {
    if (step.kind === 'tool') return this.#callRow(step.call);
    if (step.kind === 'text') {
      return html`<acp-markdown class="acp-reply-work__narration" policy="reply" .text=${step.text} .decorate=${this.decorate}></acp-markdown>`;
    }
    return html`<acp-part-thinking
      class="acp-reply-work__thought"
      status="done"
      .text=${step.text}
      .startedAt=${step.startedAt}
      .endedAt=${step.endedAt}
      .peek=${false}
    ></acp-part-thinking>`;
  }

  /**
   * A step's key: a call by its id, the rest by their place (they never move).
   * @param {WorkStep} step
   * @param {number} i
   */
  #key(step, i) {
    return step.kind === 'tool' ? step.call.toolCallId : `${step.kind}-${i}`;
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
        @keydown=${this.#onKeydown}
      >
        ${this.live ? this.#liveHead() : this.#summaryHead()} ${time ? html`<span class="acp-reply-work__time">${time}</span>` : nothing}
        <md-icon class="acp-reply-work__chevron">${unsafeSVG(expandIcon)}</md-icon>
      </div>
      ${this.expanded
        ? html`<div class="acp-reply-work__steps">${repeat(this.steps, (s, i) => this.#key(s, i), (s) => this.#step(s))}</div>`
        : nothing}
    `;
  }
}

customElements.define('acp-reply-work', AcpReplyWork);
