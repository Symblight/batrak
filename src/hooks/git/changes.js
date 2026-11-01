/** @typedef {import('../../models/types/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../../models/types/types.js').GitFileKind} GitFileKind */
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
