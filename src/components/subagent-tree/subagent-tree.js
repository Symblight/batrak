import { LitElement, html } from 'lit';
import '@symblight/tree-view';
import '../datetime/datetime.js';
import '../subagent-status/subagent-status.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import styles from './subagent-tree.css?inline';

const { SUBAGENT_INDICATOR_LABELS, subagentIndicator, subagentLabel } = sessions;

/** @typedef {import('../../hooks/sessions/types.js').Subagent} Subagent */
/** @typedef {{ id: string, label: string, subagent: Subagent }} SubagentItem */

/**
 * @tag acp-subagent-tree
 * @summary A chat's subagents, under its row while it's open: one row per subagent (status, kind · title, compact age or "waiting").
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
    return html`<acp-subagent-status
      role="img"
      aria-label=${SUBAGENT_INDICATOR_LABELS[indicator]}
      data-status=${indicator}
      .indicator=${indicator}
    ></acp-subagent-status>`;
  }

  /** @param {SubagentItem} item */
  #renderLeading = (item) => this.#status(item.subagent);

  /** @param {SubagentItem} item */
  #renderTrailing = (item) => {
    const { subagent } = item;
    return subagent.state === 'requires_action'
      ? 'waiting'
      : html`<acp-datetime .value=${subagent.announcedAt} .now=${this.now} format="compact"></acp-datetime>`;
  };

  /** @param {Event} e */
  #onSelectionChange = (e) => {
    const { selectedItems } = /** @type {CustomEvent<{ selectedItems: Set<PropertyKey> }>} */ (e).detail;
    const [picked] = selectedItems;
    if (typeof picked === 'string' && picked !== this.activeSubagentId) {
      this.dispatchEvent(
        new CustomEvent('acp-subagent-open', { detail: { sessionId: this.sessionId, subagentId: picked }, bubbles: true, composed: true }),
      );
    }
  };

  render() {
    /** @type {SubagentItem[]} */
    const items = this.subagents.map((subagent) => ({ id: subagent.id, label: subagentLabel(subagent), subagent }));
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
