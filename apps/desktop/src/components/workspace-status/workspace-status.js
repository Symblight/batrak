import { LitElement, html } from 'lit';
import '@symblight/wc-material/progress-circular';
import styles from './workspace-status.css?inline';

/** @typedef {import('../../hooks/workspaces/types.js').WorkspaceStatus} WorkspaceStatus */

/** What each status says, also a picker row's label ("<name>, waiting for you"). */
export const STATUS_LABELS = /** @type {const} */ ({
  waiting: 'Waiting for you',
  error: 'Needs attention',
  working: 'Working',
  unread: 'Unread',
  idle: 'Idle',
});

/**
 * @tag acp-workspace-status
 * @summary A workspace's status dot: waiting, error, a spinner while working, unread, an idle ring.
 */
export class AcpWorkspaceStatus extends LitElement {
  static properties = {
    status: { reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {WorkspaceStatus} */
    this.status = 'idle';
  }

  render() {
    const status = this.status;
    return html`<span class="acp-workspace-status__dot acp-workspace-status__dot_${status}" role="img" aria-label=${STATUS_LABELS[status]}
      >${status === 'working' ? html`<md-progress-circular class="acp-workspace-status__spinner"></md-progress-circular>` : ''}</span
    >`;
  }
}

customElements.define('acp-workspace-status', AcpWorkspaceStatus);
