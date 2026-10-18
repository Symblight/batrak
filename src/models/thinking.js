/**
 * A thought's title, when the agent opens it with a bold line (`**Checking the pin**`), and the rest.
 * @param {string} text
 * @returns {{ title: string, body: string }}
 */
export function splitThought(text) {
  const match = /^\s*\*\*([^*\n]+)\*\*[ \t]*(?:\n+|$)/.exec(text);
  return match ? { title: match[1].trim(), body: text.slice(match[0].length) } : { title: '', body: text };
}

/**
 * Elapsed time as the thinking part shows it: `''` under a second, `12s`, `2m 5s`.
 * @param {number} ms
 */
export function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return '';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
