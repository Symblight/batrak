import { expect } from '@esm-bundle/chai';
import { git } from '../git.js';

/**
 * @param {string} path
 * @param {Partial<import('../types.js').GitFileStatus>} [fields]
 * @returns {import('../types.js').GitFileStatus}
 */
const file = (path, fields = {}) => ({ path, origPath: null, kind: 'modified', staged: false, unstaged: true, added: null, removed: null, ...fields });

describe('git changes', () => {
  it('builds a diff from its two reads, or says why there is none', async () => {
    const shown = (/** @type {string} */ content, /** @type {string} */ baseline, error = '') => ({ content, baseline, error, loading: false });
    const failing = () => Promise.reject('a.bin: binary, no diff to show');
    const table = [
      ['edited', false, Promise.resolve('new'), Promise.resolve('old'), shown('new', 'old')],
      ['new', false, Promise.resolve('new'), Promise.resolve(null), shown('new', '')],
      ['deleted', true, failing(), Promise.resolve('old'), shown('', 'old')],
      ['gone, listed as something else', false, Promise.reject('a.js: No such file or directory (os error 2)'), Promise.resolve('old'), shown('', 'old')],
      ['gone with its folder, on Windows', false, Promise.reject('a.js: The system cannot find the path specified. (os error 3)'), Promise.resolve('old'), shown('', 'old')],
      ['turned binary', false, failing(), Promise.resolve('old'), shown('', '', 'a.bin: binary, no diff to show')],
      ['untracked binary', false, failing(), Promise.resolve(null), shown('', '', 'a.bin: binary, no diff to show')],
      ['committed binary', false, Promise.resolve('text'), failing(), shown('', '', 'a.bin: binary, no diff to show')],
    ];
    for (const [name, deleted, file, base, expected] of table) {
      const diff = await git.readDiff(/** @type {Promise<string>} */ (file), /** @type {Promise<string | null>} */ (base), /** @type {boolean} */ (deleted));
      expect(diff, String(name)).to.deep.equal(expected);
    }
  });

  it('words the uncommitted files hint for one file and for several', () => {
    const cases = [
      [1, { label: 'Review 1 uncommitted file', value: 'Review the uncommitted file' }],
      [3, { label: 'Review 3 uncommitted files', value: 'Review the 3 uncommitted files' }],
    ];
    for (const [count, expected] of cases) {
      // Act
      const hint = git.uncommittedHint(/** @type {number} */ (count));
      // Assert
      expect(hint).to.deep.equal(expected);
    }
  });

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

  it('asks about a revert in the terms of what it does to the file', () => {
    // Arrange
    /** @type {[import('../types.js').GitFileStatus, string, string, RegExp][]} */
    const cases = [
      [file('src/a.js'), 'Revert a.js?', 'Revert', /back to HEAD/],
      [file('src/a.js', { kind: 'deleted' }), 'Revert a.js?', 'Revert', /back to HEAD/],
      [file('src/a.js', { kind: 'added' }), 'Delete new file a.js?', 'Delete', /isn’t in HEAD/],
      [file('src/a.js', { kind: 'untracked' }), 'Delete new file a.js?', 'Delete', /isn’t in HEAD/],
      [file('src/a.js', { kind: 'renamed', origPath: 'old/a.js' }), 'Revert a.js?', 'Revert', /old\/a\.js/],
    ];
    for (const [changed, headline, confirmLabel, message] of cases) {
      // Act
      const prompt = git.revertPrompt(changed);
      // Assert
      expect([prompt.headline, prompt.confirmLabel, prompt.destructive], changed.kind).to.deep.equal([headline, confirmLabel, true]);
      expect(prompt.message, changed.kind).to.match(message);
      expect(prompt.detail, changed.kind).to.include('refs/batrak/reverted');
    }
  });

  it('says where a renamed file came from: the folder when its name stayed, else its old path', () => {
    /** @type {[string, string, string, { from: string, to: string }][]} */
    const cases = [
      ['.bt', 'agents.json', '.brama/agents.json', { from: '.brama', to: '.bt' }],
      ['src', 'a.js', 'a.js', { from: '.', to: 'src' }],
      ['', 'a.js', 'src/a.js', { from: 'src', to: '.' }],
      ['src', 'new.js', 'src/old.js', { from: 'src/old.js', to: 'src' }],
      ['', 'new.js', 'old.js', { from: 'old.js', to: '.' }],
    ];
    for (const [dir, name, origPath, expected] of cases) expect(git.renameLabel(dir, name, origPath), origPath).to.deep.equal(expected);
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
