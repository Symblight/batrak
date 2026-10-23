import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import '@symblight/wc-material/text-field';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import moreIcon from '@material-design-icons/svg/outlined/more_vert.svg?raw';
import openFolderIcon from '@material-design-icons/svg/outlined/create_new_folder.svg?raw';
import pinIcon from '@material-design-icons/svg/outlined/push_pin.svg?raw';
import '../acp-session-menu/acp-session-menu.js';
import '../acp-session-status/acp-session-status.js';
import '../acp-session-sync/acp-session-sync.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { SESSIONS_PAGE, orderSessions, sessionIndicator, visibleSessions } from '../../models/sessions.js';
import styles from './acp-session-list.css?inline';

/** @typedef {import('../../models/types.js').Project} Project */
/** @typedef {import('../../models/types.js').Session} Session */

const REVEAL_LABEL = /Mac/.test(navigator.userAgent)
  ? 'Show in Finder'
  : /Windows/.test(navigator.userAgent)
    ? 'Show in Explorer'
    : 'Show in File Manager';

/**
 * Compact age: `now`, `12m`, `3h`, `2d`.
 * @param {string} iso
 */
function age(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!(minutes >= 1)) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

/**
 * @tag acp-session-list
 * @summary The active project's sync with its agents beside the heading; projects, each expanding into its sessions (pinned first, then by last activity; five, and five more with each Show more) with their status, branch and age; a row's menu button, right-click or Shift+F10 opens the session menu, F2 or a double-click renames it in place.
 * @fires acp-project-open-folder `null`
 * @fires acp-project-select `{ projectId }`
 * @fires acp-project-toggle `{ projectId, expanded }`
 * @fires acp-project-new-session `{ projectId }`
 * @fires acp-project-reveal `{ projectId }`
 * @fires acp-project-remove `{ projectId }`
 * @fires acp-session-select `{ sessionId }`
 * @fires acp-session-rename `{ sessionId, title }` A new title, trimmed, not empty and not the current one.
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
    home: {},
    renaming: { state: true },
    limits: { state: true },
    hovered: { state: true },
    focused: { state: true },
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
    /** @type {import('../../models/types.js').SessionSync | null} The active project's sync with its agents. */
    this.sync = null;
    /** @type {string | null} Shown as `~` in project paths. */
    this.home = null;
    /** @type {string | null} The session whose title is being edited in its row. */
    this.renaming = null;
    /** @type {Readonly<Record<string, number>>} How many sessions each project shows, by project id (`SESSIONS_PAGE` until Show more). */
    this.limits = {};
    /** @type {string | null} The session row under the pointer. */
    this.hovered = null;
    /** @type {string | null} The session row with focus in it. */
    this.focused = null;
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
   * Enter/Space selects, arrows expand/collapse, ContextMenu or Shift+F10 opens the menu.
   * @param {Project} project
   * @param {KeyboardEvent} e
   */
  #onProjectKeydown(project, e) {
    if (e.target !== e.currentTarget) return;
    const projectId = project.id;
    if (e.key === 'Enter' || e.key === ' ') this.#emit('acp-project-select', { projectId });
    else if (e.key === 'ArrowRight') this.#emit('acp-project-toggle', { projectId, expanded: true });
    else if (e.key === 'ArrowLeft') this.#emit('acp-project-toggle', { projectId, expanded: false });
    else if (!this.#projectMenu.onKeydown(project, e)) return;
    e.preventDefault();
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
  }

  /**
   * F2 renames, Enter/Space selects, ContextMenu or Shift+F10 opens the menu.
   * @param {Session} session
   * @param {KeyboardEvent} e
   */
  #onSessionKeydown(session, e) {
    if (e.target !== e.currentTarget || this.#sessionMenu.onKeydown(session, e)) return;
    if (e.key === 'F2') this.#startRename(session);
    else if (e.key === 'Enter' || e.key === ' ') this.#emit('acp-session-select', { sessionId: session.id });
    else return;
    e.preventDefault();
  }

  /** @param {Event} e */
  #onSessionMenuSelect(e) {
    e.stopPropagation();
    const session = this.#sessionMenu.target;
    if (!session) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    const sessionId = session.id;
    if (value === 'rename') this.#startRename(session);
    else if (value === 'reset-title' || value === 'reveal' || value === 'open-terminal' || value === 'delete')
      this.#emit(`acp-session-${value}`, { sessionId });
  }

  /** @param {Event} e */
  #onSessionMenuClosed(e) {
    e.stopPropagation();
    this.#sessionMenu.onClosed();
  }

  /**
   * Swaps the row's title for a text field, focused with its text selected.
   * @param {Session} session
   */
  async #startRename(session) {
    this.renaming = session.id;
    await this.updateComplete;
    const field = this.renderRoot.querySelector('md-text-field');
    if (!field) return;
    await field.updateComplete;
    field.focus();
    if (field.inputOrTextArea instanceof HTMLInputElement) field.inputOrTextArea.select();
  }

  /**
   * Enter or leaving the field saves the title, Escape keeps the old one; so does an empty field.
   * @param {Session} session
   * @param {HTMLElementTagNameMap['md-text-field']} field
   * @param {boolean} save
   */
  async #endRename(session, field, save) {
    if (this.renaming !== session.id) return;
    this.renaming = null;
    const title = field.value.trim();
    if (save && title !== '' && title !== session.title) this.#emit('acp-session-rename', { sessionId: session.id, title });
    await this.updateComplete;
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector(`[data-session-id="${CSS.escape(session.id)}"]`))?.focus();
  }

  /**
   * @param {Session} session
   * @param {KeyboardEvent} e
   */
  #onRenameKeydown(session, e) {
    e.stopPropagation();
    const field = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.currentTarget);
    if (e.key === 'Enter') this.#endRename(session, field, true);
    else if (e.key === 'Escape') this.#endRename(session, field, false);
    else return;
    e.preventDefault();
  }

  /**
   * @param {Session} session
   * @param {FocusEvent} e
   */
  #onRowFocusOut(session, e) {
    const row = /** @type {HTMLElement} */ (e.currentTarget);
    if (this.focused === session.id && !(e.relatedTarget instanceof Node && row.contains(e.relatedTarget)))
      this.focused = null;
  }

  /**
   * @param {Project} project
   * @param {Session[]} sessions Of this project, in order.
   */
  #renderProject(project, sessions) {
    const expanded = !this.collapsed.includes(project.id);
    const failure = this.failures[project.id];
    return html`
      <div
        class=${classMap({
          'acp-session-list__project': true,
          'acp-session-list__project_menu-open': this.#projectMenu.target?.id === project.id,
          'acp-session-list__project_loading': this.openingProjectId === project.id,
        })}
        role="treeitem"
        tabindex="0"
        aria-expanded=${expanded ? 'true' : 'false'}
        title=${project.path}
        @click=${() => this.#emit('acp-project-select', { projectId: project.id })}
        @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onProjectKeydown(project, e)}
        @contextmenu=${(/** @type {MouseEvent} */ e) => this.#projectMenu.onContextMenu(project, e)}
      >
        <md-icon class="acp-session-list__chevron">${unsafeSVG(expanded ? expandMoreIcon : chevronRightIcon)}</md-icon>
        <span
          class=${classMap({
            'acp-session-list__project-name': true,
            'acp-session-list__project-name_active': this.activeProjectId === project.id,
          })}
          >${project.name}</span
        >
        <span class="acp-session-list__project-path">${this.#displayPath(project.path)}</span>
        ${!expanded && sessions.length > 0 ? html`<span class="acp-session-list__count">${sessions.length}</span>` : nothing}
        <md-icon-button
          class="acp-session-list__add"
          title="New session"
          aria-label=${`New session in ${project.name}`}
          @click=${(/** @type {Event} */ e) => {
            e.stopPropagation();
            this.#emit('acp-project-new-session', { projectId: project.id });
          }}
        >
          <md-icon class="acp-session-list__add-icon">${unsafeSVG(addIcon)}</md-icon>
        </md-icon-button>
      </div>
      ${failure !== undefined
        ? html`<div class="acp-session-list__error" role="alert">Couldn't open the folder: ${failure}</div>`
        : nothing}
      ${expanded
        ? sessions.length > 0
          ? this.#renderSessions(project, sessions)
          : html`<div class="acp-session-list__empty">
              No sessions yet. Press
              <md-icon class="acp-session-list__empty-icon">${unsafeSVG(addIcon)}</md-icon>
              to start one.
            </div>`
        : nothing}
    `;
  }

  /**
   * A project's sessions down to its limit, then Show more for the next `SESSIONS_PAGE`.
   * @param {Project} project
   * @param {Session[]} sessions In order.
   */
  #renderSessions(project, sessions) {
    const limit = this.limits[project.id] ?? SESSIONS_PAGE;
    const { shown, hidden } = visibleSessions(sessions, limit, this.activeSessionId);
    return html`<div class="acp-session-list__sessions" role="group">
      ${repeat(shown, (s) => s.id, (s) => this.#renderSession(s))}
      ${hidden > 0
        ? html`<md-button
            class="acp-session-list__show-more"
            variant="text"
            aria-label=${`Show more sessions of ${project.name}`}
            @click=${() => (this.limits = { ...this.limits, [project.id]: shown.length + SESSIONS_PAGE })}
            >Show more…</md-button
          >`
        : nothing}
    </div>`;
  }

  /** @param {Session} session */
  #renderSession(session) {
    const selected = session.id === this.activeSessionId;
    const pinned = this.pinned.includes(session.id);
    const unread = this.unread.includes(session.id);
    const renaming = this.renaming === session.id;
    const showMore =
      this.hovered === session.id || this.focused === session.id || this.#sessionMenu.target?.id === session.id;
    return html`<div
      class=${classMap({ 'acp-session-list__row': true, 'acp-session-list__row_selected': selected })}
      data-session-id=${session.id}
      role="treeitem"
      tabindex="0"
      aria-selected=${selected ? 'true' : 'false'}
      @click=${() => this.#emit('acp-session-select', { sessionId: session.id })}
      @dblclick=${() => this.#startRename(session)}
      @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onSessionKeydown(session, e)}
      @contextmenu=${(/** @type {MouseEvent} */ e) => this.#sessionMenu.onContextMenu(session, e)}
      @pointerenter=${() => (this.hovered = session.id)}
      @pointerleave=${() => {
        if (this.hovered === session.id) this.hovered = null;
      }}
      @focusin=${() => (this.focused = session.id)}
      @focusout=${(/** @type {FocusEvent} */ e) => this.#onRowFocusOut(session, e)}
    >
      ${pinned
        ? html`<md-icon class="acp-session-list__pin" title="Pinned" aria-label="Pinned">${unsafeSVG(pinIcon)}</md-icon>`
        : nothing}
      ${renaming
        ? html`<md-text-field
            class="acp-session-list__rename"
            variant="outlined"
            aria-label="Session title"
            spellcheck="false"
            .value=${session.title}
            @click=${(/** @type {Event} */ e) => e.stopPropagation()}
            @dblclick=${(/** @type {Event} */ e) => e.stopPropagation()}
            @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onRenameKeydown(session, e)}
            @focusout=${(/** @type {FocusEvent} */ e) =>
              this.#endRename(session, /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.currentTarget), true)}
          ></md-text-field>`
        : html`<span class=${classMap({ 'acp-session-list__title': true, 'acp-session-list__title_unread': unread })}
            >${session.title}</span
          >`}
      ${session.branch
        ? html`<md-icon class="acp-session-list__branch" title=${`Worktree on ${session.branch}`} aria-label="Worktree"
            >${unsafeSVG(branchIcon)}</md-icon
          >`
        : nothing}
      <span class="acp-session-list__age">${age(session.lastActivityAt)}</span>
      ${showMore
        ? html`<md-icon-button
            class="acp-session-list__more"
            title="Session menu"
            aria-label=${`Session menu: ${session.title}`}
            @click=${(/** @type {Event} */ e) => {
              e.stopPropagation();
              this.#sessionMenu.openFrom(session, /** @type {HTMLElement} */ (e.currentTarget));
            }}
          >
            <md-icon class="acp-session-list__more-icon">${unsafeSVG(moreIcon)}</md-icon>
          </md-icon-button>`
        : this.#renderStatus(session, unread)}
    </div>`;
  }

  /**
   * @param {Session} session
   * @param {boolean} unread
   */
  #renderStatus(session, unread) {
    const indicator = sessionIndicator(session.status, this.waiting.includes(session.id), unread, session.activeElsewhere ?? false);
    return indicator === null
      ? nothing
      : html`<acp-session-status class="acp-session-list__status" .indicator=${indicator}></acp-session-status>`;
  }

  #renderProjectMenu() {
    return html`<md-menu
      class="acp-session-list__project-menu"
      aria-label=${this.#projectMenu.target?.name ?? 'Project'}
      @select=${this.#projectMenu.onSelect}
      @closed=${this.#projectMenu.onClosed}
    >
      <md-menu-item class="acp-session-list__menu-item" value="new-session">
        <md-icon slot="leading" class="acp-session-list__menu-icon">${unsafeSVG(addIcon)}</md-icon>
        New Session
      </md-menu-item>
      <md-menu-item class="acp-session-list__menu-item" value="reveal">
        <md-icon slot="leading" class="acp-session-list__menu-icon">${unsafeSVG(folderOpenIcon)}</md-icon>
        ${REVEAL_LABEL}
      </md-menu-item>
      <md-hr></md-hr>
      <md-menu-item class="acp-session-list__menu-item" value="remove">
        <md-icon slot="leading" class="acp-session-list__menu-icon">${unsafeSVG(closeIcon)}</md-icon>
        Remove project
      </md-menu-item>
    </md-menu>`;
  }

  render() {
    const target = this.#sessionMenu.target;
    return html`
      <div class="acp-session-list__top">
        <h2 class="acp-session-list__heading">Sessions</h2>
        <acp-session-sync .sync=${this.sync}></acp-session-sync>
        <md-icon-button
          class="acp-session-list__open-folder"
          title="Open folder…"
          aria-label="Open folder"
          @click=${() => this.#emit('acp-project-open-folder')}
        >
          <md-icon class="acp-session-list__open-folder-icon">${unsafeSVG(openFolderIcon)}</md-icon>
        </md-icon-button>
      </div>
      <div class="acp-session-list__list" role="tree" aria-label="Sessions">
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
        ?resettable=${target !== null && target.titleSource === 'user' && target.agentTitle !== null}
        @acp-session-menu-select=${this.#onSessionMenuSelect}
        @acp-session-menu-toggle=${(/** @type {Event} */ e) => e.stopPropagation()}
        @acp-session-menu-closed=${this.#onSessionMenuClosed}
      ></acp-session-menu>
    `;
  }
}

customElements.define('acp-session-list', AcpSessionList);
