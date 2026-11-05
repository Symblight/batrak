import { expect } from '@esm-bundle/chai';
import { git } from '../git.js';

/**
 * @param {string} path
 * @param {Partial<import('../types.js').GitFileStatus>} [fields]
 * @returns {import('../types.js').GitFileStatus}
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
    expect(groups[0].children?.map((c) => [c.label, c.dir]), 'a file: its name and folder').to.deep.equal([['README.md', ''], ['b.js', 'src/a'], ['z.js', 'src']]);
    expect(groups.every((g) => g.file === null && g.dir === ''), 'a group is no file').to.equal(true);

    expect(git.groupChanges([]), 'nothing changed').to.deep.equal([]);
    expect(git.groupChanges([file('a.js')]).map((g) => g.id), 'no untracked group without untracked files').to.deep.equal(['group:changes']);
  });

  it('gives each kind of change its letter, name and color', () => {
    /** @type {[import('../types.js').GitFileKind, string, string][]} */
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

  it('badges a file by its type: known short forms, the first three letters of others, a dot for none', () => {
    /** @type {[string, string][]} */
    const cases = [
      ['app.js', 'JS'],
      ['app.MJS', 'JS'],
      ['view.tsx', 'TSX'],
      ['style.css', '{}'],
      ['package.json', '{}'],
      ['Cargo.toml', 'TOML'],
      ['ci.yml', 'YML'],
      ['notes.markdown', 'MAR'],
      ['Makefile', '·'],
      ['.gitignore', '·'],
    ];
    for (const [name, badge] of cases) expect(git.typeBadge(name), name).to.equal(badge);
  });

  it('writes a renamed file’s old path relative to its folder', () => {
    /** @type {[string, string, string][]} */
    const cases = [
      ['src', 'src/a.js', 'a.js'],
      ['src/new', 'src/old/name.css', '../old/name.css'],
      ['', 'old.js', 'old.js'],
      ['a/b', 'c.js', '../../c.js'],
      ['src', 'src/deep/x.js', 'deep/x.js'],
    ];
    for (const [from, to, expected] of cases) expect(git.relativePath(from, to), `${from} → ${to}`).to.equal(expected);
  });

  it('sorts changed files into rows with their name (the last path segment) and folder, a top-level file with none', () => {
    const rows = git.changeRows([file('src/z.js'), file('a.md'), file('src/a/b.js')]);
    expect(rows.map((r) => [r.id, r.name, r.dir])).to.deep.equal([
      ['a.md', 'a.md', ''],
      ['src/a/b.js', 'b.js', 'src/a'],
      ['src/z.js', 'z.js', 'src'],
    ]);
  });
});
