import { expect } from '@esm-bundle/chai';
import { fixture, html } from '../../../../test/fixture.js';
import '../markdown.js';

/** @typedef {import('../markdown.js').AcpMarkdown} AcpMarkdown */

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

/** @param {AcpMarkdown} el */
const body = (el) => /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-markdown__body'));

/**
 * Sets the text and waits for the frame that paints it.
 * @param {AcpMarkdown} el
 * @param {string} text
 */
async function show(el, text) {
  el.text = text;
  await el.updateComplete;
  await frame();
}

describe('acp-markdown', () => {
  describe('a reply', () => {
    it('shows markdown as styled elements, the first paint at once', async () => {
      const el = await fixture(html`<acp-markdown .text=${'# Title\n\nSome **bold** text\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |'}></acp-markdown>`);

      // Assert (right after the first update: no frame was waited for)
      const root = body(el);
      expect(root.querySelector('h1')?.className).to.contain('acp-markdown__heading');
      expect(root.querySelector('strong')?.textContent).to.equal('bold');
      expect(root.querySelectorAll('li')).to.have.length(2);
      expect(root.querySelector('table')?.className).to.equal('acp-markdown__table');
    });

    it('shows a fence in a code block that knows its language and offers to copy', async () => {
      const el = await fixture(html`<acp-markdown .text=${'```ts\nconst a = 1;\n```'}></acp-markdown>`);

      const block = /** @type {any} */ (body(el).querySelector('chx-code-block'));
      await block.updateComplete;
      expect([block.lang, block.code, block.copyable]).to.deep.equal(['typescript', 'const a = 1;', true]);
      expect(body(el).querySelector('pre')).to.equal(null);
    });

    it('fetches and runs nothing: an image is a link, scripts and styles are gone', async () => {
      const el = await fixture(
        html`<acp-markdown
          .text=${'![logo](https://a.test/x.png)\n\n<script>window.__ran = 1</script><style>p{display:none}</style><img src="https://a.test/y.png" onerror="window.__ran = 1">\n\n<iframe src="https://a.test"></iframe>'}
        ></acp-markdown>`,
      );

      const root = body(el);
      expect(root.querySelector('img, script, style, iframe, picture, video')).to.equal(null);
      expect(root.querySelector('a')?.getAttribute('href')).to.equal('https://a.test/x.png');
      expect(/** @type {any} */ (window).__ran).to.equal(undefined);
    });

    it('lets the host rewrite the rendered nodes, and styles what it adds', async () => {
      const el = await fixture(html`<acp-markdown .decorate=${(/** @type {ParentNode} */ root) => {
        for (const code of root.querySelectorAll('code')) {
          const link = document.createElement('a');
          link.textContent = `chip ${code.textContent}`;
          code.replaceWith(link);
        }
      }} .text=${'see `src/app.js` now'}></acp-markdown>`);

      const link = body(el).querySelector('a');
      expect(link?.textContent).to.equal('chip src/app.js');
      expect(link?.className).to.equal('acp-markdown__link');
      expect(body(el).querySelector('code')).to.equal(null);
    });

    it('paints at most once a frame while text streams in, and skips text it already shows', async () => {
      let paints = 0;
      const el = await fixture(html`<acp-markdown .decorate=${() => paints++} .text=${'a'}></acp-markdown>`);
      expect(paints).to.equal(1);

      // Act: three deltas inside one frame
      for (const text of ['ab', 'abc', 'abcd']) {
        el.text = text;
        await el.updateComplete;
      }
      await frame();
      await frame();

      expect(paints).to.equal(2);
      expect(body(el).textContent?.trim()).to.equal('abcd');

      el.text = 'abcd';
      await el.updateComplete;
      await frame();
      expect(paints).to.equal(2);
    });
  });

  describe('links', () => {
    /**
     * @param {AcpMarkdown} el
     * @param {string} href
     */
    function click(el, href) {
      /** @type {string[]} */
      const opened = [];
      el.addEventListener('acp-link-open', (e) => opened.push(/** @type {CustomEvent<{ url: string }>} */ (e).detail.url));
      const link = /** @type {HTMLAnchorElement} */ (body(el).querySelector(`a[href="${href}"]`));
      const event = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true });
      link.dispatchEvent(event);
      return { opened, prevented: event.defaultPrevented };
    }

    it('opens a web or mail link in the browser, and never navigates the window', async () => {
      const el = await fixture(html`<acp-markdown .text=${'[web](https://a.test/x?q=1) [mail](mailto:me@a.test)'}></acp-markdown>`);

      expect(click(el, 'https://a.test/x?q=1')).to.deep.equal({ opened: ['https://a.test/x?q=1'], prevented: true });
      expect(click(el, 'mailto:me@a.test')).to.deep.equal({ opened: ['mailto:me@a.test'], prevented: true });
    });

    it('leaves any other link to the host, and still keeps the window where it is', async () => {
      const el = await fixture(html`<acp-markdown .text=${'[file](src/app.js) [anchor](#x)'}></acp-markdown>`);

      expect(click(el, 'src/app.js')).to.deep.equal({ opened: [], prevented: true });
      expect(click(el, '#x')).to.deep.equal({ opened: [], prevented: true });
    });

    it('opens a link that stayed after a repaint', async () => {
      const el = await fixture(html`<acp-markdown .text=${'[web](https://a.test/1)\n\nfirst'}></acp-markdown>`);
      await show(el, '[web](https://a.test/1)\n\nsecond');

      expect(click(el, 'https://a.test/1').opened).to.deep.equal(['https://a.test/1']);
    });
  });

  describe('repainting', () => {
    it('keeps the nodes of the leading blocks that did not change', async () => {
      const el = await fixture(html`<acp-markdown .text=${'# One\n\ntwo\n\n- three\n\nfour'}></acp-markdown>`);
      const before = [...body(el).children];

      await show(el, '# One\n\ntwo\n\n- three\n\nfour changed\n\nfive');

      const after = [...body(el).children];
      expect(after).to.have.length(5);
      expect(after.slice(0, 3)).to.deep.equal(before.slice(0, 3));
      expect(after[3]).to.not.equal(before[3]);
      expect(after[3].textContent).to.equal('four changed');
    });

    it('replaces everything when the first block changed', async () => {
      const el = await fixture(html`<acp-markdown .text=${'# One\n\ntwo'}></acp-markdown>`);
      const before = [...body(el).children];

      await show(el, '# Uno\n\ntwo');

      expect([...body(el).children].some((n) => before.includes(n))).to.equal(false);
    });

    it('drops the blocks that went, and shows an emptied text as nothing', async () => {
      const el = await fixture(html`<acp-markdown .text=${'one\n\ntwo\n\nthree'}></acp-markdown>`);
      const first = body(el).firstElementChild;

      await show(el, 'one');
      expect([...body(el).children]).to.have.length(1);
      expect(body(el).firstElementChild).to.equal(first);

      await show(el, '');
      expect(body(el).children).to.have.length(0);
    });

    it('streams: a block that grows is redone, the finished ones before it are not', async () => {
      const el = await fixture(html`<acp-markdown .text=${'intro\n\nsecond par'}></acp-markdown>`);
      const intro = body(el).firstElementChild;

      await show(el, 'intro\n\nsecond paragraph\n\n```js\nlet a');

      expect(body(el).firstElementChild).to.equal(intro);
      expect(body(el).children).to.have.length(3);
      expect(body(el).children[1].textContent).to.equal('second paragraph');
    });
  });
});
