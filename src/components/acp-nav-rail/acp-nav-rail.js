import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/badge';
import '@symblight/wc-material/tooltip';
import folderIcon from '@material-design-icons/svg/outlined/folder.svg?raw';
import folderFilledIcon from '@material-design-icons/svg/filled/folder.svg?raw';
import searchIcon from '@material-design-icons/svg/outlined/search.svg?raw';
import searchFilledIcon from '@material-design-icons/svg/filled/search.svg?raw';
import assignmentIcon from '@material-design-icons/svg/outlined/assignment.svg?raw';
import assignmentFilledIcon from '@material-design-icons/svg/filled/assignment.svg?raw';
import notificationsIcon from '@material-design-icons/svg/outlined/notifications.svg?raw';
import notificationsFilledIcon from '@material-design-icons/svg/filled/notifications.svg?raw';
import settingsIcon from '@material-design-icons/svg/outlined/settings.svg?raw';
import styles from './acp-nav-rail.css?inline';

/**
 * A rail button. Toggles (`selectedIcon` set) show a panel; the rest open something once.
 * @typedef {Object} NavRailItem
 * @property {string} name
 * @property {string} label
 * @property {string} icon Outlined SVG.
 * @property {string} [selectedIcon] Filled SVG, shown while pressed.
 * @property {string} [shortcut]
 * @property {string} [event] Dispatched (bubbling, composed) on click.
 */

/** @type {NavRailItem[]} */
const TOP_ITEMS = [
  { name: 'files', label: 'Files', icon: folderIcon, selectedIcon: folderFilledIcon, event: 'acp-show-files' },
  {
    name: 'search',
    label: 'Search',
    icon: searchIcon,
    selectedIcon: searchFilledIcon,
    shortcut: '⌘⇧F',
    event: 'acp-find-in-files',
  },
  {
    name: 'changes',
    label: 'Changes',
    icon: assignmentIcon,
    selectedIcon: assignmentFilledIcon,
    event: 'acp-show-changes',
  },
];

/** @type {NavRailItem[]} */
const BOTTOM_ITEMS = [
  { name: 'notifications', label: 'Notifications', icon: notificationsIcon, selectedIcon: notificationsFilledIcon },
  { name: 'settings', label: 'Settings', icon: settingsIcon, event: 'acp-show-settings' },
];

/**
 * @tag acp-nav-rail
 * @summary Narrow icon-only rail of panel toggles (top) and notifications/settings (bottom).
 * @fires acp-show-files
 * @fires acp-find-in-files
 * @fires acp-show-changes
 * @fires acp-show-settings
 */
export class AcpNavRail extends LitElement {
  static properties = {
    selected: {},
    unread: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string | null} Name of the pressed toggle. */
    this.selected = null;
    /** @type {boolean} Shows the badge on Notifications. */
    this.unread = false;
  }

  /** @param {string} type */
  #dispatch(type) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  }

  /** @param {NavRailItem} item */
  #renderItem(item) {
    const id = `acp-nav-rail-${item.name}`;
    const selected = this.selected === item.name;
    const badge = item.name === 'notifications' && this.unread;
    const tooltip = item.shortcut ? `${item.label} ${item.shortcut}` : item.label;
    return html`
      <div class="acp-nav-rail__item">
        <md-icon-button
          id=${id}
          class="acp-nav-rail__button"
          aria-label=${badge ? `${item.label}, unread` : item.label}
          ?toggle=${!!item.selectedIcon}
          ?selected=${selected}
          @click=${item.event ? () => this.#dispatch(/** @type {string} */ (item.event)) : nothing}
        >
          <md-icon class="acp-nav-rail__icon">${unsafeSVG(item.icon)}</md-icon>
          ${item.selectedIcon
            ? html`<md-icon slot="selected" class="acp-nav-rail__icon">${unsafeSVG(item.selectedIcon)}</md-icon>`
            : nothing}
        </md-icon-button>
        ${badge
          ? html`<md-badge
              class="acp-nav-rail__badge ${selected ? 'acp-nav-rail__badge_on-selected' : ''}"
            ></md-badge>`
          : nothing}
        <md-tooltip for=${id} show-delay="800" placement="left" offset="16">${tooltip}</md-tooltip>
      </div>
    `;
  }

  render() {
    return html`
      <nav class="acp-nav-rail" aria-label="Workspace">
        ${TOP_ITEMS.map((item) => this.#renderItem(item))}
        <span class="acp-nav-rail__spacer"></span>
        ${BOTTOM_ITEMS.map((item) => this.#renderItem(item))}
      </nav>
    `;
  }
}

customElements.define('acp-nav-rail', AcpNavRail);
