import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/progress-linear';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add_comment.svg?raw';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './workspace-header.css?inline';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */

/**
 * @tag acp-workspace-header
 * @summary The Sessions column's header: the shown workspace's name, New chat, its own slot (the sync), a bar while its folder checks out, a banner when its folder is missing or its checkout failed, and a strip while other workspaces wait.
 * @fires acp-workspace-new-chat `null`
 * @fires acp-workspace-recreate `{ id }` Recreate folder, or Retry a failed checkout.
 * @fires acp-workspace-delete-request `{ id }`
 * @fires acp-workspace-next-waiting `null` The waiting strip: the next waiting workspace.
 */
export class AcpWorkspaceHeader extends LitElement {
  static properties = {
    workspace: { attribute: false },
    waiting: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Workspace | null} `null`: Main. */
    this.workspace = null;
    /** @type {readonly string[]} Names of the project's other waiting workspaces, in the picker's order. */
    this.waiting = [];
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Workspace} workspace */
  #renderBanner({ id, missing, error }) {
    if (!missing && error === null) return nothing;
    const message = missing ? "This workspace's folder is missing" : `Couldn't create the folder: ${error}`;
    return html`<div class="acp-workspace-header__banner" role="alert">
      <span class="acp-workspace-header__message">${message}</span>
      <div class="acp-workspace-header__actions">
        <md-button class="acp-workspace-header__action" variant="text" @click=${() => this.#emit('acp-workspace-recreate', { id })}
          >${missing ? 'Recreate folder' : 'Retry'}</md-button
        >
        <md-button class="acp-workspace-header__action" variant="text" @click=${() => this.#emit('acp-workspace-delete-request', { id })}
          >Delete workspace</md-button
        >
      </div>
    </div>`;
  }

  #renderWaiting() {
    const { waiting } = this;
    if (waiting.length === 0) return nothing;
    return html`<button
      class="acp-workspace-header__waiting"
      aria-keyshortcuts=${shortcuts.aria('nextWaitingWorkspace')}
      @click=${() => this.#emit('acp-workspace-next-waiting', null)}
    >
      ${waiting.length === 1 ? `${waiting[0]} is waiting for you` : `${waiting.length} workspaces waiting`}
    </button>`;
  }

  render() {
    const workspace = this.workspace;
    return html`<div class="acp-workspace-header__top">
        <h2 class="acp-workspace-header__name">${workspace?.name ?? 'Main'}</h2>
        <slot></slot>
        <md-icon-button
          id="acp-workspace-header-new-chat"
          class="acp-workspace-header__new-chat"
          aria-label="New chat"
          @click=${() => this.#emit('acp-workspace-new-chat', null)}
        >
          <md-icon class="acp-workspace-header__icon">${unsafeSVG(addIcon)}</md-icon>
        </md-icon-button>
        <md-tooltip for="acp-workspace-header-new-chat" show-delay="800">New chat</md-tooltip>
      </div>
      ${workspace?.creating ? html`<md-progress-linear class="acp-workspace-header__progress" aria-label="Creating workspace"></md-progress-linear>` : nothing}
      ${workspace ? this.#renderBanner(workspace) : nothing} ${this.#renderWaiting()}`;
  }
}

customElements.define('acp-workspace-header', AcpWorkspaceHeader);
