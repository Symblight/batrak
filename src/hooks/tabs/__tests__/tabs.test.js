import { expect } from '@esm-bundle/chai';
import { tabs } from '../tabs.js';

describe('tabs', () => {
  it('names a terminal’s and a worktree session’s Changes tab, and reads each back from it', () => {
    expect(tabs.terminalId('t1')).to.equal('view:terminal:t1');
    expect(tabs.terminalOf('view:terminal:t1')).to.equal('t1');
    expect(tabs.terminalOf('/p/a.js')).to.equal(null);
    expect(tabs.sessionChangesId('s1')).to.equal('view:session-changes:s1');
    expect(tabs.sessionOf('view:session-changes:s1')).to.equal('s1');
    expect(tabs.sessionOf('view:changes')).to.equal(null);
    expect(tabs.sessionOf('view:terminal:t1')).to.equal(null);
    expect(tabs.terminalOf('view:session-changes:s1')).to.equal(null);
  });

  it('hides the tabs a strip cuts off or fades, in strip order, and none that fit', () => {
    const view = { start: 100, end: 400 };
    const fade = 16;
    const cases = [
      // [spans, hidden, why]
      [[], [], 'an empty strip'],
      [[{ id: 'a', start: 102, end: 200 }, { id: 'b', start: 200, end: 398 }], [], 'every tab fits'],
      [
        [{ id: 'a', start: 50, end: 90 }, { id: 'b', start: 120, end: 250 }, { id: 'c', start: 250, end: 384 }, { id: 'd', start: 420, end: 500 }],
        ['a', 'd'],
        'wholly outside; fully visible between the fades stay',
      ],
      [
        [
          { id: 'cut-left', start: 80, end: 150 },
          { id: 'fade-left', start: 110, end: 160 },
          { id: 'shown', start: 160, end: 300 },
          { id: 'fade-right', start: 300, end: 390 },
          { id: 'cut-right', start: 390, end: 450 },
        ],
        ['cut-left', 'fade-left', 'fade-right', 'cut-right'],
        'cut by either edge, or under a fade',
      ],
      [
        [{ id: 'l1', start: 0, end: 40 }, { id: 'l2', start: 40, end: 90 }, { id: 'shown', start: 130, end: 300 }, { id: 'r1', start: 410, end: 480 }],
        ['l1', 'l2', 'r1'],
        'left and right of the strip, in order',
      ],
    ];
    for (const [spans, hidden, why] of /** @type {any[][]} */ (cases)) {
      // Act + Assert
      expect(tabs.hidden(spans, view, fade), why).to.deep.equal(hidden);
    }
  });
});
