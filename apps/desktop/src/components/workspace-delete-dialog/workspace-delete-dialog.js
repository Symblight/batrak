import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/dialog';
import styles from './workspace-delete-dialog.css?inline';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../hooks/workspaces/types.js').DeletePreview} DeletePreview */

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @tag acp-workspace-delete-dialog
 * @summary Delete a workspace: says which uncommitted files a commit saves and which working chats stop, offers Keep branch when the branch has work; nothing is deleted before Delete.
 * @fires acp-workspace-delete `{ id, keepBranch }`
 */
export class AcpWorkspaceDeleteDialog extends LitElement {
  static properties = {
    workspace: { state: true },
    preview: { state: true },
    keepBranch: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Workspace | null} */
    this.workspace = null;
    /** @type {DeletePreview | null} */
    this.preview = null;
    /** @type {boolean} */
    this.keepBranch = true;
  }

  get #dialog() {
    return /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog'));
  }

  /**
   * Asks about deleting `workspace`.
   * @param {Workspace} workspace
   * @param {DeletePreview} preview What deleting it would touch (`workspace_delete_preview`).
   */
  async show(workspace, preview) {
    this.workspace = workspace;
    this.preview = preview;
    this.keepBranch = true;
    await this.updateComplete;
    await this.#dialog.show();
  }

  get #offersKeep() {
    return (this.preview?.commits ?? 0) > 0 || (this.preview?.uncommitted ?? 0) > 0;
  }

  #onDelete() {
    const id = this.workspace?.id;
    void this.#dialog.close();
    if (id === undefined) return;
    this.dispatchEvent(
      new CustomEvent('acp-workspace-delete', { detail: { id, keepBranch: this.#offersKeep && this.keepBranch }, bubbles: true, composed: true }),
    );
  }

  render() {
    const workspace = this.workspace;
    const preview = this.preview;
    const working = preview?.working.length ?? 0;
    return html`<md-dialog class="acp-workspace-delete-dialog__dialog" role="alertdialog">
      <h2 slot="headline" class="acp-workspace-delete-dialog__headline">Delete ${workspace?.name ?? ''}?</h2>
      <div class="acp-workspace-delete-dialog__content">
        ${preview && preview.uncommitted > 0
          ? html`<p class="acp-workspace-delete-dialog__note">
              ${count(preview.uncommitted, 'uncommitted file', 'uncommitted files')} will be saved as a commit on ${workspace?.branch}
            </p>`
          : nothing}
        ${working > 0
          ? html`<p class="acp-workspace-delete-dialog__working">
              ${working === 1 ? '1 chat is' : `${working} chats are`} working and will be stopped
            </p>`
          : nothing}
        ${this.#offersKeep
          ? html`<label class="acp-workspace-delete-dialog__keep">
              <md-checkbox
                .checked=${this.keepBranch}
                @change=${(/** @type {Event} */ e) => (this.keepBranch = /** @type {HTMLInputElement} */ (e.target).checked)}
              ></md-checkbox>
              Keep branch ${workspace?.branch}
            </label>`
          : nothing}
      </div>
      <div slot="footer" class="acp-workspace-delete-dialog__footer">
        <md-button class="acp-workspace-delete-dialog__action acp-workspace-delete-dialog__cancel" variant="text" autofocus @click=${() => void this.#dialog.close()}>Cancel</md-button>
        <md-button class="acp-workspace-delete-dialog__action acp-workspace-delete-dialog__delete" variant="filled" @click=${() => this.#onDelete()}>Delete</md-button>
      </div>
    </md-dialog>`;
  }
}

customElements.define('acp-workspace-delete-dialog', AcpWorkspaceDeleteDialog);
