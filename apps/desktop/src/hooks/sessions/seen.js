import { computed } from 'nanostores';
import { $hiddenColumns } from '../../stores/layout/layout.js';
import { $sessionReads, markSeen } from '../../stores/session-read/session-read.js';
import { $activeSessionId, $sessions } from '../../stores/sessions/sessions.js';

/** The column the shown session's chat or CLI is in. */
const AGENT_COLUMN = 'agent';

/** The user can see the shown session: the page is visible, the window has focus and the agent column isn't hidden. */
function isSeen() {
  return document.visibilityState === 'visible' && document.hasFocus() && !$hiddenColumns.get().includes(AGENT_COLUMN);
}

/**
 * Keeps the read mark of the session this window shows at `seen = now` while the user sees it, and
 * writes it once more when it stops being seen (another session shown, window hidden or blurred,
 * column hidden). `markSeen()` skips a session seen within the last second, so a write's own
 * change of the mark ends the loop at once.
 * @returns {() => void} Stops tracking.
 */
export function trackSeen() {
  /** @type {string | null} The session seen at the last check. */
  let seen = null;
  const update = () => {
    const active = $activeSessionId.get();
    const now = active !== null && isSeen() ? active : null;
    if (seen !== null && seen !== now) markSeen(seen);
    seen = now;
    if (now !== null) markSeen(now);
  };
  const activity = computed([$activeSessionId, $sessions], (id, list) => list.find((s) => s.id === id)?.lastActivityAt ?? null);
  const mark = computed([$activeSessionId, $sessionReads], (id, reads) => (id === null ? undefined : reads[id]?.seen));
  const stops = [$activeSessionId, $hiddenColumns, activity, mark].map((store) => store.listen(update));
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    for (const stop of stops) stop();
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
  };
}
