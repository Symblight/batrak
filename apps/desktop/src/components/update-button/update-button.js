import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/progress-linear';
import '@symblight/wc-material/tooltip';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import errorIcon from '@material-design-icons/svg/outlined/error.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import openInNewIcon from '@material-design-icons/svg/outlined/open_in_new.svg?raw';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import restartIcon from '@material-design-icons/svg/outlined/restart_alt.svg?raw';
import scheduleIcon from '@material-design-icons/svg/outlined/schedule.svg?raw';
import updateIcon from '@material-design-icons/svg/outlined/system_update_alt.svg?raw';
import { downloadProgress } from '../../hooks/app-update/rules.js';
import styles from './update-button.css?inline';

/** @typedef {import('../../hooks/app-update/types.js').AppUpdateState} AppUpdateState */

const BUTTON_ID = 'acp-update-button-button';

/**
 * The menu's values, as what each fires.
 * @type {Readonly<Record<string, string>>}
 */
const EVENTS = Object.freeze({
  download: 'acp-update-download',
  retry: 'acp-update-download',
  cancel: 'acp-update-cancel',
  restart: 'acp-update-restart',
  manual: 'acp-update-manual',
});

/**
 * @tag acp-update-button
 * @summary The toolbar's update button and its menu: nothing without an update, then what can be done about it in each state.
 * @fires acp-update-download `null` Update and Restart, or Retry.
 * @fires acp-update-cancel `null`
 * @fires acp-update-restart `null`
 * @fires acp-update-on-next-launch `{ on }`
 * @fires acp-update-manual `null` Download manually.
 */
export class AcpUpdateButton extends LitElement {
  static properties = {
    state: { attribute: false },
    open: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {AppUpdateState} */
    this.state = { state: 'none' };
    /** @type {boolean} */
    this.open = false;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Event} e */
  #onSelect = (e) => {
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (value === 'on-next-launch') {
      this.#emit('acp-update-on-next-launch', { on: !(this.state.state === 'ready' && this.state.onNextLaunch) });
    } else this.#emit(EVENTS[value], null);
  };

  /** A menu gone with its state can't say it closed. */
  willUpdate() {
    if (this.state.state === 'none' || this.state.state === 'updated' || this.state.state === 'installing') this.open = false;
  }

  /** @param {number | null} percent `null` with no known total: a spinner. */
  #renderProgress(percent) {
    return percent === null
      ? html`<span class="acp-update-button__spinner"></span>`
      : html`<md-progress-circular class="acp-update-button__ring" .value=${percent / 100}></md-progress-circular>`;
  }

  /** @param {string} icon */
  #renderIcon(icon) {
    return html`<md-icon class="acp-update-button__icon">${unsafeSVG(icon)}</md-icon>`;
  }

  /**
   * The button's look in this state.
   * @param {Exclude<AppUpdateState, { state: 'none' | 'updated' | 'installing' }>} state
   */
  #face(state) {
    switch (state.state) {
      case 'available':
        return {
          tone: 'tonal',
          name: `Update ${state.version}`,
          leading: this.#renderIcon(updateIcon),
          text: html`Update <span class="acp-update-button__version">${state.version}</span>`,
        };
      case 'downloading': {
        const { percent } = downloadProgress(state.received, state.total);
        const name = percent === null ? 'Updating…' : `Updating… ${percent}%`;
        return { tone: 'quiet', name, leading: this.#renderProgress(percent), text: name };
      }
      case 'ready':
        return { tone: state.onNextLaunch ? 'quiet' : 'tonal', name: 'Restart to update', leading: this.#renderIcon(restartIcon), text: 'Restart to update' };
      case 'failed':
        return { tone: 'error', name: 'Update failed', leading: this.#renderIcon(errorIcon), text: 'Update failed' };
    }
  }

  /**
   * @param {string} value
   * @param {string} icon
   * @param {string} label
   * @param {{ primary?: boolean, selected?: boolean, trailing?: string | null }} [options]
   */
  #renderItem(value, icon, label, { primary = false, selected = false, trailing = null } = {}) {
    return html`<md-menu-item
      class="acp-update-button__item ${primary ? 'acp-update-button__item_primary' : ''}"
      value=${value}
      ?selected=${selected}
    >
      <md-icon slot="leading">${unsafeSVG(icon)}</md-icon>
      ${label} ${trailing !== null ? html`<span slot="trailing">${trailing}</span>` : nothing}
    </md-menu-item>`;
  }

  /**
   * @param {string} title
   * @param {string} [detail]
   * @param {unknown} [progress]
   */
  #renderHeader(title, detail, progress = nothing) {
    return html`<md-item-group>
      <div class="acp-update-button__header">
        <span class="acp-update-button__title">${title}</span>
        ${detail ? html`<span class="acp-update-button__detail">${detail}</span>` : nothing} ${progress}
      </div>
    </md-item-group>`;
  }

  /** @param {Exclude<AppUpdateState, { state: 'none' | 'updated' | 'installing' }>} state */
  #renderMenuContent(state) {
    switch (state.state) {
      case 'available':
        return html`${this.#renderHeader(`Batrak ${state.version} available`, `${state.current} → ${state.version}`)}
          <md-item-group>
            ${state.manual
              ? this.#renderItem('manual', openInNewIcon, 'Download manually', { primary: true })
              : this.#renderItem('download', restartIcon, 'Update and Restart', { primary: true })}
          </md-item-group>`;
      case 'downloading': {
        const { percent, size } = downloadProgress(state.received, state.total);
        const bar = html`<md-progress-linear
          class="acp-update-button__bar"
          aria-label="Download progress"
          .value=${percent === null ? undefined : percent / 100}
        ></md-progress-linear>`;
        return html`${this.#renderHeader(`Downloading ${state.version}…`, size, bar)}
          <md-item-group>
            ${this.#renderItem('cancel', closeIcon, 'Cancel download', { trailing: percent === null ? null : `${percent}%` })}
          </md-item-group>`;
      }
      case 'ready':
        return html`${this.#renderHeader(`Batrak ${state.version} is ready`, 'restart to finish the update')}
          <md-item-group>
            ${this.#renderItem('restart', restartIcon, 'Restart to update', { primary: true })}
            ${this.#renderItem('on-next-launch', state.onNextLaunch ? checkIcon : scheduleIcon, 'Update on next launch', { selected: state.onNextLaunch })}
          </md-item-group>`;
      case 'failed':
        return html`${this.#renderHeader(`Update failed: ${state.reason}`)}
          <md-item-group>
            ${this.#renderItem('retry', refreshIcon, 'Retry', { primary: true })}
            ${this.#renderItem('manual', openInNewIcon, 'Download manually')}
          </md-item-group>`;
    }
  }

  render() {
    const state = this.state;
    if (state.state === 'none' || state.state === 'updated') return nothing;
    if (state.state === 'installing') {
      return html`<div class="acp-update-button__status" role="status">${this.#renderProgress(null)} Installing…</div>`;
    }
    const face = this.#face(state);
    return html`<md-button
        id=${BUTTON_ID}
        class="acp-update-button__button acp-update-button__button_${face.tone}"
        variant="text"
        aria-label=${face.name}
        aria-haspopup="menu"
        aria-expanded=${this.open ? 'true' : 'false'}
      >
        <span class="acp-update-button__label">
          ${face.leading} <span class="acp-update-button__text">${face.text}</span>
          <md-icon class="acp-update-button__arrow">${unsafeSVG(expandMoreIcon)}</md-icon>
        </span>
      </md-button>
      ${state.state === 'available'
        ? html`<md-tooltip class="acp-update-button__tooltip" for=${BUTTON_ID} show-delay="800" placement="bottom"
            >Batrak ${state.version} available · click for options</md-tooltip
          >`
        : nothing}
      <md-menu
        class="acp-update-button__menu"
        for=${BUTTON_ID}
        placement="bottom-end"
        aria-label="Update"
        @select=${this.#onSelect}
        @opening=${() => (this.open = true)}
        @closing=${() => (this.open = false)}
      >
        ${this.#renderMenuContent(state)}
      </md-menu>`;
  }
}

customElements.define('acp-update-button', AcpUpdateButton);
