/**
 * Level of a frontend line in the app log (`write_log`).
 * @typedef {'error' | 'warn' | 'info' | 'debug'} LogLevel
 */

/**
 * @typedef {'error' | 'warn' | 'info'} NoticeLevel
 */

/**
 * Snackbar in the bottom-end corner (`$notices`).
 * @typedef {Object} Notice
 * @property {number} id
 * @property {NoticeLevel} level
 * @property {string} message
 * @property {number} count Times the same message came in while shown.
 * @property {NoticeAction} [action] A button on it (Undo); running it dismisses the notice.
 * @property {number} [timeout] How long it stays, in ms, instead of its level's.
 */

/**
 * @typedef {Object} NoticeAction
 * @property {string} label
 * @property {() => void} run
 */

/** @typedef {'mac' | 'windows' | 'linux'} Platform */

/**
 * What `<acp-confirm-dialog>` asks.
 * @typedef {Object} ConfirmOptions
 * @property {string} headline
 * @property {string} message
 * @property {string} [detail] Secondary line under the message.
 * @property {string} [confirmLabel] Defaults to `OK`.
 * @property {string} [cancelLabel] Defaults to `Cancel`.
 * @property {string} [extraLabel] A third action, between the other two; only `choose()` tells it apart.
 * @property {boolean} [destructive] Colors the confirm action as an error.
 * @property {'center' | 'top'} [placement] Where in the window; defaults to `center`.
 */

/**
 * What `<acp-confirm-dialog>`'s `choose()` resolves to: the confirm action, the extra one, or neither.
 * @typedef {'confirm' | 'extra' | 'cancel'} ConfirmChoice
 */

export {};
