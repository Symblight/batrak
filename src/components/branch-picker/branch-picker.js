import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/progress-circular';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import styles from './branch-picker.css?inline';

/** @typedef {import('../../hooks/git/types.js').BranchList} BranchList */

const BUTTON_ID = 'acp-branch-picker-button';

/** @type {BranchList} */
const EMPTY = { local: [], remotes: [], default: null };

/**
 * @tag acp-branch-picker
 * @summary "From <branch>" and its menu, opened once `load` is done (a spinner meanwhile): each remote's branches, then the local ones, the remote's default marked.
 * @fires acp-branch-pick `{ branch }` A full short name (`origin/main`, `main`).
 */
export class AcpBranchPicker extends LitElement {
  static properties = {
    list: { attribute: false },
    value: { attribute: false },
    load: { attribute: false },
    loading: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {BranchList} */
    this.list = EMPTY;
    /** @type {string | null} The picked branch. */
    this.value = null;
    /** @type {(() => Promise<void>) | null} Runs before the menu opens (the branches fetched); the menu waits for it. */
    this.load = null;
    /** @type {boolean} */
    this.loading = false;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // The menu opens only once `load` is done: a spinner on the button meanwhile.
  #open = async () => {
    const menu = /** @type {HTMLElementTagNameMap['md-menu'] | null} */ (this.renderRoot.querySelector('md-menu'));
    if (this.loading || !menu) return;
    if (menu.open) {
      menu.close();
      return;
    }
    this.loading = true;
    try {
      await this.load?.();
    } finally {
      this.loading = false;
    }
    await menu.show();
  };

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    this.#emit('acp-branch-pick', { branch: /** @type {CustomEvent<{ value: string }>} */ (e).detail.value });
  };

  /**
   * @param {string} branch Its full short name, the row's value.
   * @param {string} label
   */
  #renderRow(branch, label) {
    const picked = branch === this.value;
    return html`<md-menu-item class="acp-branch-picker__item" value=${branch} ?selected=${picked}>
      <md-icon slot="leading" class="acp-branch-picker__check ${picked ? '' : 'acp-branch-picker__check_hidden'}">${unsafeSVG(checkIcon)}</md-icon>
      <md-icon slot="leading" class="acp-branch-picker__icon">${unsafeSVG(branchIcon)}</md-icon>
      ${label}
      ${branch === this.list.default ? html`<span slot="trailing" class="acp-branch-picker__default">default</span>` : nothing}
    </md-menu-item>`;
  }

  // One list, no sections: Remote with a subgroup per remote, then Local.
  #renderGroups() {
    const { remotes, local } = this.list;
    return html`${remotes.length
      ? html`<md-menu-group label="Remote">
          ${repeat(
            remotes,
            (r) => r.remote,
            (r) => html`<md-menu-group class="acp-branch-picker__remote" label=${r.remote}>
              ${repeat(r.branches, (b) => b, (b) => this.#renderRow(b, b.slice(r.remote.length + 1)))}
            </md-menu-group>`,
          )}
        </md-menu-group>`
      : nothing}
    ${local.length ? html`<md-menu-group label="Local">${repeat(local, (b) => b, (b) => this.#renderRow(b, b))}</md-menu-group>` : nothing}`;
  }

  render() {
    return html`<md-button
        id=${BUTTON_ID}
        class="acp-branch-picker__button"
        variant="outlined"
        ?disabled=${this.value === null}
        @click=${this.#open}
      >
        <span class="acp-branch-picker__label">
          ${this.loading
            ? html`<md-progress-circular class="acp-branch-picker__spinner" aria-label="Loading branches"></md-progress-circular>`
            : html`<md-icon class="acp-branch-picker__icon">${unsafeSVG(branchIcon)}</md-icon>`}
          <span class="acp-branch-picker__from">From</span>
          <span class="acp-branch-picker__name">${this.value ?? ''}</span>
          <md-icon class="acp-branch-picker__icon">${unsafeSVG(expandMoreIcon)}</md-icon>
        </span>
      </md-button>
      <md-menu
        class="acp-branch-picker__menu"
        for=${BUTTON_ID}
        trigger="manual"
        placement="bottom-start"
        focus-on-open="selected"
        aria-label="Branches"
        @select=${this.#onSelect}
      >
        ${this.#renderGroups()}
      </md-menu>`;
  }
}

customElements.define('acp-branch-picker', AcpBranchPicker);
