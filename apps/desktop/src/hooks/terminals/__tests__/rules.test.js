import { expect } from '@esm-bundle/chai';
import { fileLinks, folderLabel, fontStack, newTerminalFolder, oneLine, resolveFile, runsLines, safePaste, sessionTerminalFolder, shellPaths, validFind } from '../rules.js';

/** @typedef {import('../../sessions/types.js').Session} Session */

/**
 * @param {Partial<Session>} fields
 * @returns {Session}
 */
function session(fields) {
  return /** @type {Session} */ ({ id: 's', projectId: '/p', folder: '/p', ...fields });
}

describe('terminals: rules', () => {
  it('starts each kind of terminal in the shown folder, a session’s, the project, or home', () => {
    // Arrange
    const home = '/Users/me';
    const wt = session({ workspaceId: 'w1', folder: '/wt/s1/app' });
    const cases = [
      ['new, in a workspace', newTerminalFolder({ folder: '/wt/s1/app', project: '/p', home }), { cwd: '/wt/s1/app', fallback: '/p' }],
      ['new, in Main', newTerminalFolder({ folder: '/p', project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['new, while the workspace loads', newTerminalFolder({ folder: null, project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['new, with no project', newTerminalFolder({ folder: null, project: null, home }), { cwd: home, fallback: null }],
      ['a worktree session’s', sessionTerminalFolder(wt), { cwd: '/wt/s1/app', fallback: '/p' }],
      ['a local session’s', sessionTerminalFolder(session({})), { cwd: '/p', fallback: '/p' }],
    ];
    for (const [why, folder, expected] of cases) {
      // Act + Assert
      expect(folder, String(why)).to.deep.equal(expected);
    }
  });

  it('names a folder after itself, or a workspace’s after its worktree (either separator)', () => {
    // Arrange
    const posix = [{ worktreePath: '/wt/batrak-1a2b' }];
    const windows = [{ worktreePath: 'C:\\wt\\batrak-1a2b' }];
    const cases = [
      ['/home/me/app', posix, 'app'],
      ['/wt/batrak-1a2b/app', posix, 'batrak-1a2b'],
      ['/wt/batrak-1a2b', posix, 'batrak-1a2b'],
      ['/wt/batrak-1a2bc', posix, 'batrak-1a2bc'],
      ['C:\\wt\\batrak-1a2b\\app', windows, 'batrak-1a2b'],
      ['C:\\wt\\batrak-1a2bc', windows, 'batrak-1a2bc'],
    ];
    for (const [folder, workspaces, label] of cases) {
      // Act + Assert
      expect(folderLabel(/** @type {string} */ (folder), /** @type {{ worktreePath: string }[]} */ (workspaces)), String(folder)).to.equal(label);
    }
  });

  it('types POSIX paths escaped with backslashes, unicode as is, each followed by a space', () => {
    const cases = [
      ['plain', ['/Users/me/shot.png'], 'mac', '/Users/me/shot.png '],
      ['space', ['/Users/me/Screen Shot 1.png'], 'mac', '/Users/me/Screen\\ Shot\\ 1.png '],
      ['tab', ['/tmp/a\tb'], 'linux', '/tmp/a\\\tb '],
      [
        'metacharacters',
        [`/x/'"\\$\`!&*()[]{};<>?|#~`],
        'linux',
        `/x/\\'\\"\\\\\\$\\\`\\!\\&\\*\\(\\)\\[\\]\\{\\}\\;\\<\\>\\?\\|\\#\\~ `,
      ],
      ['unicode', ['/Users/me/Документы/café 😀.txt'], 'mac', '/Users/me/Документы/café\\ 😀.txt '],
      ['several', ['/a/one.png', '/b/two dir'], 'mac', '/a/one.png /b/two\\ dir '],
      ['none', [], 'mac', ''],
    ];
    for (const [why, paths, platform, expected] of cases) {
      // Act + Assert
      expect(shellPaths(/** @type {string[]} */ (paths), /** @type {any} */ (platform)), String(why)).to.equal(expected);
    }
  });

  it('wraps a Windows path in double quotes when it has a space or a cmd/PowerShell special character', () => {
    const cases = [
      [['C:\\Users\\me\\shot.png'], 'C:\\Users\\me\\shot.png '],
      [['C:\\Users\\me\\Документы\\café.txt'], 'C:\\Users\\me\\Документы\\café.txt '],
      [['C:\\Program Files\\x.exe'], '"C:\\Program Files\\x.exe" '],
      [['C:\\a.png', 'D:\\My Files'], 'C:\\a.png "D:\\My Files" '],
      [[], ''],
      ...[..."&()[]{}^=;!'+,`~%"].map((c) => [[`C:\\a${c}b`], `"C:\\a${c}b" `]),
    ];
    for (const [paths, expected] of cases) {
      // Act + Assert
      expect(shellPaths(/** @type {string[]} */ (paths), 'windows'), JSON.stringify(paths)).to.equal(expected);
    }
  });

  it('takes control over a paste away from what was copied', () => {
    expect(safePaste('a\x1b[201~b\x1b'), 'no ESC').to.equal('a[201~b');
    const lines = [
      // [text, one line, its line breaks would run in a plain program]
      ['ls', 'ls', false],
      ['a\nb', 'a b', true],
      ['a\r\nb', 'a b', true],
      ['a\rb', 'a b', true],
    ];
    for (const [text, line, runs] of lines) {
      expect(oneLine(/** @type {string} */ (text)), JSON.stringify(text)).to.equal(line);
      expect(runsLines(/** @type {string} */ (text), false), JSON.stringify(text)).to.equal(runs);
      expect(runsLines(/** @type {string} */ (text), true), 'a bracketed paste runs nothing').to.equal(false);
    }
  });

  it('stacks a picked font on the app’s monospace fonts, which are the default', () => {
    const cases = [
      // [picked, the app's stack, the stack xterm gets]
      ['Fira Code', 'Google Sans Code, monospace', '"Fira Code", Google Sans Code, monospace'],
      [null, 'Google Sans Code, monospace', 'Google Sans Code, monospace'],
      [null, '', 'monospace'],
      ['Fira Code', '', '"Fira Code", monospace'],
    ];
    for (const [picked, mono, stack] of cases) {
      expect(fontStack(picked, /** @type {string} */ (mono)), JSON.stringify([picked, mono])).to.equal(stack);
    }
  });

  it('takes any text as a find, and only a well-formed regular expression', () => {
    expect(validFind('(', false)).to.equal(true);
    expect(validFind('(', true)).to.equal(false);
    expect(validFind('(a)', true)).to.equal(true);
  });

  it('finds files named in a line of output, with the cells they take across its rows', () => {
    const cases = [
      // [why, text, cols, links as [path, line, startX, startY, endX, endY], 1-based and inclusive]
      ['with a line', 'at src/a.js:12 now', 80, [['src/a.js', 12, 4, 1, 14, 1]]],
      ['with no line', 'see src/a.js.', 80, [['src/a.js', null, 5, 1, 12, 1]]],
      ['absolute', '/p/a.js:3', 80, [['/p/a.js', 3, 1, 1, 9, 1]]],
      ['across rows', 'xxxxx src/long/a.js:7', 10, [['src/long/a.js', 7, 7, 1, 1, 3]]],
      ['two', 'a/b.js c/d.js:1', 80, [['a/b.js', null, 1, 1, 6, 1], ['c/d.js', 1, 8, 1, 15, 1]]],
      ['a web address is not a file', 'https://a.test/x.js', 80, []],
      ['a word is not a file', 'and/or 1.2.3 app.js', 80, []],
      ['a folder is not a file', '@src/', 80, []],
    ];
    for (const [why, text, cols, links] of cases) {
      const found = fileLinks(/** @type {string} */ (text), /** @type {number} */ (cols), 'mac');
      const shape = found.map(({ path, line, start, end }) => [path, line, start.x, start.y, end.x, end.y]);
      expect(shape, /** @type {string} */ (why)).to.deep.equal(links);
    }
  });

  it('on Windows, finds files with backslashes and drives too, and resolves them from the shell’s folder', () => {
    const links = [
      // [text, path, line, startX, endX]
      ['at C:\\p\\a.js:12 now', 'C:\\p\\a.js', 12, 4, 15],
      ['src\\a.js(7,2): error', 'src\\a.js', 7, 1, 13],
      ['src/a.js:3.', 'src/a.js', 3, 1, 10],
      ['a.js:9', 'a.js', 9, 1, 6],
    ];
    for (const [text, path, line, startX, endX] of links) {
      const [found] = fileLinks(/** @type {string} */ (text), 80, 'windows');
      expect([found?.path, found?.line, found?.start.x, found?.end.x], /** @type {string} */ (text)).to.deep.equal([path, line, startX, endX]);
    }
    for (const text of ['https://a.test/x.js', 'a.js', 'and\\or', '1.2.3']) {
      expect(fileLinks(text, 80, 'windows'), text).to.deep.equal([]);
    }
    const paths = [
      // [path, cwd, absolute]
      ['src\\a.js', 'C:\\p', 'C:\\p\\src\\a.js'],
      ['src/a.js', 'C:\\p\\', 'C:\\p\\src\\a.js'],
      ['..\\a.js', 'C:\\p\\q', 'C:\\p\\a.js'],
      ['D:\\x\\.\\a.js', 'C:\\p', 'D:\\x\\a.js'],
      ['\\x\\a.js', 'C:\\p', null],
      ['..\\..\\a.js', 'C:\\p', null],
      ['a.js', null, null],
    ];
    for (const [path, cwd, absolute] of paths) {
      expect(resolveFile(/** @type {string} */ (path), cwd, 'windows'), /** @type {string} */ (path)).to.equal(absolute);
    }
    expect(resolveFile('src/a.js', '/p', 'linux')).to.equal('/p/src/a.js');
  });
});
