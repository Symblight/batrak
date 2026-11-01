import { expect } from '@esm-bundle/chai';
import { composer } from '../composer.js';

/** @type {import('../types.js').ConfigOption} */
const model = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'b',
  options: [{ value: 'a', name: 'Alpha' }, { value: 'b', name: 'Beta' }],
};

describe('composer options', () => {
  it('finds the first option of a category and names its current value', () => {
    const other = { ...model, id: 'other', category: 'mode', currentValue: 'zzz' };
    expect(composer.configOf([other, model], 'model')).to.equal(model);
    expect(composer.configOf([other], 'model'), 'none of the category').to.equal(null);
    expect(composer.currentName(model)).to.equal('Beta');
    expect(composer.currentName(other), 'a value the agent no longer lists').to.equal(null);
    expect(composer.currentName(null)).to.equal(null);
  });
});
