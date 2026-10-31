import { expect } from '@esm-bundle/chai';
import { shellPaths } from './shell-paths.js';

describe('shellPaths', () => {
  it('types a POSIX path as is, followed by a space', () => {
    expect(shellPaths(['/Users/me/shot.png'], 'mac')).to.equal('/Users/me/shot.png ');
  });

  it('backslash-escapes spaces, tabs and shell metacharacters on POSIX', () => {
    expect(shellPaths(['/Users/me/Screen Shot 1.png'], 'mac')).to.equal('/Users/me/Screen\\ Shot\\ 1.png ');
    expect(shellPaths(['/tmp/a\tb'], 'linux')).to.equal('/tmp/a\\\tb ');
    expect(shellPaths([`/x/'"\\$\`!&*()[]{};<>?|#~`], 'linux')).to.equal(
      `/x/\\'\\"\\\\\\$\\\`\\!\\&\\*\\(\\)\\[\\]\\{\\}\\;\\<\\>\\?\\|\\#\\~ `,
    );
  });

  it('keeps unicode as is', () => {
    expect(shellPaths(['/Users/me/Документы/café 😀.txt'], 'mac')).to.equal('/Users/me/Документы/café\\ 😀.txt ');
    expect(shellPaths(['C:\\Users\\me\\Документы\\café.txt'], 'windows')).to.equal('C:\\Users\\me\\Документы\\café.txt ');
  });

  it('separates several paths by spaces, with one trailing space', () => {
    expect(shellPaths(['/a/one.png', '/b/two dir'], 'mac')).to.equal('/a/one.png /b/two\\ dir ');
    expect(shellPaths(['C:\\a.png', 'D:\\My Files'], 'windows')).to.equal('C:\\a.png "D:\\My Files" ');
  });

  it('wraps a Windows path in double quotes when it has a space or a cmd/PowerShell special character', () => {
    expect(shellPaths(['C:\\Users\\me\\shot.png'], 'windows')).to.equal('C:\\Users\\me\\shot.png ');
    expect(shellPaths(['C:\\Program Files\\x.exe'], 'windows')).to.equal('"C:\\Program Files\\x.exe" ');
    for (const c of "&()[]{}^=;!'+,`~%") {
      expect(shellPaths([`C:\\a${c}b`], 'windows'), c).to.equal(`"C:\\a${c}b" `);
    }
  });

  it('types nothing for no paths', () => {
    expect(shellPaths([], 'mac')).to.equal('');
    expect(shellPaths([], 'windows')).to.equal('');
  });
});
