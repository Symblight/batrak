/** @typedef {import('./types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('./types.js').GitFileKind} GitFileKind */
/** @typedef {'changes' | 'untracked'} ChangeGroup */

/**
 * A row of the changes list: a group (as in `git status`: tracked changes, untracked files) or a
 * changed file in it. Files are what a commit takes.
 * @typedef {Object} ChangeNode
 * @property {string} id A file's root-relative path; `group:<name>` for a group.
 * @property {string} label File name, or the group's title.
 * @property {string} dir Folder of a file, relative to the root (`''` at the top); `''` for a group.
 * @property {GitFileStatus | null} file `null` for a group.
 * @property {number | null} added Summed over a group; `null` when no count is known.
 * @property {number | null} removed
 * @property {ChangeNode[]} [children] Groups only.
 */

/** @type {Record<GitFileKind, { letter: string, label: string, color: string }>} */
const STATUS = {
  modified: { letter: 'M', label: 'Modified', color: 'var(--acp-color-primary)' },
  typeChanged: { letter: 'M', label: 'Type changed', color: 'var(--acp-color-primary)' },
  renamed: { letter: 'R', label: 'Renamed', color: 'var(--acp-color-primary)' },
  added: { letter: 'A', label: 'Added', color: 'var(--acp-vcs-add)' },
  untracked: { letter: 'U', label: 'Untracked', color: 'var(--acp-vcs-add)' },
  deleted: { letter: 'D', label: 'Deleted', color: 'var(--acp-color-error)' },
  conflicted: { letter: '!', label: 'Conflicted', color: 'var(--acp-color-error)' },
};

/** @type {Record<ChangeGroup, string>} */
const GROUP_TITLES = { changes: 'Changes', untracked: 'Untracked files' };

/**
 * @param {number | null} a
 * @param {number | null} b
 */
function sum(a, b) {
  return a === null ? b : b === null ? a : a + b;
}

/**
 * How a file's status shows: its letter, name and color.
 * @param {GitFileKind} kind
 */
export function statusOf(kind) {
  return STATUS[kind];
}

/**
 * The uncommitted files hint: what its button says, and the prompt it puts in the composer.
 * @param {number} count
 * @returns {{ label: string, value: string }}
 */
export function uncommittedHint(count) {
  return count === 1
    ? { label: 'Review 1 uncommitted file', value: 'Review the uncommitted file' }
    : { label: `Review ${count} uncommitted files`, value: `Review the ${count} uncommitted files` };
}

/**
 * Groups changed files like `git status`: tracked changes, then untracked files; each sorted by
 * path, with line counts summed per group. Empty groups are left out.
 * @param {readonly GitFileStatus[]} files
 * @returns {ChangeNode[]}
 */
export function groupChanges(files) {
  /** @type {Record<ChangeGroup, ChangeNode[]>} */
  const byGroup = { changes: [], untracked: [] };
  for (const file of files) {
    const id = file.path;
    const slash = id.lastIndexOf('/');
    byGroup[file.kind === 'untracked' ? 'untracked' : 'changes'].push({
      id,
      label: slash === -1 ? id : id.slice(slash + 1),
      dir: slash === -1 ? '' : id.slice(0, slash),
      file,
      added: file.added,
      removed: file.removed,
    });
  }
  /** @type {ChangeGroup[]} */
  const order = ['changes', 'untracked'];
  return order
    .filter((group) => byGroup[group].length > 0)
    .map((group) => {
      const children = byGroup[group].sort((a, b) => a.id.localeCompare(b.id));
      /** @type {number | null} */
      let added = null;
      /** @type {number | null} */
      let removed = null;
      for (const child of children) {
        added = sum(added, child.added);
        removed = sum(removed, child.removed);
      }
      return { id: `group:${group}`, label: GROUP_TITLES[group], dir: '', file: null, added, removed, children };
    });
}

/**
 * A changed file as a row of the Changes tab.
 * @typedef {Object} ChangeRow
 * @property {string} id The file's root-relative path.
 * @property {string} name File name.
 * @property {string} dir Its folder, relative to the root; `''` at the top.
 * @property {GitFileStatus} file
 */

/** Monospace badge of a file's type; no language colours, the badge only names the type. */
const TYPE_BADGES = /** @type {Record<string, string>} */ ({
  js: 'JS',
  mjs: 'JS',
  cjs: 'JS',
  jsx: 'JSX',
  ts: 'TS',
  tsx: 'TSX',
  rs: 'RS',
  css: '{}',
  scss: '{}',
  json: '{}',
  html: '<>',
  md: 'MD',
  toml: 'TOML',
  yaml: 'YML',
  yml: 'YML',
});

/**
 * The badge naming a file's type: known extensions by their usual short form, others by their
 * first three letters, `·` for a name without one.
 * @param {string} name
 */
export function typeBadge(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '·';
  const ext = name.slice(dot + 1).toLowerCase();
  return TYPE_BADGES[ext] ?? ext.slice(0, 3).toUpperCase();
}

/**
 * Path of `to` relative to the folder `from`, both root-relative: `../old/name.css`.
 * @param {string} from
 * @param {string} to
 */
export function relativePath(from, to) {
  const a = from ? from.split('/') : [];
  const b = to.split('/');
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}

/** The read failed for the file not being there: Rust's `NotFound` errors, on every platform. */
const GONE = /\(os error [23]\)$/;

/**
 * An expanded file's diff from its two reads. A missing baseline is a new file. A read that fails says
 * why there is no diff, unless it failed for the file being gone: listed as deleted, or as a rename
 * or a conflict whose file is gone too, or deleted since it was listed.
 * @param {Promise<string>} file The file now.
 * @param {Promise<string | null>} base The file it's compared to; `null` when it wasn't there.
 * @param {boolean} deleted It's listed as deleted.
 * @returns {Promise<import('../tabs/types.js').FileDiff>}
 */
export async function readDiff(file, base, deleted) {
  const [content, baseline] = await Promise.allSettled([file, base]);
  /** @param {unknown} reason */
  const failed = (reason) => ({ content: '', baseline: '', error: String(reason), loading: false });
  if (baseline.status === 'rejected') return failed(baseline.reason);
  if (content.status === 'rejected' && !deleted && !GONE.test(String(content.reason))) return failed(content.reason);
  return { content: content.status === 'fulfilled' ? content.value : '', baseline: baseline.value ?? '', error: '', loading: false };
}

/**
 * Changed files as the Changes tab's rows, sorted by path.
 * @param {readonly GitFileStatus[]} files
 * @returns {ChangeRow[]}
 */
export function changeRows(files) {
  return files
    .map((file) => {
      const id = file.path;
      const slash = id.lastIndexOf('/');
      return { id, name: slash === -1 ? id : id.slice(slash + 1), dir: slash === -1 ? '' : id.slice(0, slash), file };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
