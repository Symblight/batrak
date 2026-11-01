import { expect } from '@esm-bundle/chai';
import { projects } from '../projects.js';

const { abs, basename, isAbsolute, projectPathOf, rel, shownPath, worktreeOf } = projects;

describe('projects: path rules', () => {
  it('joins a root and a relative path, and splits them again; outside the root there is none', () => {
    expect(abs('/p', 'src/a.js')).to.equal('/p/src/a.js');
    expect(abs('/p', '')).to.equal('/p');
    expect(abs(null, '')).to.equal('');
    expect(rel('/p', '/p/src/a.js')).to.equal('src/a.js');
    expect(rel('/p', '/q/a.js')).to.equal(null);
    expect(rel(null, '/p/a.js')).to.equal(null);
  });

  it('finds the worktree session folder a path lies in, and its place in the project', () => {
    const worktrees = [{ sessionId: 's', projectId: '/p', folder: '/wt/s', branch: 'b', title: 't' }];
    expect(worktreeOf(worktrees, '/wt/s/src/a.js')?.sessionId).to.equal('s');
    expect(worktreeOf(worktrees, '/p/src/a.js')).to.equal(null);
    expect(projectPathOf(worktrees, '/wt/s/src/a.js')).to.equal('/p/src/a.js');
    expect(projectPathOf(worktrees, '/p/src/a.js')).to.equal('/p/src/a.js');
  });

  it('takes the last segment', () => {
    expect(basename('/p/src/main.js')).to.equal('main.js');
    expect(basename('C:\\p\\a.txt')).to.equal('a.txt');
  });

  it('tells an absolute path, POSIX or Windows, from a relative one', () => {
    expect(isAbsolute('/Users/me/a.md')).to.equal(true);
    expect(isAbsolute('C:\\Users\\me\\a.md')).to.equal(true);
    expect(isAbsolute('\\\\server\\share\\a.md')).to.equal(true);
    expect(isAbsolute('src/a.js')).to.equal(false);
    expect(isAbsolute('.brama')).to.equal(false);
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
