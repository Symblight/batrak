import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import collapseIcon from '@material-design-icons/svg/outlined/expand_less.svg?raw';
import expandIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import moreIcon from '@material-design-icons/svg/outlined/more_vert.svg?raw';
import pinIcon from '@material-design-icons/svg/outlined/push_pin.svg?raw';
import '../datetime/datetime.js';
import '../session-status/session-status.js';
import styles from './session-row-trailing.css?inline';

/** @typedef {import('../../hooks/sessions/types.js').Session} Session */

/**
 * @tag acp-session-row-trailing
 * @summary The end of a chat's row in the session list: pinned mark, worktree branch, age and status; while the row is hovered (`--acp-session-row-trailing-rest` / `-actions`) or its menu is open, Mark as read (unread only), Pin and the menu button instead; a chevron with subagents.
 * @fires acp-session-mark-read `{ sessionId, read }` Its check: always `read: true`.
 * @fires acp-session-pin `{ sessionId, pinned }`
 * @fires acp-session-row-menu `{ session, anchor }` Its menu is wanted under its button.
 * @fires acp-session-row-toggle `{ sessionId, expanded }` Its chevron: show or hide its subagents.
 */
export class AcpSessionRowTrailing extends LitElement {
  static properties = {
    session: { attribute: false },
    pinned: { type: Boolean },
    unread: { type: Boolean },
    waiting: { type: Boolean },
    menuOpen: { type: Boolean, attribute: 'menu-open', reflect: true },
    subagents: { type: Number },
    expanded: { type: Boolean },
    now: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Session | null} */
    this.session = null;
    /** @type {boolean} */
    this.pinned = false;
    /** @type {boolean} Offers Mark as read. */
    this.unread = false;
    /** @type {boolean} A permission request of it waits for the user. */
    this.waiting = false;
    /** @type {boolean} Its menu is open: the buttons stay. */
    this.menuOpen = false;
    /** @type {number} How many subagents it has. */
    this.subagents = 0;
    /** @type {boolean} Its subagents show under it. */
    this.expanded = false;
    /** @type {number} The time, ms: a session active in another app shows so until its time is up. */
    this.now = Date.now();
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * A button of the row: its clicks stay its own, a quick second one doesn't open the chat.
   * @param {{ id: string, name: string, label: string, tooltip: string, icon: string, onClick: (button: HTMLElement) => void }} button
   */
  #renderButton({ id, name, label, tooltip, icon, onClick }) {
    /** @param {Event} e */
    const own = (e) => e.stopPropagation();
    return html`<md-icon-button
        id=${id}
        class="acp-session-row-trailing__button acp-session-row-trailing__${name}"
        aria-label=${label}
        @click=${(/** @type {Event} */ e) => {
          e.stopPropagation();
          onClick(/** @type {HTMLElement} */ (e.currentTarget));
        }}
        @dblclick=${own}
      >
        <md-icon class="acp-session-row-trailing__button-icon">${unsafeSVG(icon)}</md-icon>
      </md-icon-button>
      <md-tooltip for=${id} show-delay="800">${tooltip}</md-tooltip>`;
  }

  /** @param {Session} session */
  #renderActions(session) {
    const pin = this.pinned ? 'Unpin' : 'Pin';
    const sessionId = session.id;
    return html`<span class="acp-session-row-trailing__actions">
      ${this.unread
        ? this.#renderButton({
            id: 'acp-session-row-trailing-mark-read',
            name: 'mark-read',
            label: `Mark as read: ${session.title}`,
            tooltip: 'Mark as read',
            icon: checkIcon,
            onClick: () => this.#emit('acp-session-mark-read', { sessionId, read: true }),
          })
        : nothing}
      ${this.#renderButton({
        id: 'acp-session-row-trailing-pin',
        name: 'pin',
        label: `${pin}: ${session.title}`,
        tooltip: pin,
        icon: pinIcon,
        onClick: () => this.#emit('acp-session-pin', { sessionId, pinned: !this.pinned }),
      })}
      ${this.#renderButton({
        id: 'acp-session-row-trailing-more',
        name: 'more',
        label: `Session menu: ${session.title}`,
        tooltip: 'Session menu',
        icon: moreIcon,
        onClick: (anchor) => this.#emit('acp-session-row-menu', { session, anchor }),
      })}
    </span>`;
  }

  /** @param {Session} session */
  #renderRest(session) {
    return html`<span class="acp-session-row-trailing__rest">
      ${this.pinned
        ? html`<md-icon id="acp-session-row-trailing-pinned" class="acp-session-row-trailing__pinned" aria-label="Pinned">${unsafeSVG(pinIcon)}</md-icon>
            <md-tooltip for="acp-session-row-trailing-pinned" show-delay="800">Pinned</md-tooltip>`
        : nothing}
      ${session.branch
        ? html`<md-icon id="acp-session-row-trailing-branch" class="acp-session-row-trailing__branch" aria-label="Worktree">${unsafeSVG(branchIcon)}</md-icon>
            <md-tooltip for="acp-session-row-trailing-branch" show-delay="800">Worktree on ${session.branch}</md-tooltip>`
        : nothing}
      <acp-datetime class="acp-session-row-trailing__age" .value=${session.lastActivityAt} .now=${this.now} format="compact"></acp-datetime>
      <!-- An idle terminal session looks like any other in the list (quiet); the header still says it. -->
      <acp-session-status
        class="acp-session-row-trailing__status"
        .session=${session}
        .permissionPending=${this.waiting}
        .now=${this.now}
        quiet
      ></acp-session-status>
    </span>`;
  }

  render() {
    const session = this.session;
    if (!session) return nothing;
    return html`${this.#renderRest(session)}${this.#renderActions(session)}
    ${this.subagents > 0
      ? this.#renderButton({
          id: 'acp-session-row-trailing-toggle',
          name: 'toggle',
          label: `${this.expanded ? 'Hide' : 'Show'} ${this.subagents} subagent${this.subagents === 1 ? '' : 's'}`,
          tooltip: `${this.expanded ? 'Hide' : 'Show'} ${this.subagents} subagent${this.subagents === 1 ? '' : 's'}`,
          icon: this.expanded ? collapseIcon : expandIcon,
          onClick: () => this.#emit('acp-session-row-toggle', { sessionId: session.id, expanded: !this.expanded }),
        })
      : nothing}`;
  }
}

customElements.define('acp-session-row-trailing', AcpSessionRowTrailing);
