import { LitElement, html, nothing } from 'lit';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $git } from '../../stores/git.js';
import { $workspace } from '../../stores/workspace.js';
import styles from './acp-toolbar.css?inline';

/** @typedef {import('../../models/types.js').GitView} GitView */

/**
 * @tag acp-toolbar
 * @summary Narrow app-wide bar above the columns showing the opened folder's name and git branch.
 */
export class AcpToolbar extends LitElement {
  static styles = styles;

  #workspace = new StoreController(this, { store: $workspace });
  #git = new StoreController(this, { store: $git });

  /** @param {GitView} git */
  #renderBranch({ repo, error }) {
    if (error) {
      return html`<span class="acp-toolbar__git-error" title=${error}>Git unavailable</span>`;
    }
    if (!repo) return nothing;
    const name = repo.detached ? (repo.sha?.slice(0, 7) ?? 'HEAD') : (repo.branch ?? '');
    const sync = [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ');
    const title = [
      repo.detached ? `Detached HEAD at ${repo.sha ?? ''}` : `Branch ${repo.branch}`,
      repo.upstream ? `tracking ${repo.upstream}` : 'no upstream',
      repo.ahead ? `${repo.ahead} ahead` : '',
      repo.behind ? `${repo.behind} behind` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return html`<span class="acp-toolbar__branch" title=${title}
      >${name}${sync ? html`<span class="acp-toolbar__sync">${sync}</span>` : nothing}</span
    >`;
  }

  render() {
    const workspace = this.#workspace.value;
    return html`<span class="acp-toolbar__name" title=${workspace?.path ?? ''}>${workspace?.name ?? ''}</span>
      ${workspace ? this.#renderBranch(this.#git.value) : nothing}`;
  }
}

customElements.define('acp-toolbar', AcpToolbar);
