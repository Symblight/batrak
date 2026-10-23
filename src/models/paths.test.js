import { expect } from '@esm-bundle/chai';
import { basename, shownPath } from './paths.js';

describe('paths', () => {
  it('takes the last segment', () => {
    expect(basename('/p/src/main.js')).to.equal('main.js');
    expect(basename('C:\\p\\a.txt')).to.equal('a.txt');
  });

  describe('shownPath', () => {
    const worktrees = [{ sessionId: 's1', projectId: '/p', folder: '/w/s1', branch: 'b', title: 'T' }];

    it("shows a project file relative to the project, a worktree's to its folder", () => {
      expect(shownPath('/p', worktrees, '/p/src/a.js')).to.equal('src/a.js');
      expect(shownPath('/p', worktrees, '/w/s1/src/a.js')).to.equal('src/a.js');
    });

    it('keeps any other path absolute', () => {
      expect(shownPath('/p', worktrees, '/elsewhere/a.js')).to.equal('/elsewhere/a.js');
      expect(shownPath(null, [], '/p/a.js')).to.equal('/p/a.js');
    });
  });
});
