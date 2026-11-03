import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/skeleton';
import '../session-menu/session-menu.js';
import '../session-row/session-row.js';
import '../subagent-tree/subagent-tree.js';
import { TreeNavigationController } from '../../controllers/tree-navigation/TreeNavigationController.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import styles from './session-list.css?inline';

const { SESSIONS_PAGE, orderSessions, unreadIn, visibleSessions } = sessions;

/** @typedef {import('../session-row/session-row.js').AcpSessionRow} AcpSessionRow */
/** @typedef {import('../../controllers/tree-navigation/TreeNavigationController.js').TreeNode} TreeNode */
/** @typedef {import('../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../hooks/sessions/types.js').Subagent} Subagent */

/**
 * @tag acp-session-list
 * @summary One workspace's chats (each with its subagents' tree under it), pinned first, then by last activity (five, and five more with each Show more, which counts the unread behind it; skeleton rows while they load) with their status, branch and age; a row's menu button, right-click or Shift+F10 opens the session menu, F2 or a double-click renames it in place.
 * @fires acp-session-select `{ sessionId }`
 * @fires acp-session-rename `{ sessionId, title }` A new title, trimmed, not empty and not the current one.
 * @fires acp-session-mark-read `{ sessionId, read }` Mark as read (`read: true`) or as unread.
 * @fires acp-session-reset-title `{ sessionId }`
 * @fires acp-session-reveal `{ sessionId }`
 * @fires acp-session-open-terminal `{ sessionId }` Open in → Terminal.
 * @fires acp-session-delete `{ sessionId }`
 * @fires acp-subagent-open `{ sessionId, subagentId }` From a chat's `<acp-subagent-tree>`.
 */
export class AcpSessionList extends LitElement {
  static properties = {
    sessions: { attribute: false },
    activeSessionId: { attribute: false },
    pinned: { attribute: false },
    unread: { attribute: false },
    waiting: { attribute: false },
    subagents: { attribute: false },
    activeSubagentId: { attribute: false },
    loading: { type: Boolean },
    now: { attribute: false },
    limit: { state: true },
  };

  static styles = styles;

  /** @type {ContextMenuController<Session>} */
  #sessionMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('acp-session-menu')?.menu ?? null,
    // `<acp-session-menu>` reports picks as its own event (#onSessionMenuSelect).
    onSelect: () => {},
  });

  /** A flat tree: one Tab stop, the arrows walk the rows. */
  #tree = new TreeNavigationController(this, {
    nodes: () =>
      [...this.renderRoot.querySelectorAll('acp-session-row')].flatMap((row) =>
        row.session ? [{ key: row.session.id, el: row, label: row.session.title, parent: null, expanded: null }] : [],
      ),
  });

  constructor() {
    super();
    /** @type {readonly Session[]} The workspace's chats, in any order. */
    this.sessions = [];
    /** @type {string | null} */
    this.activeSessionId = null;
    /** @type {readonly string[]} Session ids. */
    this.pinned = [];
    /** @type {readonly string[]} Sessions with output not seen yet. */
    this.unread = [];
    /** @type {readonly string[]} Sessions with a permission request waiting for the user. */
    this.waiting = [];
    /** @type {Readonly<Record<string, readonly Subagent[]>>} Each chat's subagents, by session id. */
    this.subagents = {};
    /** @type {string | null} The subagent whose chat is shown (of the active session). */
    this.activeSubagentId = null;
    /** @type {boolean} The chats are loading: skeleton rows while there are none to show yet. */
    this.loading = false;
    /** @type {number} The time, ms: a session active in another app shows so until its time is up. */
    this.now = Date.now();
    /** @type {number} How many chats show (`SESSIONS_PAGE` until Show more). */
    this.limit = SESSIONS_PAGE;
  }

  /**
   * @param {string} type
   * @param {object | null} [detail]
   */
  #emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Event} e A row wants its menu: at a point, or under its button. */
  #onSessionRowMenu(e) {
    e.stopPropagation();
    const { session, x, y, anchor } = /** @type {CustomEvent<{ session: Session, x?: number, y?: number, anchor?: HTMLElement }>} */ (e).detail;
    if (anchor) this.#sessionMenu.openFrom(session, anchor);
    else this.#sessionMenu.open(session, /** @type {number} */ (x), /** @type {number} */ (y));
  }

  /** @param {Event} e */
  #onSessionMenuSelect(e) {
    e.stopPropagation();
    const session = this.#sessionMenu.target;
    if (!session) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    const sessionId = session.id;
    if (value === 'mark-read' || value === 'mark-unread') {
      this.#emit('acp-session-mark-read', { sessionId, read: value === 'mark-read' });
    } else if (value === 'rename') {
      /** @type {HTMLElementTagNameMap['acp-session-row'] | null} */ (
        this.renderRoot.querySelector(`acp-session-row[data-session-id="${CSS.escape(sessionId)}"]`)
      )?.startRename();
    } else if (value === 'reset-title' || value === 'reveal' || value === 'open-terminal' || value === 'delete')
      this.#emit(`acp-session-${value}`, { sessionId });
  }

  /** @param {Event} e */
  #onSessionMenuClosed(e) {
    e.stopPropagation();
    this.#sessionMenu.onClosed();
  }

  /** Rows the shape of session rows, while the chats load. */
  #renderLoading() {
    return html`<div class="acp-session-list__loading" role="status" aria-label="Loading chats" aria-busy="true">
      ${['70%', '55%', '62%'].map(
        (width) => html`<div class="acp-session-list__skeleton-row">
          <md-skeleton class="acp-session-list__skeleton-title" style=${`width: ${width}`}></md-skeleton>
          <md-skeleton class="acp-session-list__skeleton-age"></md-skeleton>
        </div>`,
      )}
    </div>`;
  }

  /**
   * The chats down to the limit, then Show more for the next `SESSIONS_PAGE`.
   * @param {Session[]} sessions In order.
   */
  #renderSessions(sessions) {
    const { shown, hidden } = visibleSessions(sessions, this.limit, this.activeSessionId);
    const unreadBehind = unreadIn(sessions, this.unread, shown.length).hidden;
    return html`${repeat(shown, (s) => s.id, (s) => this.#renderSession(s))}
      ${hidden > 0
        ? html`<div class="acp-session-list__more"><md-button
            class="acp-session-list__show-more"
            variant="text"
            aria-label=${`Show more chats${unreadBehind > 0 ? `, ${unreadBehind} unread` : ''}`}
            @click=${() => (this.limit = shown.length + SESSIONS_PAGE)}
            >Show more…</md-button
          >
          ${unreadBehind > 0
            ? html`<span class="acp-session-list__show-more-new" aria-hidden="true">
                <span class="acp-session-list__show-more-dot"></span>${unreadBehind} new
              </span>`
            : nothing}</div>`
        : nothing}`;
  }

  /** @param {Session} session */
  #renderSession(session) {
    return html`<acp-session-row
      data-session-id=${session.id}
      .session=${session}
      .selected=${session.id === this.activeSessionId}
      .pinned=${this.pinned.includes(session.id)}
      .unread=${this.unread.includes(session.id)}
      .waiting=${this.waiting.includes(session.id)}
      .menuOpen=${this.#sessionMenu.target?.id === session.id}
      .now=${this.now}
      @acp-session-row-menu=${this.#onSessionRowMenu}
    ></acp-session-row>${this.#renderSubagents(session)}`;
  }

  /**
   * The chat's subagents: a tree of its own, outside the list's arrow-key walk.
   * @param {Session} session
   */
  #renderSubagents(session) {
    const subagents = this.subagents[session.id];
    if (!subagents?.length) return nothing;
    /** @param {Event} e */
    const ownKeys = (e) => e.stopPropagation();
    return html`<acp-subagent-tree
      class="acp-session-list__subagents"
      .sessionId=${session.id}
      .subagents=${subagents}
      .activeSubagentId=${session.id === this.activeSessionId ? this.activeSubagentId : null}
      .now=${this.now}
      @keydown=${ownKeys}
      @focusin=${ownKeys}
    ></acp-subagent-tree>`;
  }

  /**
   * @param {Session | null} target The session the menu is open for.
   * @returns {'read' | 'unread' | ''} The shown session is read while it is seen, so it never offers Mark as unread.
   */
  #markOf(target) {
    if (target === null) return '';
    if (this.unread.includes(target.id)) return 'read';
    return target.id === this.activeSessionId ? '' : 'unread';
  }

  render() {
    const target = this.#sessionMenu.target;
    const ordered = orderSessions([...this.sessions], this.pinned);
    return html`
      <div class="acp-session-list__list" role="tree" aria-label="Chats" @keydown=${this.#tree.onKeydown} @focusin=${this.#tree.onFocusin}>
        ${ordered.length > 0
          ? this.#renderSessions(ordered)
          : this.loading
            ? this.#renderLoading()
            : html`<div class="acp-session-list__empty">No chats yet</div>`}
      </div>
      <acp-session-menu
        session-title=${target?.title ?? ''}
        .mark=${this.#markOf(target)}
        ?resettable=${target !== null && target.titleSource === 'user' && target.agentTitle !== null}
        @acp-session-menu-select=${this.#onSessionMenuSelect}
        @acp-session-menu-toggle=${(/** @type {Event} */ e) => e.stopPropagation()}
        @acp-session-menu-closed=${this.#onSessionMenuClosed}
      ></acp-session-menu>
    `;
  }
}

customElements.define('acp-session-list', AcpSessionList);
