import { isRecord, persistentMapStore } from '../persistent/persistent.js';

/** @typedef {import('../../hooks/markdown/types.js').MarkdownMode} MarkdownMode */
/** @typedef {Record<string, MarkdownMode>} FileModes A project's files' modes, by root-relative path. */

/** @type {readonly MarkdownMode[]} */
export const MARKDOWN_MODES = ['raw', 'split', 'preview'];

/**
 * @param {unknown} mode
 * @returns {mode is MarkdownMode}
 */
export function isMarkdownMode(mode) {
  return MARKDOWN_MODES.includes(/** @type {MarkdownMode} */ (mode));
}

/**
 * @param {unknown} raw What was stored for a project.
 * @returns {FileModes | null} The valid entries; `null` when there are none.
 */
export function parseModes(raw) {
  if (!isRecord(raw)) return null;
  /** @type {FileModes} */
  const modes = {};
  for (const [path, mode] of Object.entries(raw)) if (isMarkdownMode(mode)) modes[path] = mode;
  return Object.keys(modes).length > 0 ? modes : null;
}

/**
 * Each markdown file's mode by project path, one storage item per project; per window, like the tabs.
 * Only modes other than the default are kept. Written only through `setKey()`.
 */
export const $markdownModes = persistentMapStore('batrak:markdown:mode:', parseModes);

/**
 * @param {string | null} projectPath
 * @param {string} path Root-relative.
 * @param {MarkdownMode} fallback What a file never set shows (the Settings default).
 * @returns {MarkdownMode}
 */
export function modeOf(projectPath, path, fallback) {
  return (projectPath === null ? undefined : $markdownModes.get()[projectPath]?.[path]) ?? fallback;
}

/**
 * Remembers how a file is shown; setting it to the default forgets it.
 * @param {string} projectPath
 * @param {string} path Root-relative.
 * @param {MarkdownMode} mode
 * @param {MarkdownMode} fallback The Settings default.
 */
export function setMode(projectPath, path, mode, fallback) {
  const modes = { ...$markdownModes.get()[projectPath] };
  if (mode === fallback) delete modes[path];
  else modes[path] = mode;
  write(projectPath, modes);
}

/**
 * Drops the entries of files that are gone or were renamed.
 * @param {string} projectPath
 * @param {(path: string) => boolean} exists Root-relative path → still a file of the project.
 */
export function pruneModes(projectPath, exists) {
  const modes = $markdownModes.get()[projectPath];
  if (!modes) return;
  write(projectPath, Object.fromEntries(Object.entries(modes).filter(([path]) => exists(path))));
}

/**
 * @param {string} projectPath
 * @param {FileModes} modes
 */
function write(projectPath, modes) {
  const before = $markdownModes.get()[projectPath] ?? {};
  const same = Object.keys(modes).length === Object.keys(before).length && Object.entries(modes).every(([path, mode]) => before[path] === mode);
  if (same) return;
  $markdownModes.setKey(projectPath, Object.keys(modes).length > 0 ? modes : undefined);
}
