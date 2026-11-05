import { expect } from '@esm-bundle/chai';
import { $project } from '../../project/project.js';
import { setWorkspaces } from '../../workspaces/workspaces.js';
import { $workspaceNumbers } from '../workspace-status.js';

/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */

/** @param {string} id */
const ws = (id) => /** @type {Workspace} */ ({ id, name: id, createdAt: '2026-01-01T00:00:00.000Z' });

describe('workspace-status', () => {
  afterEach(() => {
    setWorkspaces([]);
    $project.set(null);
  });

  it('numbers Main 1 and the shown project’s workspaces 2…9 by creation; only Main while its list loads', () => {
    // Arrange
    $project.set({ path: '/p', name: 'p', rootId: null });
    setWorkspaces(Array.from({ length: 9 }, (_, i) => ws(`w${i + 1}`)), '/p');
    const listed = $workspaceNumbers.get();

    // Act: another project is shown, its list not loaded yet
    $project.set({ path: '/q', name: 'q', rootId: null });

    // Assert
    expect(listed).to.deep.equal({ main: 1, w1: 2, w2: 3, w3: 4, w4: 5, w5: 6, w6: 7, w7: 8, w8: 9 });
    expect($workspaceNumbers.get(), 'another project’s list').to.deep.equal({ main: 1 });
  });
});
