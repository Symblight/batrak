import { USER_ID, acpAdapter, forgetHistory, handleSessionEvent, promptOf } from './adapter.js';
import { cliInput, cliPromptOf } from './cli-input.js';
import { saveAttachment, sessionChanges, sessionFileAtBase } from './commands.js';
import { controller } from './controller.js';
import { input } from './input.js';
import { inputOfComposer } from './input-parts.js';
import { root } from './root.js';
import * as rules from './rules.js';

/**
 * Agent sessions: showing, syncing, starting and removing them, what the user gives one (Chat or
 * its CLI), how their events become chat messages, and the rules about them.
 */
export const sessions = Object.freeze({
  ...rules,
  ...controller,
  ...input,
  inputOfComposer,
  cliInput,
  cliPromptOf,

  USER_ID,
  /** The adapter `<chx-chat>` talks to: sends prompts and replays a session's messages. */
  adapter: acpAdapter,
  promptOf,
  handleSessionEvent,
  forgetHistory,

  saveAttachment,
  /** A worktree session's changed files since it started. */
  changes: sessionChanges,
  /** A worktree session's file at the commit it started from. */
  fileAtBase: sessionFileAtBase,

  /** Starts keeping the active worktree session's folder open for the Files tree. */
  followRoot: root.start,
  onRootFsChange: root.onFsChange,
});
