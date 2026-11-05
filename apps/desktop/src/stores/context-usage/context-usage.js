import { computed } from 'nanostores';
import { isRecord, persistentMapStore } from '../persistent/persistent.js';
import { $activeSessionId } from '../sessions/sessions.js';

/** @typedef {import('../../hooks/sessions/types.js').ContextUsage} ContextUsage */

/**
 * A stored usage, tokens only (a cost the agent reported is dropped); `null` when it can't be read.
 * @param {unknown} raw
 * @returns {ContextUsage | null}
 */
export function parseContextUsage(raw) {
  if (!isRecord(raw) || typeof raw.used !== 'number' || typeof raw.size !== 'number') return null;
  return { used: raw.used, size: raw.size };
}

/**
 * Each session's last `usage_update`, by session id: written only while its agent runs, kept across
 * reloads and restarts (an agent reports nothing when it loads a session again).
 */
export const $contextUsage = persistentMapStore('batrak:sessions:context-usage:', parseContextUsage);

/** The active session's context usage; `null` for a draft or before its agent reported one. */
export const $activeContextUsage = computed([$contextUsage, $activeSessionId], (usage, id) => (id === null ? null : (usage[id] ?? null)));

/**
 * @param {string} sessionId
 * @param {ContextUsage} usage As the agent reported it; only the tokens are kept.
 */
export function setContextUsage(sessionId, usage) {
  $contextUsage.setKey(sessionId, { used: usage.used, size: usage.size });
}

/** @param {string} sessionId A removed session's. */
export function forgetContextUsage(sessionId) {
  $contextUsage.setKey(sessionId, undefined);
}
