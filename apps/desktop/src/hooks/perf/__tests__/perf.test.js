import { expect } from '@esm-bundle/chai';
import { perf } from '../perf.js';

/** A frame loop the test steps by hand: `frame(t)` runs the pending callback at time `t`. */
function fakeFrames() {
  /** @type {((time: number) => void) | null} */
  let pending = null;
  return {
    request: (/** @type {(time: number) => void} */ callback) => {
      pending = callback;
      return 1;
    },
    cancel: () => {
      pending = null;
    },
    frame(/** @type {number} */ time) {
      const callback = pending;
      pending = null;
      callback?.(time);
    },
    get waiting() {
      return pending !== null;
    },
  };
}

describe('perf.watchStalls', () => {
  /** @type {ReturnType<typeof fakeFrames>} */
  let frames;
  /** @type {{ gap: number, at: number }[]} */
  let stalls;
  /** @type {boolean} */
  let visible;
  /** @type {() => void} */
  let stop;

  beforeEach(() => {
    frames = fakeFrames();
    stalls = [];
    visible = true;
    stop = perf.watchStalls({
      threshold: 50,
      onStall: (stall) => stalls.push(stall),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      isVisible: () => visible,
    });
  });
  afterEach(() => stop());

  it('reports a gap between frames over the threshold, with when it ended', () => {
    frames.frame(0);
    frames.frame(16);
    frames.frame(216);
    expect(stalls).to.deep.equal([{ gap: 200, at: 216 }]);
  });

  it('stays quiet for frames at or under the threshold', () => {
    frames.frame(0);
    frames.frame(16);
    frames.frame(66);
    expect(stalls).to.deep.equal([]);
  });

  it('does not count the time a hidden window sat without frames', () => {
    frames.frame(0);
    visible = false;
    frames.frame(5000);
    visible = true;
    frames.frame(5016);
    expect(stalls).to.deep.equal([]);
  });

  it('stops asking for frames once stopped', () => {
    frames.frame(0);
    expect(frames.waiting).to.equal(true);
    stop();
    expect(frames.waiting).to.equal(false);
  });
});
