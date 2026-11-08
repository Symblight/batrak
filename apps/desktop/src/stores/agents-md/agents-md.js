import { atom } from 'nanostores';

/** The draft whose offer to create AGENTS.md was dismissed. Per window, and not kept: it only hides the offer on that view. */
export const $agentsMdDismissedDraft = atom(/** @type {string | null} */ (null));

/** @param {string | null} draftId */
export function dismissAgentsMd(draftId) {
  $agentsMdDismissedDraft.set(draftId);
}

/** A new session offers it again, also on a draft it reuses (`newSession()`). */
export function offerAgentsMdAgain() {
  $agentsMdDismissedDraft.set(null);
}
