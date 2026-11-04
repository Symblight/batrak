import { expect } from '@esm-bundle/chai';
import { projects } from '../projects.js';

const { abs, basename, initialOf, isAbsolute, parentLabel, projectPathOf, rel, shownPath, tildePath, unreadByProject, worktreeOf } = projects;

describe('projects: path rules', () => {
  it('joins a root and a relative path, and splits them again; outside the root there is none', () => {
    expect(abs('/p', 'src/a.js')).to.equal('/p/src/a.js');
    expect(abs('/p', '')).to.equal('/p');
    expect(abs(null, '')).to.equal('');
    expect(rel('/p', '/p/src/a.js')).to.equal('src/a.js');
    expect(rel('/p', '/q/a.js')).to.equal(null);
    expect(rel(null, '/p/a.js')).to.equal(null);
  });

  it('finds the workspace folder a path lies in, and its place in the project', () => {
    const worktrees = [{ projectId: '/p', folder: '/wt/s', branch: 'b' }];
    expect(worktreeOf(worktrees, '/wt/s/src/a.js')?.folder).to.equal('/wt/s');
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

  it("takes a project's tile letter from the first letter or digit of its name", () => {
    const cases = [
      ['ACP-code-editor', 'A'],
      ['signaledge', 'S'],
      ['2048-game', '2'],
      ['_.hidden-app', 'H'],
      ['élan', 'É'],
      ['__', '?'],
      ['', '?'],
    ];
    for (const [name, expected] of cases) expect(initialOf(name), name).to.equal(expected);
  });

  it('shows the home folder as ~ and the parent folder of a project', () => {
    expect(tildePath('/Users/me/Code/app', '/Users/me')).to.equal('~/Code/app');
    expect(tildePath('/Users/me', '/Users/me')).to.equal('~');
    expect(tildePath('C:\\Users\\me\\app', 'C:\\Users\\me')).to.equal('~\\app');
    expect(tildePath('/Users/meow/app', '/Users/me')).to.equal('/Users/meow/app');
    expect(tildePath('/work/app', null)).to.equal('/work/app');
    expect(parentLabel('/Users/me/Code/app', '/Users/me')).to.equal('~/Code');
    expect(parentLabel('/work/app', '/Users/me')).to.equal('/work');
    expect(parentLabel('/app', null)).to.equal('/');
  });

  it('counts the unread sessions of each project', () => {
    const sessions = [
      { id: 'a', projectId: '/p' },
      { id: 'b', projectId: '/p' },
      { id: 'c', projectId: '/q' },
      { id: 'd', projectId: '/q' },
    ];
    expect(unreadByProject(sessions, ['a', 'b', 'c'])).to.deep.equal({ '/p': 2, '/q': 1 });
    expect(unreadByProject(sessions, [])).to.deep.equal({});
  });
});
