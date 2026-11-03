import { html } from 'lit';
import { app } from '../../hooks/app/app.js';
import { git } from '../../hooks/git/git.js';
import { $commitSelection, $gitChanges, $gitRepo, setCommitSelection } from '../../stores/git/git.js';
import { notify } from '../../stores/notices/notices.js';
import { $rootId, $project } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/changes-panel/changes-panel.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/**
 * @tag acp-git-changes
 * @summary The Changes side pane wired to its data: the changed files, the repository, the files picked for a commit, and commit and amend.
 * @fires acp-diff-open `{ path }` A changed file's name was clicked: show its diff in the Changes tab.
 */
export class AcpGitChanges extends ViewElement {
  static properties = {
    active: { type: Boolean },
  };

  /** Picks of files no longer changed are forgotten; not while a scan is pending, when the list is empty. */
  #changes = new StoreController(this, {
    store: $gitChanges,
    onChange: (changes, old) => {
      if (!changes.loaded || (changes.files === old?.files && changes.loaded === old?.loaded)) return;
      const changed = new Set(changes.files.map((file) => file.path));
      setCommitSelection([...$commitSelection.get()].filter((id) => changed.has(id)));
    },
  });
  #repo = new StoreController(this, { store: $gitRepo });
  #selection = new StoreController(this, { store: $commitSelection });
  #project = new StoreController(this, { store: $project });
  #rootId = new StoreController(this, { store: $rootId });
  /** @type {(() => void) | null} Stops watching the changes; set while the pane is shown and connected. */
  #unwatch = null;

  constructor() {
    super();
    /** @type {boolean} The pane is the shown one; hidden, the changes are not computed. */
    this.active = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#watch(this.active);
  }

  disconnectedCallback() {
    this.#watch(false);
    super.disconnectedCallback();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('active')) this.#watch(this.active);
  }

  /** @param {boolean} watching */
  #watch(watching) {
    if (watching && this.isConnected) this.#unwatch ??= git.watchChanges();
    else if (!watching) {
      this.#unwatch?.();
      this.#unwatch = null;
    }
  }

  /** @param {Event} e */
  async #onAmendStart(e) {
    const panel = /** @type {HTMLElementTagNameMap['acp-changes-panel']} */ (e.currentTarget);
    const rootId = this.#rootId.value;
    const last = rootId ? await git.lastCommitMessage(rootId).catch(() => null) : null;
    panel.fillAmendMessage(last);
  }

  /** @param {Event} e */
  async #onCommit(e) {
    const panel = /** @type {HTMLElementTagNameMap['acp-changes-panel']} */ (e.currentTarget);
    const { paths, message, amend } = /** @type {CustomEvent<{ paths: string[], message: string, amend: boolean }>} */ (e).detail;
    try {
      const { sha, summary } = await git.commit(paths, message, amend);
      notify('info', `${amend ? 'Amended' : 'Committed'} ${sha}: ${summary}`);
      panel.commitFinished(true);
    } catch (err) {
      // Not `app.reportError`: a hook's output may quote file contents, which stay out of the log.
      app.log('warn', `${amend ? 'amend' : 'commit'} failed`);
      notify('error', `Commit failed: ${err instanceof Error ? err.message : String(err)}`);
      panel.commitFinished(false);
    }
  }

  render() {
    return html`<acp-changes-panel
      .changes=${this.#changes.value}
      .repo=${this.#repo.value}
      .selection=${this.#selection.value}
      .root=${this.#project.value?.path ?? null}
      @acp-commit-select=${(/** @type {CustomEvent<{ ids: string[] }>} */ e) => {
        e.stopPropagation();
        setCommitSelection(e.detail.ids);
      }}
      @acp-changes-refresh=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        git.refreshChanges();
      }}
      @acp-amend-start=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        this.#onAmendStart(e);
      }}
      @acp-commit=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        this.#onCommit(e);
      }}
    ></acp-changes-panel>`;
  }
}

customElements.define('acp-git-changes', AcpGitChanges);
