import { LitElement, html, nothing } from 'lit';
import styles from './diff-counts.css?inline';

/**
 * @tag acp-diff-counts
 * @summary The lines a change adds and removes, as `+12 −3`; nothing when it has no counts.
 */
export class AcpDiffCounts extends LitElement {
  static properties = {
    added: { type: Number },
    removed: { type: Number },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {number | null} */
    this.added = null;
    /** @type {number | null} */
    this.removed = null;
  }

  /** @param {import('lit').PropertyValues<this>} _changed */
  willUpdate(_changed) {
    // An empty host would still take a gap in its row.
    this.hidden = !this.added && !this.removed;
  }

  render() {
    if (!this.added && !this.removed) return nothing;
    return html`${this.added ? html`<span class="acp-diff-counts__added">+${this.added}</span>` : nothing}
    ${this.removed ? html`<span class="acp-diff-counts__removed">−${this.removed}</span>` : nothing}`;
  }
}

customElements.define('acp-diff-counts', AcpDiffCounts);
