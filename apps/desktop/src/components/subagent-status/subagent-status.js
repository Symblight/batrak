import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import doneIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import styles from './subagent-status.css?inline';

/** @typedef {import('../../hooks/sessions/rules.js').SubagentIndicator} SubagentIndicator */

/**
 * @tag acp-subagent-status
 * @summary A subagent's status glyph: a spinner while it runs, a check when done, a dot otherwise (tertiary while it waits, error when failed); its own styles, since a tree view's rows render it in their shadow root.
 */
export class AcpSubagentStatus extends LitElement {
  static properties = {
    indicator: { reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {SubagentIndicator} */
    this.indicator = 'unknown';
  }

  render() {
    if (this.indicator === 'running') return html`<md-progress-circular class="acp-subagent-status__spinner"></md-progress-circular>`;
    if (this.indicator === 'done') return html`<md-icon class="acp-subagent-status__done">${unsafeSVG(doneIcon)}</md-icon>`;
    return html`<span class="acp-subagent-status__dot"></span>`;
  }
}

customElements.define('acp-subagent-status', AcpSubagentStatus);
