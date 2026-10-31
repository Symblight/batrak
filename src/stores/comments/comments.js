import { atom, computed } from 'nanostores';
import { $workspace } from '../workspace/workspace.js';
import { $activePath, CHANGES_TAB_ID, parseTabId } from '../editor/editor.js';
import { $gitChanges } from '../git/git.js';
import { addToChat } from '../chat/chat.js';

/** @typedef {import('@symblight/code-editor').CdxCommentAuthor} CdxCommentAuthor */
/** @typedef {NonNullable<import('@symblight/code-editor').CdxThread['range']>} CdxCommentRange */
/** @typedef {import('../../models/types/types.js').AgentThread} AgentThread */
/** @typedef {import('../../models/types/types.js').QueuedComment} QueuedComment */
/** @typedef {import('../../models/types/types.js').CommentFocus} CommentFocus */

/** @type {readonly AgentThread[]} One array for every file without comments, so editors see no change. */
const NONE = Object.freeze([]);

/**
 * Line comments for the agent by file (absolute path), in memory for this window. Every editor showing
 * a file projects its entry, so the same file in a tab and in the Changes tab stays in sync.
 */
export const $comments = atom(/** @type {Readonly<Record<string, readonly AgentThread[]>>} */ ({}));

/** Comments of the active project, by path then line: what Send to agent sends. */
export const $queuedComments = computed([$comments, $workspace], (comments, workspace) => {
  if (!workspace) return /** @type {QueuedComment[]} */ ([]);
  const prefix = `${workspace.path}/`;
  return Object.keys(comments)
    .filter((path) => path.startsWith(prefix))
    .sort()
    .flatMap((path) =>
      comments[path]
        .filter((thread) => thread.comments.length > 0)
        .sort((a, b) => a.line - b.line)
        .map((thread) => ({
          path,
          threadId: thread.id,
          commentId: thread.comments[0].id,
          fromLine: thread.fromLine ?? thread.line,
          line: thread.line,
          lineText: thread.lineText ?? '',
          body: thread.comments[0].body,
        })),
    );
});

/**
 * Queued comments of the active tab, what `<acp-comment-bar>` steps through and sends: its file's, or in
 * the Changes tab those of every changed file (each has its editor there). None in other views.
 */
export const $tabComments = computed(
  [$queuedComments, $activePath, $gitChanges, $workspace],
  (queued, active, changes, workspace) => {
    if (active === null || !workspace) return /** @type {QueuedComment[]} */ ([]);
    if (active === CHANGES_TAB_ID) {
      const changed = new Set(changes.files.map((f) => `${workspace.path}/${f.path}`));
      return queued.filter((c) => changed.has(c.path));
    }
    const { kind, path } = parseTabId(active);
    return kind === 'file' ? queued.filter((c) => c.path === path) : [];
  },
);

/** A comment to reveal, set by the bar's arrows; the editor that reveals it clears it. */
export const $commentFocus = atom(/** @type {CommentFocus | null} */ (null));

/**
 * @param {string} path Absolute.
 * @returns {readonly AgentThread[]} The same array until the file's comments change.
 */
export function threadsOf(path) {
  return $comments.get()[path] ?? NONE;
}

/**
 * @param {string} path
 * @param {(threads: readonly AgentThread[]) => readonly AgentThread[]} update
 */
function updateFile(path, update) {
  const comments = $comments.get();
  const threads = update(comments[path] ?? NONE);
  if (threads === comments[path]) return;
  const next = { ...comments };
  if (threads.length) next[path] = threads;
  else delete next[path];
  $comments.set(next);
}

/**
 * Adds a submitted comment as a new thread, under the id the editor gave it (that's how the editor
 * knows its submit was taken).
 * @param {string} path
 * @param {{ threadId: string, fromLine: number, line: number, lineText: string, range: CdxCommentRange | null,
 *   body: string }} draft `fromLine`: first line of `range`, else `line`.
 * @param {CdxCommentAuthor} author
 */
export function addComment(path, { threadId, fromLine, line, lineText, range, body }, author) {
  const comment = { id: crypto.randomUUID(), author, body, createdAt: Date.now() };
  /** @type {AgentThread} */
  const thread = { id: threadId, line, lineText, comments: [comment] };
  if (range) thread.range = range;
  if (fromLine < line) thread.fromLine = fromLine;
  updateFile(path, (threads) => [...threads.filter((t) => t.id !== threadId), thread]);
}

/**
 * @param {string} path
 * @param {string} threadId
 * @param {string} commentId
 * @param {string} body
 */
export function editComment(path, threadId, commentId, body) {
  updateFile(path, (threads) =>
    threads.map((t) =>
      t.id === threadId
        ? { ...t, comments: t.comments.map((c) => (c.id === commentId ? { ...c, body, editedAt: Date.now() } : c)) }
        : t,
    ),
  );
}

/**
 * Deletes a comment; its thread goes with its last comment.
 * @param {string} path
 * @param {string} threadId
 * @param {string} commentId
 */
export function deleteComment(path, threadId, commentId) {
  updateFile(path, (threads) =>
    threads.flatMap((t) => {
      if (t.id !== threadId) return [t];
      const comments = t.comments.filter((c) => c.id !== commentId);
      return comments.length ? [{ ...t, comments }] : [];
    }),
  );
}

/**
 * Send to agent: the comments go to the chat's composer (`addToChat`) and are cleared from the code,
 * in every editor.
 * @param {readonly QueuedComment[]} comments
 */
export function sendToChat(comments) {
  if (!comments.length) return;
  const ids = new Set(comments.map((c) => c.threadId));
  /** @type {Record<string, readonly AgentThread[]>} */
  const next = {};
  for (const [path, threads] of Object.entries($comments.get())) {
    const kept = threads.some((t) => ids.has(t.id)) ? threads.filter((t) => !ids.has(t.id)) : threads;
    if (kept.length) next[path] = kept;
  }
  $comments.set(next);
  addToChat(comments.map(({ path, fromLine, line, body }) => ({ path, fromLine, toLine: line, body })));
}

/**
 * @param {CommentFocus | null} focus
 */
export function focusComment(focus) {
  $commentFocus.set(focus);
}
