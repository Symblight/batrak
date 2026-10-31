import { expect } from '@esm-bundle/chai';
import { hiddenTabs } from '../tab-overflow.js';

describe('hiddenTabs', () => {
  const view = { start: 100, end: 400 };
  const fade = 16;

  it('hides none of an empty strip', () => {
    expect(hiddenTabs([], view, fade)).to.deep.equal([]);
  });

  it('hides none while every tab fits the strip', () => {
    const spans = [
      { id: 'a', start: 102, end: 200 },
      { id: 'b', start: 200, end: 398 },
    ];
    expect(hiddenTabs(spans, view, fade)).to.deep.equal([]);
  });

  it("doesn't hide tabs fully visible between the fades", () => {
    const spans = [
      { id: 'a', start: 50, end: 90 },
      { id: 'b', start: 120, end: 250 },
      { id: 'c', start: 250, end: 384 },
      { id: 'd', start: 420, end: 500 },
    ];
    expect(hiddenTabs(spans, view, fade)).to.deep.equal(['a', 'd']);
  });

  it('hides tabs cut by either edge, or under its fade', () => {
    const spans = [
      { id: 'cut-left', start: 80, end: 150 },
      { id: 'fade-left', start: 110, end: 160 },
      { id: 'shown', start: 160, end: 300 },
      { id: 'fade-right', start: 300, end: 390 },
      { id: 'cut-right', start: 390, end: 450 },
    ];
    expect(hiddenTabs(spans, view, fade)).to.deep.equal(['cut-left', 'fade-left', 'fade-right', 'cut-right']);
  });

  it('hides tabs wholly left or right of the strip, in strip order', () => {
    const spans = [
      { id: 'l1', start: 0, end: 40 },
      { id: 'l2', start: 40, end: 90 },
      { id: 'shown', start: 130, end: 300 },
      { id: 'r1', start: 410, end: 480 },
    ];
    expect(hiddenTabs(spans, view, fade)).to.deep.equal(['l1', 'l2', 'r1']);
  });
});
