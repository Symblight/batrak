import { expect } from '@esm-bundle/chai';
import { git } from '../git.js';

/**
 * @param {string} path
 * @param {Partial<import('../../../models/types/types.js').GitFileStatus>} [fields]
 * @returns {import('../../../models/types/types.js').GitFileStatus}
 */
const file = (path, fields = {}) => ({ path, origPath: null, kind: 'modified', staged: false, unstaged: true, added: null, removed: null, ...fields });

describe('git changes', () => {
  it('groups files like git status, each sorted by path, with the line counts summed and empty groups left out', () => {
    const groups = git.groupChanges([
      file('src/z.js', { added: 3, removed: 1 }),
      file('new.txt', { kind: 'untracked' }),
      file('src/a/b.js', { kind: 'added', added: 10, removed: 0 }),
      file('README.md'),
    ]);
    expect(groups.map((g) => [g.id, g.label, g.children?.map((c) => c.id)])).to.deep.equal([
      ['group:changes', 'Changes', ['README.md', 'src/a/b.js', 'src/z.js']],
      ['group:untracked', 'Untracked files', ['new.txt']],
    ]);
    expect([groups[0].added, groups[0].removed], 'summed over the files that have counts').to.deep.equal([13, 1]);
    expect([groups[1].added, groups[1].removed], 'none known stays null').to.deep.equal([null, null]);
    expect(groups.every((g) => g.file === null && g.dir === ''), 'a group is no file').to.equal(true);

    expect(git.groupChanges([]), 'nothing changed').to.deep.equal([]);
    expect(git.groupChanges([file('a.js')]).map((g) => g.id), 'no untracked group without untracked files').to.deep.equal(['group:changes']);
  });

  it('names a file by its last path segment and its folder, a top-level file with no folder', () => {
    const [group] = git.groupChanges([file('top.js'), file('src/components/app.js')]);
    expect(group.children?.map((c) => [c.label, c.dir])).to.deep.equal([
      ['app.js', 'src/components'],
      ['top.js', ''],
    ]);
  });

  it('gives each kind of change its letter, name and color', () => {
    /** @type {[import('../../../models/types/types.js').GitFileKind, string, string][]} */
    const cases = [
      ['modified', 'M', 'Modified'],
      ['typeChanged', 'M', 'Type changed'],
      ['renamed', 'R', 'Renamed'],
      ['added', 'A', 'Added'],
      ['untracked', 'U', 'Untracked'],
      ['deleted', 'D', 'Deleted'],
      ['conflicted', '!', 'Conflicted'],
    ];
    for (const [kind, letter, label] of cases) {
      const status = git.statusOf(kind);
      expect([status.letter, status.label], kind).to.deep.equal([letter, label]);
      expect(status.color, kind).to.match(/^var\(--acp-/);
    }
  });
});
