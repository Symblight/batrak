import { expect } from '@esm-bundle/chai';
import { shellPaths } from '../shell-paths.js';

describe('shellPaths', () => {
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
      expect(shellPaths(/** @type {string[]} */ (paths), 'windows'), JSON.stringify(paths)).to.equal(expected);
    }
  });
});
