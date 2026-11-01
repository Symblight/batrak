import { expect } from '@esm-bundle/chai';
import { folderLabel, newTerminalFolder, projectTerminalFolder, sessionTerminalFolder, shellPaths } from '../rules.js';

/** @typedef {import('../../../models/types/types.js').Session} Session */

/**
 * @param {Partial<Session>} fields
 * @returns {Session}
 */
function session(fields) {
  return /** @type {Session} */ ({ id: 's', projectId: '/p', mode: 'local', folder: '/p', worktreePath: null, ...fields });
}

describe('terminals: rules', () => {
  it('starts each kind of terminal in the session’s folder, the project, or home', () => {
    // Arrange
    const home = '/Users/me';
    const wt = session({ mode: 'worktree', folder: '/wt/s1/app', worktreePath: '/wt/s1' });
    const cases = [
      ['new, in a worktree session', newTerminalFolder({ activeFolder: '/wt/s1/app', project: '/p', home }), { cwd: '/wt/s1/app', fallback: '/p' }],
      ['new, in a local session', newTerminalFolder({ activeFolder: '/p', project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['new, in a draft', newTerminalFolder({ activeFolder: null, project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['new, with no project', newTerminalFolder({ activeFolder: null, project: null, home }), { cwd: home, fallback: null }],
      ['project', projectTerminalFolder({ project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['project, with no project', projectTerminalFolder({ project: null, home }), { cwd: home, fallback: null }],
      ['a worktree session’s', sessionTerminalFolder(wt), { cwd: '/wt/s1/app', fallback: '/p' }],
      ['a local session’s', sessionTerminalFolder(session({})), { cwd: '/p', fallback: '/p' }],
    ];
    for (const [why, folder, expected] of cases) {
      // Act + Assert
      expect(folder, String(why)).to.deep.equal(expected);
    }
  });

  it('names a folder after itself, or a worktree’s after the worktree (either separator)', () => {
    // Arrange
    const posix = [session({ mode: 'worktree', folder: '/wt/brama-1a2b/app', worktreePath: '/wt/brama-1a2b' })];
    const windows = [session({ mode: 'worktree', folder: 'C:\\wt\\brama-1a2b\\app', worktreePath: 'C:\\wt\\brama-1a2b' })];
    const cases = [
      ['/home/me/app', posix, 'app'],
      ['/wt/brama-1a2b/app', posix, 'brama-1a2b'],
      ['/wt/brama-1a2b', posix, 'brama-1a2b'],
      ['/wt/brama-1a2bc', posix, 'brama-1a2bc'],
      ['C:\\wt\\brama-1a2b\\app', windows, 'brama-1a2b'],
      ['C:\\wt\\brama-1a2bc', windows, 'brama-1a2bc'],
    ];
    for (const [folder, sessions, label] of cases) {
      // Act + Assert
      expect(folderLabel(/** @type {string} */ (folder), /** @type {Session[]} */ (sessions)), String(folder)).to.equal(label);
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
});
