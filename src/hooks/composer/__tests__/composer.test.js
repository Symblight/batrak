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

describe('composer run target', () => {
  it("is a draft's picked place, else its workspace's own: This workspace in a worktree workspace, Local in Main", () => {
    /** @type {[import('../types.js').RunTarget | undefined, string, boolean, import('../types.js').RunTarget, string][]} */
    const cases = [
      // [picked, the draft's workspace, the project can have workspaces, place, why]
      [undefined, 'w1', true, { kind: 'workspace' }, 'a worktree workspace'],
      [undefined, 'main', true, { kind: 'local' }, 'Main'],
      [{ kind: 'local' }, 'w1', true, { kind: 'local' }, 'picked'],
      [{ kind: 'worktree', base: 'dev' }, 'main', true, { kind: 'worktree', base: 'dev' }, 'picked'],
      [{ kind: 'workspace' }, 'main', true, { kind: 'local' }, 'Main is no worktree workspace'],
      [{ kind: 'worktree', base: 'dev' }, 'main', false, { kind: 'local' }, 'no New worktree where there can be no workspace'],
    ];
    for (const [picked, workspaceId, worktrees, expected, why] of cases) {
      expect(composer.runTargetOf(picked, workspaceId, worktrees), why).to.deep.equal(expected);
    }
  });
});
