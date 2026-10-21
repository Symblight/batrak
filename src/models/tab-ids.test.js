import { expect } from '@esm-bundle/chai';
import { sessionChangesTabId, terminalOfTab, terminalTabId } from './tab-ids.js';

describe('tab ids', () => {
  it('names a terminal’s tab and finds the terminal again', () => {
    const id = terminalTabId('3f2a');
    expect(id).to.equal('view:terminal:3f2a');
    expect(terminalOfTab(id)).to.equal('3f2a');
  });

  it('finds no terminal in other tabs', () => {
    for (const id of ['view:terminal', 'view:settings', sessionChangesTabId('s1'), '/p/view:terminal:x']) {
      expect(terminalOfTab(id), id).to.equal(null);
    }
  });
});
