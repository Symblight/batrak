import { expect } from '@esm-bundle/chai';
import { $pendingInput, addDrop, addToChat, forgetPendingInput, hasPendingInput, takePendingInput } from '../chat.js';
import { $hiddenColumns } from '../../layout/layout.js';
import { $project } from '../../project/project.js';
import { $activeSessionId } from '../../sessions/sessions.js';

describe('pending input', () => {
  afterEach(() => {
    $pendingInput.set({});
    $activeSessionId.set(null);
    $hiddenColumns.set([]);
    $project.set(null);
  });

  const code = (/** @type {string} */ path) => ({ path, fromLine: 1, toLine: 1, body: '' });

  it('keeps code and drops for the session shown when they came, until taken once', () => {
    $activeSessionId.set('s1');
    addToChat([code('/p/a.js')]);
    addDrop(['/p/b.png']);
    $activeSessionId.set('s2');
    addDrop(['/p/c.md']);
    expect(hasPendingInput('s1')).to.equal(true);
    expect(takePendingInput('s1')).to.deep.equal({ inserts: [code('/p/a.js')], drops: ['/p/b.png'] });
    expect(takePendingInput('s1'), 'taken').to.deep.equal({ inserts: [], drops: [] });
    expect(hasPendingInput('s1')).to.equal(false);
    expect(takePendingInput('s2')).to.deep.equal({ inserts: [], drops: ['/p/c.md'] });
  });

  it('keeps nothing while no session shows: nothing could take it', () => {
    addToChat([code('/p/a.js')]);
    expect($pendingInput.get()).to.deep.equal({});
  });

  it('shows a hidden agent column when code is added, and leaves it hidden when nothing is', () => {
    // Arrange
    $activeSessionId.set('s1');
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $hiddenColumns.set(['agent', 'side']);

    // Act
    addToChat([]);
    const afterNothing = $hiddenColumns.get();
    addToChat([code('/p/a.js')]);

    // Assert
    expect(afterNothing).to.deep.equal(['agent', 'side']);
    expect($hiddenColumns.get()).to.deep.equal(['side']);
  });

  it("forgets a removed session's", () => {
    $activeSessionId.set('s1');
    addDrop(['/p/b.png']);
    forgetPendingInput('s1');
    expect(hasPendingInput('s1')).to.equal(false);
  });
});
