import { expect } from '../../../../test/fixture.js';
import { $diffLayout, parseDiffLayout, setDiffLayout } from '../git.js';

describe('diff layout store', () => {
  afterEach(() => setDiffLayout('unified'));

  it('keeps the choice across restarts', () => {
    // Act
    setDiffLayout('split');
    // Assert
    expect($diffLayout.get()).to.equal('split');
    expect(localStorage.getItem('batrak:git:diff-layout')).to.equal('"split"');
  });

  it('reads only a layout it knows', () => {
    expect(['unified', 'split', 'side', 1, null].map(parseDiffLayout)).to.deep.equal(['unified', 'split', null, null, null]);
  });
});
