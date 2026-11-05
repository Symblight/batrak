/**
 * A line comment for the agent, as the editors show it (`<cdx-comments>`, controlled). Queued until
 * Send to agent, which removes it. `fromLine`: first line of the selection it was made on (`line` is
 * the last, where the editor shows it); absent for one line.
 * @typedef {import('@symblight/code-editor').CdxThread & { fromLine?: number }} AgentThread
 */

/**
 * A queued comment, one per thread (comments are `mode="single"`), in Send-to-agent order.
 * @typedef {Object} QueuedComment
 * @property {string} path File, absolute.
 * @property {string} threadId
 * @property {string} commentId
 * @property {number} fromLine 1-based; `line` for a one-line comment.
 * @property {number} line 1-based, the last line.
 * @property {string} lineText
 * @property {string} body
 */

/**
 * A comment to scroll to: the editor showing its file reveals it, opening the file first if needed.
 * @typedef {Object} CommentFocus
 * @property {string} path Absolute.
 * @property {string} threadId
 */

export {};
