import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import '@symblight/wc-material/skeleton';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import doneAllIcon from '@material-design-icons/svg/outlined/done_all.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import openFolderIcon from '@material-design-icons/svg/outlined/create_new_folder.svg?raw';
import { AcpProjectRow } from '../project-row/project-row.js';
import '../session-menu/session-menu.js';
import '../session-row/session-row.js';
import '../session-sync/session-sync.js';
import { TreeNavigationController } from '../../controllers/tree-navigation/TreeNavigationController.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { app } from '../../hooks/app/app.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './session-list.css?inline';

const { SESSIONS_PAGE, orderSessions, unreadIn, visibleSessions } = sessions;

/** @typedef {import('../session-row/session-row.js').AcpSessionRow} AcpSessionRow */
/** @typedef {import('../../controllers/tree-navigation/TreeNavigationController.js').TreeNode} TreeNode */
/** @typedef {import('../../hooks/projects/types.js').Project} Project */
/** @typedef {import('../../hooks/sessions/types.js').Session} Session */

/**
 * @tag acp-session-list
 * @summary The active project's sync with its agents beside the heading; projects, each expanding into its sessions (pinned first, then by last activity; five, and five more with each Show more; skeleton rows while they load) with their status, branch and age (unread ones marked, counted on a collapsed project and behind Show more); a row's menu button, right-click or Shift+F10 opens the session menu, F2 or a double-click renames it in place.
 * @fires acp-project-open-folder `null`
 * @fires acp-project-select `{ projectId }`
 * @fires acp-project-toggle `{ projectId, expanded }`
 * @fires acp-project-new-session `{ projectId }`
 * @fires acp-project-reveal `{ projectId }`
 * @fires acp-project-remove `{ projectId }`
 * @fires acp-project-mark-read `{ projectId }` Mark all as read.
 * @fires acp-session-select `{ sessionId }`
 * @fires acp-session-rename `{ sessionId, title }` A new title, trimmed, not empty and not the current one.
 * @fires acp-session-mark-read `{ sessionId, read }` Mark as read (`read: true`) or as unread.
 * @fires acp-session-reset-title `{ sessionId }`
 * @fires acp-session-reveal `{ sessionId }`
 * @fires acp-session-open-terminal `{ sessionId }` Open in → Terminal.
 * @fires acp-session-delete `{ sessionId }`
 * @fires acp-session-resync `null` From `<acp-session-sync>`.
 */
export class AcpSessionList extends LitElement {
  static properties = {
    projects: { attribute: false },
    sessions: { attribute: false },
    collapsed: { attribute: false },
    activeProjectId: { attribute: false },
    activeSessionId: { attribute: false },
    openingProjectId: { attribute: false },
    pinned: { attribute: false },
    unread: { attribute: false },
    waiting: { attribute: false },
    failures: { attribute: false },
    sync: { attribute: false },
    loading: { attribute: false },
    now: { attribute: false },
    home: {},
    limits: { state: true },
  };

  static styles = styles;

  /** @type {ContextMenuController<Project>} */
  #projectMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-session-list__project-menu'),
    onSelect: (value, project) => this.#onProjectMenuSelect(value, project),
  });

  /** @type {ContextMenuController<Session>} */
  #sessionMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('acp-session-menu')?.menu ?? null,
    // `<acp-session-menu>` reports picks as its own event (#onSessionMenuSelect).
    onSelect: () => {},
  });

  /** Rows of the tree: every project, and the sessions of the expanded ones. */
  #tree = new TreeNavigationController(this, {
    nodes: () => this.#treeNodes(),
    toggle: (node, expanded) => {
      const project = /** @type {AcpProjectRow} */ (node.el).project;
      if (project) this.#emit('acp-project-toggle', { projectId: project.id, expanded });
    },
  });

  /** @returns {TreeNode[]} */
  #treeNodes() {
    /** @type {TreeNode[]} */
    const nodes = [];
    for (const el of this.renderRoot.querySelectorAll('acp-project-row, acp-session-row')) {
      if (el instanceof AcpProjectRow) {
        if (el.project) nodes.push({ key: `project:${el.project.id}`, el, label: el.project.name, parent: null, expanded: el.expanded });
      } else {
        const row = /** @type {AcpSessionRow} */ (el);
        if (row.session) nodes.push({ key: `session:${row.session.id}`, el: row, label: row.session.title, parent: `project:${row.session.projectId}`, expanded: null });
      }
    }
    return nodes;
  }

  constructor() {
    super();
    /** @type {readonly Project[]} */
    this.projects = [];
    /** @type {readonly Session[]} Every project's. */
    this.sessions = [];
    /** @type {readonly string[]} Ids of projects whose sessions are hidden. */
    this.collapsed = [];
    /** @type {string | null} The project whose workspace is open. */
    this.activeProjectId = null;
    /** @type {string | null} */
    this.activeSessionId = null;
    /** @type {string | null} The project being opened. */
    this.openingProjectId = null;
    /** @type {readonly string[]} Session ids. */
    this.pinned = [];
    /** @type {readonly string[]} Sessions with output not seen yet. */
    this.unread = [];
    /** @type {readonly string[]} Sessions with a permission request waiting for the user. */
    this.waiting = [];
    /** @type {Readonly<Record<string, string>>} Why a project's folder couldn't be opened, by project id. */
    this.failures = {};
    /** @type {import('../../hooks/sessions/types.js').SessionSync | null} The active project's sync with its agents. */
    this.sync = null;
    /** @type {readonly string[]} Projects whose sessions are loading; one with none to show yet shows skeleton rows. */
    this.loading = [];
    /** @type {number} The time, ms: a session active in another app shows so until its time is up. */
    this.now = Date.now();
    /** @type {string | null} Shown as `~` in project paths. */
    this.home = null;
    /** @type {Readonly<Record<string, number>>} How many sessions each project shows, by project id (`SESSIONS_PAGE` until Show more). */
    this.limits = {};
  }

  /**
   * @param {string} type
   * @param {object | null} [detail]
   */
  #emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {string} path */
  #displayPath(path) {
    const home = this.home;
    return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
      ? `~${path.slice(home.length)}`
      : path;
  }

  /**
   * @param {string} value The chosen item's.
   * @param {Project} project The project the menu was opened on.
   */
  #onProjectMenuSelect(value, project) {
    const projectId = project.id;
    if (value === 'new-session') this.#emit('acp-project-new-session', { projectId });
    else if (value === 'reveal') this.#emit('acp-project-reveal', { projectId });
    else if (value === 'remove') this.#emit('acp-project-remove', { projectId });
    else if (value === 'mark-read') {
      this.#emit('acp-project-mark-read', { projectId });
      this.#focusAfterClose = projectId;
    }
  }

  /** @type {string | null} A project whose row takes focus once its menu has closed. */
  #focusAfterClose = null;

  #onProjectMenuClosed = () => {
    this.#projectMenu.onClosed();
    const projectId = this.#focusAfterClose;
    this.#focusAfterClose = null;
    if (projectId === null) return;
    const row = [...this.renderRoot.querySelectorAll('acp-project-row')].find((r) => r.project?.id === projectId);
    row?.focusRow();
  };

  /** @param {Event} e A row wants its menu: at a point, or under its button. */
  #onProjectRowMenu(e) {
    e.stopPropagation();
    const { project, x, y } = /** @type {CustomEvent<{ project: Project, x: number, y: number }>} */ (e).detail;
    this.#projectMenu.open(project, x, y);
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

  /**
   * @param {Project} project
   * @param {Session[]} sessions Of this project, in order.
   */
  #renderProject(project, sessions) {
    const expanded = !this.collapsed.includes(project.id);
    const failure = this.failures[project.id];
    return html`
      <acp-project-row
        .project=${project}
        .path=${this.#displayPath(project.path)}
        .expanded=${expanded}
        .active=${this.activeProjectId === project.id}
        .loading=${this.openingProjectId === project.id}
        .menuOpen=${this.#projectMenu.target?.id === project.id}
        .count=${sessions.length}
        .unread=${unreadIn(sessions, this.unread).count}
        @acp-project-row-menu=${this.#onProjectRowMenu}
      ></acp-project-row>
      ${failure !== undefined
        ? html`<div class="acp-session-list__error" role="alert">Couldn't open the folder: ${failure}</div>`
        : nothing}
      ${expanded
        ? sessions.length > 0
          ? this.#renderSessions(project, sessions)
          : this.loading.includes(project.id)
            ? this.#renderLoading()
            : html`<div class="acp-session-list__empty">
              No sessions yet. Press
              <md-icon class="acp-session-list__empty-icon">${unsafeSVG(addIcon)}</md-icon>
              to start one.
            </div>`
        : nothing}
    `;
  }

  /** Rows the shape of session rows, while a project's sessions load. */
  #renderLoading() {
    return html`<div class="acp-session-list__loading" role="status" aria-label="Loading sessions" aria-busy="true">
      ${['70%', '55%', '62%'].map(
        (width) => html`<div class="acp-session-list__skeleton-row">
          <md-skeleton class="acp-session-list__skeleton-title" style=${`width: ${width}`}></md-skeleton>
          <md-skeleton class="acp-session-list__skeleton-age"></md-skeleton>
        </div>`,
      )}
    </div>`;
  }

  /**
   * A project's sessions down to its limit, then Show more for the next `SESSIONS_PAGE`.
   * @param {Project} project
   * @param {Session[]} sessions In order.
   */
  #renderSessions(project, sessions) {
    const limit = this.limits[project.id] ?? SESSIONS_PAGE;
    const { shown, hidden } = visibleSessions(sessions, limit, this.activeSessionId);
    const unreadBehind = unreadIn(sessions, this.unread, shown.length).hidden;
    return html`<div class="acp-session-list__sessions" role="group">
      ${repeat(shown, (s) => s.id, (s) => this.#renderSession(s))}
      ${hidden > 0
        ? html`<div class="acp-session-list__more"><md-button
            class="acp-session-list__show-more"
            variant="text"
            aria-label=${`Show more sessions of ${project.name}${unreadBehind > 0 ? `, ${unreadBehind} unread` : ''}`}
            @click=${() => (this.limits = { ...this.limits, [project.id]: shown.length + SESSIONS_PAGE })}
            >Show more…</md-button
          >
          ${unreadBehind > 0
            ? html`<span class="acp-session-list__show-more-new" aria-hidden="true">
                <span class="acp-session-list__show-more-dot"></span>${unreadBehind} new
              </span>`
            : nothing}</div>`
        : nothing}
    </div>`;
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
    ></acp-session-row>`;
  }

  #renderProjectMenu() {
    const target = this.#projectMenu.target;
    const anyUnread = target !== null && unreadIn(this.sessions.filter((s) => s.projectId === target.id), this.unread).count > 0;
    return html`<md-menu
      class="acp-session-list__project-menu"
      aria-label=${target?.name ?? 'Project'}
      @select=${this.#projectMenu.onSelect}
      @closed=${this.#onProjectMenuClosed}
    >
      <md-menu-item class="acp-session-list__menu-item" value="mark-read" ?disabled=${!anyUnread}>
        <md-icon slot="leading" class="acp-session-list__menu-icon">${unsafeSVG(doneAllIcon)}</md-icon>
        Mark all as read
        ${target !== null && target.id === this.activeProjectId
          ? html`<span slot="trailing">${shortcuts.hint('markProjectRead')}</span>`
          : nothing}
      </md-menu-item>
      <md-menu-item class="acp-session-list__menu-item" value="new-session">
        <md-icon slot="leading" class="acp-session-list__menu-icon">${unsafeSVG(addIcon)}</md-icon>
        New session
      </md-menu-item>
      <md-menu-item class="acp-session-list__menu-item" value="reveal">
        <md-icon slot="leading" class="acp-session-list__menu-icon">${unsafeSVG(folderOpenIcon)}</md-icon>
        ${app.revealLabel}
      </md-menu-item>
      <md-hr></md-hr>
      <md-menu-item class="acp-session-list__menu-item" value="remove">
        <md-icon slot="leading" class="acp-session-list__menu-icon">${unsafeSVG(closeIcon)}</md-icon>
        Remove project
      </md-menu-item>
    </md-menu>`;
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
    return html`
      <div class="acp-session-list__top">
        <h2 class="acp-session-list__heading">Sessions</h2>
        <acp-session-sync .sync=${this.sync}></acp-session-sync>
        <md-icon-button
          id="acp-session-list-open-folder"
          class="acp-session-list__open-folder"
          aria-label="Open folder"
          @click=${() => this.#emit('acp-project-open-folder')}
        >
          <md-icon class="acp-session-list__open-folder-icon">${unsafeSVG(openFolderIcon)}</md-icon>
        </md-icon-button>
        <md-tooltip for="acp-session-list-open-folder" show-delay="800">Open folder…</md-tooltip>
      </div>
      <div class="acp-session-list__list" role="tree" aria-label="Sessions" @keydown=${this.#tree.onKeydown} @focusin=${this.#tree.onFocusin}>
        ${repeat(
          this.projects,
          (p) => p.id,
          (p) =>
            this.#renderProject(
              p,
              orderSessions(
                this.sessions.filter((s) => s.projectId === p.id),
                this.pinned,
              ),
            ),
        )}
      </div>
      ${this.#renderProjectMenu()}
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
