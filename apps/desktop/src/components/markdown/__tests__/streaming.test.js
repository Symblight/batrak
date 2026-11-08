import { expect } from '@esm-bundle/chai';
import { fixture, html } from '../../../../test/fixture.js';
import '../markdown.js';

/** @typedef {import('../markdown.js').AcpMarkdown} AcpMarkdown */

// Feature map (a reply while it streams):
// 1. a chunk that arrives appears gradually, at a steady pace, and catches up within a few frames
// 2. the text that just appeared fades in

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

/** @param {AcpMarkdown} el */
const shown = (el) => el.shadowRoot?.querySelector('.acp-markdown__body')?.textContent?.trim() ?? '';

/** A streaming reply that has painted its first words. */
async function streamingReply() {
  const el = /** @type {AcpMarkdown} */ (await fixture(html`<acp-markdown streaming .text=${'Hello'}></acp-markdown>`));
  await frame();
  return el;
}

const CHUNK = ' there, this is a whole sentence the agent sent in one chunk, long enough to take a few frames';

describe('acp-markdown streaming', () => {
  it('shows a chunk gradually, caught up within a few frames', async () => {
    // Arrange
    const el = await streamingReply();

    // Act: one chunk arrives
    el.text = `Hello${CHUNK}`;
    await el.updateComplete;
    /** @type {number[]} */
    const lengths = [];
    for (let i = 0; i < 12; i++) {
      await frame();
      lengths.push(shown(el).length);
    }

    // Assert: more each frame, never all of it at once, all of it in the end
    expect(lengths[0], 'the first frame shows part of it').to.be.above(5).and.below(el.text.length);
    expect(lengths, 'steady').to.deep.equal([...lengths].sort((a, b) => a - b));
    expect(new Set(lengths).size, 'over several frames').to.be.at.least(4);
    expect(shown(el)).to.equal(el.text);
  });

  it('fades in the text that just appeared', async () => {
    // Arrange
    const el = await streamingReply();

    // Act
    el.text = `Hello${CHUNK}`;
    await el.updateComplete;
    await frame();

    // Assert: the newest text is animating in, the first words are not
    const fading = (el.shadowRoot?.getAnimations() ?? []).map((a) => {
      const target = /** @type {KeyframeEffect} */ (a.effect).target;
      return target?.textContent?.trim() ?? '';
    });
    expect(fading.join(''), 'new text').to.not.equal('');
    expect(`Hello${CHUNK}`.includes(fading.join('').trim()), 'only text that streamed in').to.equal(true);
    expect(fading.join('')).to.not.contain('Hello');
  });
});
