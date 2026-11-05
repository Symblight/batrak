import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/tree-view';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/skeleton';
import '@symblight/wc-material/tooltip';
import expandIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import '../agent-icon/agent-icon.js';
import '../datetime/datetime.js';
import '../session-menu/session-menu.js';
import '../session-row-trailing/session-row-trailing.js';
import '../subagent-status/subagent-status.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import styles from './session-list.css?inline';

const { SESSIONS_PAGE, SUBAGENT_INDICATOR_LABELS, orderSessions, splitByRead, subagentIndicator, subagentLabel, visibleSessions } = sessions;

/** @typedef {import('../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../hooks/sessions/types.js').Subagent} Subagent */
/** @typedef {{ kind: 'subagent', id: string, label: string, sessionId: string, subagent: Subagent }} SubagentItem */
/** @typedef {{ kind: 'session', id: string, label: string, session: Session, children?: SubagentItem[] }} SessionItem */
/** @typedef {{ kind: 'more', id: string, label: string }} MoreItem */
/** @typedef {{ kind: 'folder', id: string, label: string, count: number, children: (SessionItem | MoreItem)[] }} FolderItem */
/** @typedef {FolderItem | SessionItem | SubagentItem | MoreItem} ListItem */

const UNREAD_FOLDER = 'folder:unread';
const READ_FOLDER = 'folder:read';
const SHOW_MORE = 'more:read';

/**
 * @param {string} sessionId
 * @param {string} subagentId
 * @returns {string} Its row's id: a subagent's id is only unique within its chat.
 */
function subagentKey(sessionId, subagentId) {
  return `${sessionId}/${subagentId}`;
}

/**
 * @tag acp-session-list
 * @summary One workspace's chats as a tree: Unread and Read folders (none shown while empty), pinned first, then by last activity; Read shows five, and five more with each Show more, its last row; a chat with subagents is their parent. A click selects a row, a double-click or Enter opens it, and the open row keeps a lighter highlight while another is selected; a row's menu button, right-click or Shift+F10 opens the session menu, F2 renames it in place.
 * @fires acp-session-select `{ sessionId }` A chat opened.
 * @fires acp-session-rename `{ sessionId, title }` A new title, trimmed, not empty and not the current one.
 * @fires acp-session-mark-read `{ sessionId, read }` Mark as read (`read: true`) or as unread.
 * @fires acp-session-pin `{ sessionId, pinned }`
 * @fires acp-session-reset-title `{ sessionId }`
 * @fires acp-session-reveal `{ sessionId }`
 * @fires acp-session-open-terminal `{ sessionId }` Open in → Terminal.
 * @fires acp-session-delete `{ sessionId }`
 * @fires acp-subagent-open `{ sessionId, subagentId }` A subagent's chat opened.
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
    closed: { state: true },
  };

  static styles = styles;

  /** @type {ContextMenuController<Session>} */
  #sessionMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('acp-session-menu')?.menu ?? null,
    // `<acp-session-menu>` reports picks as its own event (#onSessionMenuSelect).
    onSelect: () => {},
  });

  /** @type {Set<PropertyKey>} The selected row, one set per selection so a render doesn't reassign it. */
  #selection = new Set();

  /** @type {string[]} The rows with children, as last rendered. */
  #branches = [];

  /** The tree is changed from `closed`, so its `tvx-expand-change` isn't written back. */
  #syncing = false;

  /** @type {Promise<void>} Until the tree shows what `closed` says. */
  #synced = Promise.resolve();

  /** The keys the list answers before the tree does: Enter on a chat opens it, where the tree would toggle it. */
  #onKeydown = { handleEvent: (/** @type {KeyboardEvent} */ e) => this.#handleKey(e), capture: true };

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
    /** @type {number} How many read chats show (`SESSIONS_PAGE` until Show more). */
    this.limit = SESSIONS_PAGE;
    /** @type {ReadonlySet<string>} Rows the user closed: those stay closed; the others open as they appear. */
    this.closed = new Set();
  }

  get #tree() {
    return this.renderRoot.querySelector('tvx-tree-view');
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (!changed.has('activeSessionId') && !changed.has('activeSubagentId')) return;
    const open = this.#openId;
    this.#selection = new Set(open === null ? [] : [open]);
  }

  /** @returns {string | null} The row of the chat shown: a subagent's, or its chat's. */
  get #openId() {
    const session = this.activeSessionId;
    if (session === null) return null;
    return this.activeSubagentId === null ? session : subagentKey(session, this.activeSubagentId);
  }

  updated() {
    this.#synced = this.#syncExpansion();
  }

  /** @returns {Promise<boolean>} */
  async getUpdateComplete() {
    const done = await super.getUpdateComplete();
    await this.#synced;
    return done;
  }

  /** Opens the rows the user hasn't closed; it takes the tree's new items first, a branch needs its children. */
  async #syncExpansion() {
    const tree = this.#tree;
    if (!tree) return;
    await tree.updateComplete;
    this.#syncing = true;
    tree.expansion.set(this.#branches.filter((id) => !this.closed.has(id)));
    this.#syncing = false;
    await tree.updateComplete;
  }

  /**
   * @param {string} type
   * @param {object | null} [detail]
   */
  #emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * @param {string} id
   * @param {boolean} open
   */
  #setOpen(id, open) {
    const next = new Set(this.closed);
    if (open) next.delete(id);
    else next.add(id);
    this.closed = next;
  }

  /**
   * @param {Event} e
   * @returns {ListItem | null} The item of the row it came from.
   */
  #itemOf(e) {
    const tree = this.#tree;
    const id = tree?.nodes.getIdFromEvent(e) ?? null;
    return id === null ? null : /** @type {ListItem | null} */ (tree?.nodes.getItem(id) ?? null);
  }

  /** @param {ListItem} item A chat's or a subagent's row: its chat shows. */
  #open(item) {
    if (item.kind === 'session') this.#emit('acp-session-select', { sessionId: item.session.id });
    else if (item.kind === 'subagent') this.#emit('acp-subagent-open', { sessionId: item.sessionId, subagentId: item.subagent.id });
  }

  /** Shows the next page of Read, focus on its first row (Show more itself may go). */
  async #showMore() {
    const { read } = splitByRead(orderSessions([...this.sessions], this.pinned), this.unread);
    const { shown } = visibleSessions(read, this.limit, this.activeSessionId);
    this.limit = shown.length + SESSIONS_PAGE;
    await this.updateComplete;
    const next = read[shown.length];
    if (next) await this.#tree?.navigation.focusItem(next.id);
  }

  /** @param {KeyboardEvent} e */
  #handleKey(e) {
    const item = this.#itemOf(e);
    // A key of a row's button, or of the rename field, stays theirs.
    const origin = /** @type {HTMLElement} */ (e.composedPath()[0]);
    if (!item || origin.getAttribute?.('role') !== 'treeitem') return;
    if (item.kind === 'session' && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      const rect = origin.getBoundingClientRect();
      this.#sessionMenu.open(item.session, rect.left + 24, rect.bottom);
    } else if (item.kind === 'session' && e.key === 'F2') this.#tree?.editing.start(item.id);
    else if (item.kind !== 'folder' && e.key === 'Enter') {
      if (item.kind === 'more') this.#showMore();
      else this.#open(item);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** @param {Event} e */
  #onClick = (e) => {
    const item = this.#itemOf(e);
    if (item?.kind === 'folder') this.#tree?.expansion.toggle(item.id);
    else if (item?.kind === 'more') this.#showMore();
  };

  /** @param {Event} e */
  #onDblclick = (e) => {
    const item = this.#itemOf(e);
    if (item) this.#open(item);
  };

  /** @param {MouseEvent} e */
  #onContextMenu = (e) => {
    const item = this.#itemOf(e);
    if (item?.kind !== 'session') return;
    e.preventDefault();
    e.stopPropagation();
    this.#sessionMenu.open(item.session, e.clientX, e.clientY);
  };

  /** @param {Event} e Only chats and subagents hold the selection. */
  #onSelectionChange = (e) => {
    const [picked] = /** @type {CustomEvent<{ selectedItems: Set<PropertyKey> }>} */ (e).detail.selectedItems;
    if (picked === undefined || this.#selection.has(picked)) return;
    const tree = this.#tree;
    const item = /** @type {ListItem | null} */ (tree?.nodes.getItem(picked) ?? null);
    if (item?.kind === 'session' || item?.kind === 'subagent') this.#selection = new Set([picked]);
    else tree?.selection.set(this.#selection);
  };

  /** @param {Event} e */
  #onExpandChange = (e) => {
    if (this.#syncing) return;
    const { id, expanded } = /** @type {CustomEvent<{ id: string, expanded: boolean }>} */ (e).detail;
    this.#setOpen(id, expanded);
  };

  /** @param {Event} e */
  #onLabelChange = (e) => {
    const { id, newLabel } = /** @type {CustomEvent<{ id: string, newLabel: string }>} */ (e).detail;
    this.#emit('acp-session-rename', { sessionId: id, title: newLabel });
  };

  /** @param {Event} e A row's chevron. */
  #onRowToggle(e) {
    e.stopPropagation();
    const { sessionId, expanded } = /** @type {CustomEvent<{ sessionId: string, expanded: boolean }>} */ (e).detail;
    this.#setOpen(sessionId, expanded);
  }

  /** @param {Event} e A row wants its menu under its button. */
  #onSessionRowMenu(e) {
    e.stopPropagation();
    const { session, anchor } = /** @type {CustomEvent<{ session: Session, anchor: HTMLElement }>} */ (e).detail;
    this.#sessionMenu.openFrom(session, anchor);
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
    } else if (value === 'pin' || value === 'unpin') {
      this.#emit('acp-session-pin', { sessionId, pinned: value === 'pin' });
    } else if (value === 'rename') {
      this.#tree?.editing.start(sessionId);
    } else if (value === 'reset-title' || value === 'reveal' || value === 'open-terminal' || value === 'delete')
      this.#emit(`acp-session-${value}`, { sessionId });
  }

  /** @param {Event} e */
  #onSessionMenuClosed(e) {
    e.stopPropagation();
    this.#sessionMenu.onClosed();
  }

  /**
   * @param {Session} session
   * @returns {SessionItem}
   */
  #sessionItem(session) {
    const subagents = this.subagents[session.id];
    return {
      kind: 'session',
      id: session.id,
      label: session.title,
      session,
      children: subagents?.length
        ? subagents.map((subagent) => ({
            kind: 'subagent',
            id: subagentKey(session.id, subagent.id),
            label: subagentLabel(subagent),
            sessionId: session.id,
            subagent,
          }))
        : undefined,
    };
  }

  /** @returns {FolderItem[]} The folders with chats in them, Read down to the limit. */
  #items() {
    const { unread, read } = splitByRead(orderSessions([...this.sessions], this.pinned), this.unread);
    const { shown, hidden } = visibleSessions(read, this.limit, this.activeSessionId);
    /** @type {FolderItem[]} */
    const folders = [];
    if (unread.length > 0) {
      folders.push({ kind: 'folder', id: UNREAD_FOLDER, label: 'Unread', count: unread.length, children: unread.map((s) => this.#sessionItem(s)) });
    }
    if (read.length > 0) {
      /** @type {(SessionItem | MoreItem)[]} */
      const children = shown.map((s) => this.#sessionItem(s));
      if (hidden > 0) children.push({ kind: 'more', id: SHOW_MORE, label: 'Show more…' });
      folders.push({ kind: 'folder', id: READ_FOLDER, label: 'Read', count: read.length, children });
    }
    return folders;
  }

  /**
   * A chat row's accessible name: title, agent, unread, pinned, worktree, age and status.
   * @param {Session} session
   */
  #name(session) {
    const now = this.now;
    // The same status the row's `<acp-session-status quiet>` shows.
    const indicator = sessions.sessionIndicator(
      session.status,
      this.waiting.includes(session.id),
      sessions.isActiveElsewhere(session, now),
      session.inTerminal === true,
      session.activity,
    );
    return [
      session.title,
      session.agentName ?? session.agentId,
      session.id === this.#openId && 'open',
      this.unread.includes(session.id) && 'unread',
      this.pinned.includes(session.id) && 'pinned',
      session.branch && `worktree on ${session.branch}`,
      sessions.ageLabel(session.lastActivityAt, now),
      indicator !== null && indicator !== 'terminal' && sessions.INDICATOR_LABELS[indicator],
    ]
      .filter(Boolean)
      .join(', ');
  }

  // The tree's rows render in its shadow root, past this one's styles: what they hold is styled inline.

  /**
   * The open row's highlight while another is selected. The tree highlights only the selected row, so
   * it fills the row itself (its positioned ancestor), behind what the row holds (`::part(row)` isolates).
   * @param {ListItem} item
   * @param {{ selected: boolean }} state
   */
  #renderOpenMark(item, { selected }) {
    if (selected || item.id !== this.#openId) return nothing;
    return html`<span
      data-open-mark
      style="position: absolute; inset: 0; z-index: -1; border-radius: var(--tvx-tree-item-shape); background: color-mix(in srgb, var(--acp-color-secondary-container) 55%, transparent); pointer-events: none"
    ></span>`;
  }

  /**
   * @param {ListItem} item
   * @param {{ selected: boolean }} state
   */
  #renderLeading = (item, state) => {
    if (item.kind === 'subagent') {
      const indicator = subagentIndicator(item.subagent);
      return html`${this.#renderOpenMark(item, state)}<acp-subagent-status role="img" aria-label=${SUBAGENT_INDICATOR_LABELS[indicator]} data-status=${indicator} .indicator=${indicator}></acp-subagent-status>`;
    }
    if (item.kind !== 'session') return nothing;
    return html`${this.#renderOpenMark(item, state)}${this.#renderSessionMark(item.session)}`;
  };

  /** @param {Session} session An unread chat's dot, or its agent's icon. */
  #renderSessionMark(session) {
    const name = session.agentName ?? session.agentId;
    const id = `acp-session-list-mark:${session.id}`;
    return this.unread.includes(session.id)
      ? html`<span
            id=${id}
            data-unread-dot
            style="flex: none; inline-size: 8px; block-size: 8px; margin-inline: calc((var(--acp-icon-size-xs) - 8px) / 2); border-radius: var(--acp-shape-corner-full); background: var(--acp-color-primary)"
          ></span>
          <md-tooltip for=${id} show-delay="800">Unread · ${name}</md-tooltip>`
      : html`<acp-agent-icon id=${id} style="font-size: var(--acp-icon-size-xs)" .agent=${{ id: session.agentId, name: session.agentName }}></acp-agent-icon>
          <md-tooltip for=${id} show-delay="800">${name}</md-tooltip>`;
  }

  /**
   * @param {ListItem} item
   * @param {{ expanded: boolean }} state
   */
  #renderLabel = (item, { expanded }) => {
    if (item.kind === 'session') return html`<span aria-label=${this.#name(item.session)}>${item.label}</span>`;
    if (item.kind === 'more') return html`<span style="color: var(--acp-color-on-surface-variant)">${item.label}</span>`;
    if (item.kind === 'subagent') return item.label;
    return html`<span style="display: flex; align-items: center; gap: var(--acp-space-1-5)">
      <span style="font-weight: var(--acp-font-weight-medium)">${item.label}</span>
      <span style="color: var(--acp-color-on-surface-variant)">${item.count} session${item.count === 1 ? '' : 's'}</span>
      <md-icon
        aria-hidden="true"
        style="font-size: var(--acp-icon-size-sm); color: var(--acp-color-on-surface-variant); ${expanded
          ? 'opacity: var(--_acp-session-list-folder-chevron, 0)'
          : 'transform: rotate(-90deg)'}"
        >${unsafeSVG(expandIcon)}</md-icon
      >
    </span>`;
  };

  /** @param {ListItem} item */
  #renderTrailing = (item) => {
    if (item.kind === 'subagent') {
      return item.subagent.state === 'requires_action'
        ? 'waiting'
        : html`<acp-datetime .value=${item.subagent.announcedAt} .now=${this.now} format="compact"></acp-datetime>`;
    }
    if (item.kind !== 'session') return nothing;
    const { session } = item;
    return html`<acp-session-row-trailing
      .session=${session}
      .pinned=${this.pinned.includes(session.id)}
      .unread=${this.unread.includes(session.id)}
      .waiting=${this.waiting.includes(session.id)}
      .menuOpen=${this.#sessionMenu.target?.id === session.id}
      .now=${this.now}
      .subagents=${this.subagents[session.id]?.length ?? 0}
      .expanded=${!this.closed.has(session.id)}
    ></acp-session-row-trailing>`;
  };

  /** @param {ListItem} item */
  #isEditable = (item) => item.kind === 'session';

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

  /** @param {FolderItem[]} items */
  #renderTree(items) {
    this.#branches = items.flatMap((folder) => [
      folder.id,
      ...folder.children.flatMap((child) => (child.kind === 'session' && child.children ? [child.id] : [])),
    ]);
    return html`<tvx-tree-view
      class="acp-session-list__tree"
      compact
      no-virtualization
      expansion-trigger="icon"
      aria-label="Chats"
      .items=${items}
      .selectedItems=${this.#selection}
      .isItemEditable=${this.#isEditable}
      .renderItemLeading=${this.#renderLeading}
      .renderItemLabel=${this.#renderLabel}
      .renderItemTrailing=${this.#renderTrailing}
      @keydown=${this.#onKeydown}
      @click=${this.#onClick}
      @dblclick=${this.#onDblclick}
      @contextmenu=${this.#onContextMenu}
      @tvx-selection-change=${this.#onSelectionChange}
      @tvx-expand-change=${this.#onExpandChange}
      @tvx-item-label-change=${this.#onLabelChange}
      @acp-session-row-menu=${this.#onSessionRowMenu}
      @acp-session-row-toggle=${this.#onRowToggle}
    ></tvx-tree-view>`;
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

  /** @param {Session | null} target */
  #pinOf(target) {
    if (target === null) return '';
    return this.pinned.includes(target.id) ? 'unpin' : 'pin';
  }

  render() {
    const target = this.#sessionMenu.target;
    const items = this.#items();
    return html`
      ${items.length > 0
        ? this.#renderTree(items)
        : this.loading
          ? this.#renderLoading()
          : html`<div class="acp-session-list__empty">No chats yet</div>`}
      <acp-session-menu
        session-title=${target?.title ?? ''}
        .mark=${this.#markOf(target)}
        .pin=${this.#pinOf(target)}
        ?resettable=${target !== null && target.titleSource === 'user' && target.agentTitle !== null}
        @acp-session-menu-select=${this.#onSessionMenuSelect}
        @acp-session-menu-toggle=${(/** @type {Event} */ e) => e.stopPropagation()}
        @acp-session-menu-closed=${this.#onSessionMenuClosed}
      ></acp-session-menu>
    `;
  }
}

customElements.define('acp-session-list', AcpSessionList);
