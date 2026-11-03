import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/tree-view';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import doneIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import '../datetime/datetime.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import styles from './subagent-tree.css?inline';

const { SUBAGENT_INDICATOR_LABELS, subagentIndicator, subagentLabel } = sessions;

/** @typedef {import('../../hooks/sessions/types.js').Subagent} Subagent */
/** @typedef {{ id: PropertyKey, label: string, subagent?: Subagent, children?: SubagentItem[] }} SubagentItem */

/** The "N agents" row's id: never an ACP session id. */
const BRANCH = Symbol('agents');

/**
 * @tag acp-subagent-tree
 * @summary A chat's subagents under its row: "N agents" with their statuses, collapsed; expanded, one row per subagent (status, kind · title, age or "waiting").
 * @fires acp-subagent-open `{ sessionId, subagentId }` A subagent's row picked.
 */
export class AcpSubagentTree extends LitElement {
  static properties = {
    sessionId: { attribute: false },
    subagents: { attribute: false },
    activeSubagentId: { attribute: false },
    now: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} The chat they belong to. */
    this.sessionId = '';
    /** @type {readonly Subagent[]} In the order announced. */
    this.subagents = [];
    /** @type {string | null} The subagent whose chat is shown. */
    this.activeSubagentId = null;
    /** @type {number} The time, ms, ages count from. */
    this.now = Date.now();
  }

  /** @type {{ id: string | null, set: Set<PropertyKey> }} The tree's selection: one set per shown subagent, so a render doesn't reassign it. */
  #selected = { id: null, set: new Set() };

  get #selection() {
    if (this.#selected.id !== this.activeSubagentId) {
      this.#selected = { id: this.activeSubagentId, set: new Set(this.activeSubagentId === null ? [] : [this.activeSubagentId]) };
    }
    return this.#selected.set;
  }

  /** @param {Subagent} subagent */
  #status(subagent) {
    const indicator = subagentIndicator(subagent);
    const label = SUBAGENT_INDICATOR_LABELS[indicator];
    const glyph =
      indicator === 'running'
        ? html`<md-progress-circular class="acp-subagent-tree__spinner"></md-progress-circular>`
        : indicator === 'done'
          ? html`<md-icon class="acp-subagent-tree__done">${unsafeSVG(doneIcon)}</md-icon>`
          : html`<span class="acp-subagent-tree__dot acp-subagent-tree__dot_${indicator}"></span>`;
    return html`<span class="acp-subagent-tree__status" role="img" aria-label=${label} data-status=${indicator}>${glyph}</span>`;
  }

  /** @param {SubagentItem} item */
  #renderLeading = (item) => (item.subagent ? this.#status(item.subagent) : nothing);

  /** @param {SubagentItem} item */
  #renderTrailing = (item) => {
    const { subagent } = item;
    if (!subagent) {
      return html`<span class="acp-subagent-tree__minis" aria-hidden="true">${this.subagents.map(
        (s) => html`<span class="acp-subagent-tree__mini acp-subagent-tree__mini_${subagentIndicator(s)}"></span>`,
      )}</span>`;
    }
    return subagent.state === 'requires_action'
      ? html`<span class="acp-subagent-tree__age acp-subagent-tree__age_waiting">waiting</span>`
      : html`<acp-datetime class="acp-subagent-tree__age" .value=${subagent.announcedAt} .now=${this.now} format="compact"></acp-datetime>`;
  };

  /** @param {Event} e */
  #onSelectionChange = (e) => {
    const { selectedItems } = /** @type {CustomEvent<{ selectedItems: Set<PropertyKey> }>} */ (e).detail;
    const [picked] = selectedItems;
    if (typeof picked === 'string') {
      if (picked !== this.activeSubagentId) {
        this.dispatchEvent(
          new CustomEvent('acp-subagent-open', { detail: { sessionId: this.sessionId, subagentId: picked }, bubbles: true, composed: true }),
        );
      }
    } else if (picked === BRANCH) {
      // The "N agents" row only toggles: the shown subagent stays selected.
      /** @type {HTMLElementTagNameMap['tvx-tree-view']} */ (e.currentTarget).selectedItems = this.#selection;
    }
  };

  render() {
    const count = this.subagents.length;
    /** @type {SubagentItem[]} */
    const items = [
      {
        id: BRANCH,
        label: `${count} ${count === 1 ? 'agent' : 'agents'}`,
        children: this.subagents.map((subagent) => ({ id: subagent.id, label: subagentLabel(subagent), subagent })),
      },
    ];
    return html`<tvx-tree-view
      class="acp-subagent-tree__tree"
      compact
      no-virtualization
      aria-label="Subagents"
      .items=${items}
      .selectedItems=${this.#selection}
      .renderItemLeading=${this.#renderLeading}
      .renderItemTrailing=${this.#renderTrailing}
      @tvx-selection-change=${this.#onSelectionChange}
    ></tvx-tree-view>`;
  }
}

customElements.define('acp-subagent-tree', AcpSubagentTree);
