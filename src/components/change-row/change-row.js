import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import undoIcon from '@material-design-icons/svg/outlined/undo.svg?raw';
import { git } from '../../hooks/git/git.js';
import '../diff-counts/diff-counts.js';
import styles from './change-row.css?inline';

/** @typedef {import('../../hooks/git/changes.js').ChangeRow} ChangeRow */

/** Disabled controls of features that don't exist yet say so on hover. */
const NOT_YET = 'Not available yet';

/**
 * @tag acp-change-row
 * @summary A changed file in the Changes tab: chevron, a checkbox to pick it for the commit, its type badge, name, folder and rename, the lines it adds and removes, and Edit and Revert while hovered, focused or expanded (shown by CSS).
 * @fires acp-change-toggle `{ id }` The row was clicked, or Enter / Space: expand or collapse its diff.
 * @fires acp-change-expand `{ id }` ArrowRight on a collapsed row.
 * @fires acp-commit-pick `{ ids, picked }`
 * @fires acp-change-edit `{ id }` Edit was pressed.
 */
export class AcpChangeRow extends LitElement {
  static properties = {
    row: { attribute: false },
    expanded: { type: Boolean, reflect: true },
    picked: { type: Boolean },
    selectable: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {ChangeRow | null} */
    this.row = null;
    /** @type {boolean} Its diff shows: this is the card's header, which always shows the actions. */
    this.expanded = false;
    /** @type {boolean} Picked for the next commit. */
    this.picked = false;
    /** @type {boolean} It can be picked (not a worktree session's read-only changes). */
    this.selectable = true;
  }

  /** Focuses the row, without scrolling it; waits for its first render when it has just been added. */
  async focusRow() {
    await this.updateComplete;
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-change-row__row'))?.focus({ preventScroll: true });
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Enter/Space toggle the row, arrows expand/collapse it.
   * @param {KeyboardEvent} e
   */
  #onKeydown(e) {
    const row = this.row;
    if (!row || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') this.#emit('acp-change-toggle', { id: row.id });
    else if (e.key === 'ArrowRight') {
      if (!this.expanded) this.#emit('acp-change-expand', { id: row.id });
    } else if (e.key === 'ArrowLeft' && this.expanded) this.#emit('acp-change-toggle', { id: row.id });
    else return;
    e.preventDefault();
  }

  render() {
    const row = this.row;
    if (!row) return nothing;
    const { file } = row;
    const deleted = file.kind === 'deleted';
    const id = 'acp-change-row';
    return html`<div
        class="acp-change-row__row ${this.expanded ? 'acp-change-row__row_header' : ''}"
        role="treeitem"
        tabindex="0"
        aria-expanded=${String(this.expanded)}
        @click=${() => this.#emit('acp-change-toggle', { id: row.id })}
        @keydown=${this.#onKeydown}
      >
        <md-icon class="acp-change-row__chevron">${unsafeSVG(this.expanded ? expandMoreIcon : chevronRightIcon)}</md-icon>
        ${this.selectable
          ? html`<md-checkbox
              class="acp-change-row__pick"
              aria-label=${`Select ${row.name} for the commit`}
              .checked=${this.picked}
              @click=${(/** @type {Event} */ e) => e.stopPropagation()}
              @change=${(/** @type {Event} */ e) =>
                this.#emit('acp-commit-pick', { ids: [row.id], picked: /** @type {HTMLInputElement} */ (e.target).checked })}
            ></md-checkbox>`
          : nothing}
        <span class="acp-change-row__badge" aria-hidden="true">${git.typeBadge(row.name)}</span>
        <span id="${id}-name" class="acp-change-row__name ${deleted ? 'acp-change-row__name_deleted' : ''}">${row.name}</span>
        <span class="acp-change-row__dir">${row.dir}</span>
        ${file.origPath
          ? html`<span id="${id}-renamed" class="acp-change-row__renamed">(${git.relativePath(row.dir, file.origPath)})</span>`
          : nothing}
        <acp-diff-counts .added=${file.added} .removed=${file.removed}></acp-diff-counts>
        <span class="acp-change-row__spacer"></span>
        <span class="acp-change-row__actions" @click=${(/** @type {Event} */ e) => e.stopPropagation()}>
              <md-icon-button
                class="acp-change-row__action"
                id="${id}-edit"
                aria-label=${`Edit ${row.name}`}
                ?disabled=${deleted}
                @click=${() => this.#emit('acp-change-edit', { id: row.id })}
              >
                <md-icon class="acp-change-row__action-icon">${unsafeSVG(editIcon)}</md-icon>
              </md-icon-button>
              <md-icon-button id="${id}-revert" class="acp-change-row__action" aria-label=${`Revert ${row.name}`} disabled>
                <md-icon class="acp-change-row__action-icon">${unsafeSVG(undoIcon)}</md-icon>
              </md-icon-button>
            </span>
      </div>
      <md-tooltip for="${id}-name" show-delay="800" style="width: max-content; max-inline-size: none">${file.path}</md-tooltip>
      ${file.origPath
        ? html`<md-tooltip for="${id}-renamed" show-delay="800" style="width: max-content; max-inline-size: none"
            >Renamed from ${file.origPath}</md-tooltip
          >`
        : nothing}
      <md-tooltip for="${id}-edit" show-delay="800">Edit</md-tooltip>
      <md-tooltip for="${id}-revert" show-delay="800">${NOT_YET}</md-tooltip>`;
  }
}

customElements.define('acp-change-row', AcpChangeRow);
