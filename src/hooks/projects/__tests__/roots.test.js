import { expect } from '@esm-bundle/chai';
import { $openRoots } from '../../../stores/project/project.js';
import { createRoots } from '../roots.js';

describe('open roots', () => {
  afterEach(() => $openRoots.set({}));

  it('keeps the last three roots, projects and workspaces together, closing the oldest but the shown project', () => {
    // Arrange
    /** @type {string[]} */
    const closed = [];
    const roots = createRoots(3, async (rootId) => void closed.push(rootId));
    roots.show('/p', 'r-p');
    roots.show('/wt/a', 'r-a', ['/p']);
    roots.show('/wt/b', 'r-b', ['/p']);

    // Act: a third workspace of the shown project
    roots.show('/wt/c', 'r-c', ['/p']);

    // Assert
    expect(closed, 'the oldest workspace, not its project').to.deep.equal(['r-a']);
    expect($openRoots.get()).to.deep.equal({ '/p': 'r-p', '/wt/b': 'r-b', '/wt/c': 'r-c' });
    expect([roots.get('/wt/c'), roots.get('/wt/a')]).to.deep.equal(['r-c', null]);

    // Act: another project, nothing pinned
    roots.show('/q', 'r-q');

    // Assert
    expect(closed, 'now the project is the oldest').to.deep.equal(['r-a', 'r-p']);
    expect(roots.isOpen('r-q') && !roots.isOpen('r-p')).to.equal(true);
  });
});
