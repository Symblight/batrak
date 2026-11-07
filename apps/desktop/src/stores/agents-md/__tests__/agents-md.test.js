import { expect } from '@esm-bundle/chai';
import { $project } from '../../project/project.js';
import { $agentsMdDismissed, dismissAgentsMd } from '../agents-md.js';

const PREFIX = 'batrak:agents-md:dismissed:';

/** A path no other test has dismissed: the store keeps what it heard. */
const newPath = () => `/p-${crypto.randomUUID()}`;

/** @param {string} path */
function show(path) {
  $project.set({ path, name: 'p', rootId: 'r' });
}

describe('$agentsMdDismissed', () => {
  /** @type {() => void} */
  let stop;

  beforeEach(() => {
    stop = $agentsMdDismissed.listen(() => {});
  });

  afterEach(() => {
    stop();
    $project.set(null);
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  });

  it('tells for the shown project only', () => {
    // Arrange
    const [dismissed, other] = [newPath(), newPath()];

    // Act
    dismissAgentsMd(dismissed);

    // Assert
    show(dismissed);
    expect($agentsMdDismissed.get(), 'the dismissed project').to.equal(true);
    show(other);
    expect($agentsMdDismissed.get(), 'another project').to.equal(false);
    $project.set(null);
    expect($agentsMdDismissed.get(), 'no project').to.equal(false);
  });

  it('is still dismissed after a reload', async () => {
    // Arrange
    const path = newPath();
    dismissAgentsMd(path);
    show(path);

    // Act: the app starts again, with only what storage holds
    const copy = 1;
    const fresh = /** @type {typeof import('../agents-md.js')} */ (await import(`../agents-md.js?reloaded=${copy}`));
    const stopFresh = fresh.$agentsMdDismissed.listen(() => {});

    // Assert
    expect(fresh.$agentsMdDismissed.get()).to.equal(true);
    stopFresh();
  });

  it("follows another window's dismissal, ignoring a value that isn't one", () => {
    const cases = [
      ['true', true],
      ['"yes"', false],
      ['not json', false],
    ];
    for (const [stored, dismissed] of cases) {
      // Arrange
      const path = newPath();
      show(path);

      // Act
      window.dispatchEvent(new StorageEvent('storage', { key: `${PREFIX}${path}`, newValue: /** @type {string} */ (stored) }));

      // Assert
      expect($agentsMdDismissed.get(), String(stored)).to.equal(dismissed);
    }
  });
});
