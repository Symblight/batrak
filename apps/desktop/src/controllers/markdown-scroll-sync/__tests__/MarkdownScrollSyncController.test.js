import { LitElement, html } from 'lit';
import { expect } from '@esm-bundle/chai';
import { fixture } from '../../../../test/fixture.js';
import { MarkdownScrollSyncController } from '../MarkdownScrollSyncController.js';

/** Frames to wait for scroll events to settle. */
const frames = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
};

const LINE_HEIGHT = 20;
const BLOCK_LINES = 5;
const BLOCK_HEIGHT = 150;
const BLOCKS = 20;

/**
 * Twenty blocks of five lines. The editor shows a line in 20px, the preview a block in 150px, so the two
 * only agree where the controller makes them.
 */
class SyncHost extends LitElement {
  static properties = { swap: { type: Number } };

  /** @type {Array<{ line: number, node: Node }>} */
  blocks = [];
  enabled = true;
  withBlocks = true;
  /** @type {Array<Node | null>} */
  current = [];

  constructor() {
    super();
    /** Odd: the preview is another element. */
    this.swap = 0;
  }

  sync = new MarkdownScrollSyncController(this, {
    editor: () => {
      const dom = /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.editor'));
      if (!dom) return undefined;
      return {
        dom,
        topLine: () => Math.floor(dom.scrollTop / LINE_HEIGHT) + 1,
        scrollToLine: (/** @type {number} */ line) => {
          dom.scrollTop = (line - 1) * LINE_HEIGHT;
        },
      };
    },
    preview: () => /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.preview')),
    blocks: () => (this.withBlocks ? this.blocks : []),
    enabled: () => this.enabled,
    onCurrent: (node) => this.current.push(node),
  });

  get editor() {
    return /** @type {HTMLElement} */ (this.renderRoot.querySelector('.editor'));
  }

  get preview() {
    return /** @type {HTMLElement} */ (this.renderRoot.querySelector('.preview'));
  }

  render() {
    const lines = BLOCKS * BLOCK_LINES;
    return html`
      <div class="editor" style="height: 100px; overflow: auto">
        <div style="height: ${lines * LINE_HEIGHT}px"></div>
      </div>
      ${this.swap % 2 === 0
        ? html`<div class="preview" style="height: 100px; overflow: auto">
            ${Array.from({ length: BLOCKS }, () => html`<p style="margin: 0; height: ${BLOCK_HEIGHT}px"></p>`)}
          </div>`
        : html`<section class="preview" style="height: 100px; overflow: auto">
            ${Array.from({ length: BLOCKS }, () => html`<p style="margin: 0; height: ${BLOCK_HEIGHT}px"></p>`)}
          </section>`}
    `;
  }

  updated() {
    this.blocks = [...this.preview.children].map((node, i) => ({ line: i * BLOCK_LINES + 1, node }));
  }
}
customElements.define('test-scroll-sync-host', SyncHost);

/** @returns {Promise<SyncHost>} */
async function host() {
  const el = await fixture(html`<test-scroll-sync-host></test-scroll-sync-host>`);
  await el.updateComplete;
  return el;
}

/**
 * The user scrolls a pane.
 * @param {HTMLElement} pane
 * @param {number} top
 */
async function scroll(pane, top) {
  pane.scrollTop = top;
  await frames();
}

describe('MarkdownScrollSyncController', () => {
  it('puts the block of the editor’s top line at the top of the preview', async () => {
    const el = await host();

    // Line 11 is the first of the third block.
    await scroll(el.editor, 10 * LINE_HEIGHT);

    expect(el.preview.scrollTop).to.equal(2 * BLOCK_HEIGHT);
  });

  it('takes the last block that starts at or above the top line', async () => {
    const el = await host();

    // Line 14 is inside the third block.
    await scroll(el.editor, 13 * LINE_HEIGHT);

    expect(el.preview.scrollTop).to.equal(2 * BLOCK_HEIGHT);
  });

  it('puts the editor’s line of the preview’s first visible block at its top', async () => {
    const el = await host();

    // 460px: the fourth block (450–600) is the first one still on screen.
    await scroll(el.preview, 460);

    expect(el.editor.scrollTop).to.equal(3 * BLOCK_LINES * LINE_HEIGHT);
  });

  it('does not echo: the pane that was moved does not move the first back, and a later scroll still syncs', async () => {
    const el = await host();

    await scroll(el.editor, 13 * LINE_HEIGHT);
    await frames(10);
    expect(el.editor.scrollTop, 'the editor stays where the user left it').to.equal(13 * LINE_HEIGHT);

    await scroll(el.preview, 5 * BLOCK_HEIGHT);
    expect(el.editor.scrollTop).to.equal(5 * BLOCK_LINES * LINE_HEIGHT);
    expect(el.preview.scrollTop).to.equal(5 * BLOCK_HEIGHT);
  });

  it('tells the host which block is current', async () => {
    const el = await host();

    await scroll(el.editor, 10 * LINE_HEIGHT);
    await scroll(el.editor, 15 * LINE_HEIGHT);

    expect(el.current).to.deep.equal([el.blocks[2].node, el.blocks[3].node]);
  });

  it('does nothing while it is off, and follows the switch', async () => {
    const el = await host();
    el.enabled = false;

    await scroll(el.editor, 10 * LINE_HEIGHT);
    expect(el.preview.scrollTop).to.equal(0);
    await scroll(el.preview, 300);
    expect(el.editor.scrollTop).to.equal(10 * LINE_HEIGHT);

    el.enabled = true;
    await scroll(el.editor, 20 * LINE_HEIGHT);
    expect(el.preview.scrollTop).to.equal(4 * BLOCK_HEIGHT);
  });

  it('scrolls in proportion when the blocks cannot be told', async () => {
    const el = await host();
    el.withBlocks = false;
    const editorRange = el.editor.scrollHeight - el.editor.clientHeight;
    const previewRange = el.preview.scrollHeight - el.preview.clientHeight;

    await scroll(el.editor, editorRange / 2);
    expect(el.preview.scrollTop).to.be.closeTo(previewRange / 2, 1);

    await scroll(el.preview, previewRange / 4);
    expect(el.editor.scrollTop).to.be.closeTo(editorRange / 4, 1);
  });

  it('follows a preview that was swapped for another element', async () => {
    const el = await host();
    el.swap = 1;
    await el.updateComplete;

    await scroll(el.editor, 10 * LINE_HEIGHT);

    expect(el.preview.localName).to.equal('section');
    expect(el.preview.scrollTop).to.equal(2 * BLOCK_HEIGHT);
  });

  it('stops listening when its host goes away', async () => {
    const el = await host();
    const { editor, preview } = el;
    el.remove();

    await scroll(editor, 10 * LINE_HEIGHT);

    expect(preview.scrollTop).to.equal(0);
  });
});
