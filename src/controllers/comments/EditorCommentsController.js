import { editorOf } from '../../models/editor-events.js';

/** @typedef {import('lit').ReactiveControllerHost & import('lit').LitElement} ReactiveElementHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('../../models/types.js').AgentThread} AgentThread */
/** @typedef {import('../../models/types.js').CommentFocus} CommentFocus */

/**
 * @typedef {Object} EditorCommentsConfig
 * @property {(file: string) => string | null} pathOf Absolute path of an editor's `filename`; `null`
 *   when it can't be resolved (no project).
 * @property {() => Readonly<Record<string, readonly AgentThread[]>>} comments Every file's threads, by
 *   absolute path (the host's property).
 * @property {() => CommentFocus | null} focus A comment to reveal (the host's property).
 */

/** @type {readonly AgentThread[]} */
const NONE = [];

/**
 * Controls the host's `cdx-code-editor`s' comments: their `<cdx-comments>` show the host's threads
 * (`.comments=${controller.threadsOf(path)}`), their submit / edit / delete become host events, and a
 * focus on a file one of them shows is revealed there. Any number of editors per host, any number
 * of hosts.
 * @implements {ReactiveController}
 */
export class EditorCommentsController {
  /** @type {ReactiveElementHost} */
  #host;
  /** @type {EditorCommentsConfig} */
  #config;
  /** A reveal waiting for the editors to settle; one at a time. */
  #revealing = false;

  /**
   * @param {ReactiveElementHost} host
   * @param {EditorCommentsConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  /**
   * @param {string | null} path Absolute.
   * @returns {readonly AgentThread[]}
   */
  threadsOf(path) {
    return this.#config.comments()[path ?? ''] ?? NONE;
  }

  hostConnected() {
    this.#host.addEventListener('cdx-comment-submit', this.#onSubmit);
    this.#host.addEventListener('cdx-comment-edit', this.#onEdit);
    this.#host.addEventListener('cdx-comment-delete', this.#onDelete);
  }

  hostDisconnected() {
    this.#host.removeEventListener('cdx-comment-submit', this.#onSubmit);
    this.#host.removeEventListener('cdx-comment-edit', this.#onEdit);
    this.#host.removeEventListener('cdx-comment-delete', this.#onDelete);
  }

  hostUpdated() {
    if (this.#config.focus() && !this.#revealing) this.#reveal();
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.#host.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Reveals the focus in a visible editor of its file, once that editor holds the thread. */
  async #reveal() {
    const focus = this.#config.focus();
    if (!focus) return;
    const editor = [...this.#host.renderRoot.querySelectorAll('cdx-code-editor')].find(
      (e) => this.#config.pathOf(e.filename) === focus.path && e.getClientRects().length > 0, // not in a hidden tab
    );
    if (!editor) return;
    this.#revealing = true;
    try {
      // The threads reach the editor through <cdx-comments>' own update, then the editor's.
      await editor.updateComplete;
      await editor.querySelector('cdx-comments')?.updateComplete;
      await editor.updateComplete;
    } finally {
      this.#revealing = false;
    }
    if (this.#config.focus() !== focus) return;
    if (!editor.comments.get().some((/** @type {{ id: string }} */ t) => t.id === focus.threadId)) return; // not loaded yet: next update
    this.#emit('acp-comment-revealed', { focus });
    editor.comments.reveal(focus.threadId);
  }

  /**
   * The file of an event from one of the host's own editors; `null` for others' (or no project).
   * @param {Event} e
   */
  #pathOf(e) {
    if (!editorOf(e, this.#host.renderRoot)) return null;
    return this.#config.pathOf(/** @type {CustomEvent<{ file: string }>} */ (e).detail.file);
  }

  #onSubmit = (/** @type {Event} */ e) => {
    const detail = /** @type {HTMLElementEventMap['cdx-comment-submit']} */ (e).detail;
    const path = this.#pathOf(e);
    if (path === null || detail.isReply) return;
    const doc = editorOf(e, this.#host.renderRoot)?.view?.state.doc;
    const fromLine = detail.range && doc ? doc.lineAt(Math.min(detail.range.from, doc.length)).number : detail.line;
    this.#emit('acp-comment-add', { path, draft: { ...detail, fromLine: Math.min(fromLine, detail.line) } });
  };

  #onEdit = (/** @type {Event} */ e) => {
    const { threadId, commentId, body } = /** @type {HTMLElementEventMap['cdx-comment-edit']} */ (e).detail;
    const path = this.#pathOf(e);
    if (path !== null) this.#emit('acp-comment-edit', { path, threadId, commentId, body });
  };

  #onDelete = (/** @type {Event} */ e) => {
    const { threadId, commentId } = /** @type {HTMLElementEventMap['cdx-comment-delete']} */ (e).detail;
    const path = this.#pathOf(e);
    if (path !== null) this.#emit('acp-comment-delete', { path, threadId, commentId });
  };
}
