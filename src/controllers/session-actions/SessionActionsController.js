import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { $sessions } from '../../stores/sessions/sessions.js';

/** @typedef {import('lit').ReactiveControllerHost & HTMLElement} SessionActionsHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('../../models/types/types.js').Session} Session */

/**
 * @typedef {Object} SessionActionsConfig
 * @property {() => HTMLElementTagNameMap['acp-confirm-dialog'] | null} confirm The host's dialog,
 *   which Delete asks first.
 */

/** What `<acp-session-header>` and `<acp-session-list>` ask for a session, each with `{ sessionId }`. */
const EVENTS = [
  'acp-session-rename',
  'acp-session-reset-title',
  'acp-session-reveal',
  'acp-session-open-terminal',
  'acp-session-delete',
];

/**
 * Carries out the session actions a container's children ask for (rename, reset title, reveal,
 * open in a terminal, delete), so the agent column's header and the session column's list act the same.
 * @implements {ReactiveController}
 */
export class SessionActionsController {
  /** @type {SessionActionsHost} */
  #host;
  /** @type {SessionActionsConfig} */
  #config;

  /**
   * @param {SessionActionsHost} host
   * @param {SessionActionsConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  hostConnected() {
    for (const type of EVENTS) this.#host.addEventListener(type, this.#onAction);
  }

  hostDisconnected() {
    for (const type of EVENTS) this.#host.removeEventListener(type, this.#onAction);
  }

  #onAction = (/** @type {Event} */ e) => {
    const detail = /** @type {CustomEvent<{ sessionId: string, title?: string }>} */ (e).detail;
    e.stopPropagation();
    const session = $sessions.get().find((s) => s.id === detail.sessionId);
    if (!session) return;
    if (e.type === 'acp-session-rename') sessions.rename(session.id, detail.title ?? '');
    else if (e.type === 'acp-session-reset-title') sessions.resetTitle(session.id);
    else if (e.type === 'acp-session-reveal')
      projects.reveal(session.folder).catch((err) => app.reportError('Revealing folder failed', err));
    else if (e.type === 'acp-session-open-terminal') sessions.openInTerminal(session.id);
    else this.#delete(session);
  };

  /**
   * Asks first; the project's files stay either way.
   * @param {Session} session
   */
  async #delete(session) {
    const dialog = this.#config.confirm();
    if (dialog && (await dialog.confirm(sessions.removeSessionConfirm(session)))) await sessions.remove(session.id);
  }
}
