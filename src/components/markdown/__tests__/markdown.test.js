import { expect } from '@esm-bundle/chai';
import { fixture, html, tooltipOf } from '../../../../test/fixture.js';
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

  describe('a text it cannot render', () => {
    /** A host whose rewrite fails on a text that says `bad`. */
    const failOnBad = (/** @type {ParentNode} */ root) => {
      if (root.textContent?.includes('bad')) throw new Error('rewrite failed');
    };

    it('says so in place of the text, tells the host, and renders the next text', async () => {
      const el = await fixture(html`<acp-markdown .decorate=${failOnBad}></acp-markdown>`);
      /** @type {string[]} */
      const heard = [];
      el.addEventListener('acp-markdown-error', (/** @type {Event} */ e) => heard.push(/** @type {CustomEvent} */ (e).detail.error.message));

      await show(el, 'a bad text');
      expect(body(el).querySelector('.acp-markdown__error')?.textContent).to.equal('Couldn’t render this text');
      expect(body(el).textContent).to.not.contain('bad text');
      expect(heard).to.deep.equal(['rewrite failed']);

      await show(el, 'a good text');
      expect(body(el).querySelector('.acp-markdown__error')).to.equal(null);
      expect(body(el).textContent?.trim()).to.equal('a good text');
    });

    it('says so once for a text, not at every update', async () => {
      const el = await fixture(html`<acp-markdown .decorate=${failOnBad}></acp-markdown>`);
      /** @type {unknown[]} */
      const heard = [];
      el.addEventListener('acp-markdown-error', (/** @type {Event} */ e) => heard.push(e));

      await show(el, 'bad');
      el.requestUpdate();
      await el.updateComplete;
      await frame();

      expect(heard).to.have.length(1);
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

    it('keeps the nodes of blocks a blank line moved, but names the lines they are on now', async () => {
      const el = await fixture(html`<acp-markdown policy="document" .text=${'one\n\ntwo\n\nthree'}></acp-markdown>`);
      const nodes = [...body(el).children];
      expect(el.blocks.map((/** @type {{ line: number }} */ b) => b.line)).to.deep.equal([1, 3, 5]);

      await show(el, 'one\n\n\n\ntwo\n\nthree');

      expect([...body(el).children]).to.deep.equal(nodes);
      expect(el.blocks.map((/** @type {{ line: number }} */ b) => b.line)).to.deep.equal([1, 5, 7]);
      expect(el.blocks.map((/** @type {{ node: Node }} */ b) => b.node)).to.deep.equal(nodes);
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

  describe('a document', () => {
    const FILE = { baseDir: '/p/docs', root: '/p' };
    // A 1×1 PNG, so the image decodes.
    const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

    /** @type {{ created: Blob[], revoked: string[] }} */
    let urls;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    beforeEach(() => {
      urls = { created: [], revoked: [] };
      URL.createObjectURL = (blob) => {
        urls.created.push(/** @type {Blob} */ (blob));
        return realCreate.call(URL, blob);
      };
      URL.revokeObjectURL = (url) => {
        urls.revoked.push(url);
        realRevoke.call(URL, url);
      };
    });
    afterEach(() => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    });

    /** @param {string} [_path] */
    const png = async (_path) => new Blob([PNG], { type: 'image/png' });
    const settle = async () => {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    /**
     * @param {string} text
     * @param {Partial<{ loadImage: (path: string) => Promise<Blob> }>} [extra]
     */
    const preview = (text, extra = {}) =>
      fixture(html`<acp-markdown policy="document" base-dir=${FILE.baseDir} root=${FILE.root} .loadImage=${extra.loadImage ?? png} .text=${text}></acp-markdown>`);

    it('gives headings ids and shows task lists, quotes and tables', async () => {
      const el = await preview('# Title\n\n- [x] done\n- [ ] todo\n\n> q\n\n| a |\n| - |\n| 1 |');

      expect(body(el).querySelector('h1')?.id).to.equal('acp-md-title');
      expect([...body(el).querySelectorAll('input[type=checkbox]')].map((i) => /** @type {HTMLInputElement} */ (i).checked)).to.deep.equal([true, false]);
      expect(body(el).querySelector('table')).to.not.equal(null);
    });

    it('shows a local image from its bytes, read through the host', async () => {
      /** @type {string[]} */
      const asked = [];
      const el = await preview('![alt text](pics/a.png)', { loadImage: (path) => (asked.push(path), png(path)) });
      await settle();

      const img = /** @type {HTMLImageElement} */ (body(el).querySelector('img'));
      expect(asked).to.deep.equal(['/p/docs/pics/a.png']);
      expect(img.src).to.match(/^blob:/);
      expect(img.alt).to.equal('alt text');
      await img.decode();
      expect(img.naturalWidth).to.equal(1);
    });

    it('shows the alt text of an image it cannot read, with the error as its hint', async () => {
      const el = await preview('![the logo](missing.png)', { loadImage: async () => Promise.reject(new Error('No such file')) });
      await settle();
      await el.updateComplete;

      expect(body(el).querySelector('img')).to.equal(null);
      const broken = /** @type {HTMLElement} */ (body(el).querySelector('.acp-markdown__image_broken'));
      expect(broken.textContent?.trim()).to.equal('the logo');
      expect(tooltipOf(broken)).to.equal('No such file');
      expect(broken.hasAttribute('title')).to.equal(false);
    });

    it('asks for no web image and no image outside the project', async () => {
      /** @type {string[]} */
      const asked = [];
      const el = await preview('![a](https://a.test/x.png) ![b](../../x.png) ![c](data:image/png;base64,AAAA)', { loadImage: (path) => (asked.push(path), png(path)) });
      await settle();

      expect(asked).to.deep.equal([]);
      expect(body(el).querySelector('img')).to.equal(null);
      expect(body(el).textContent).to.contain('b').and.contain('c');
    });

    it('frees the image’s URL when a repaint drops it, and when it goes away', async () => {
      const el = await preview('![one](a.png)\n\n![two](b.png)');
      await settle();
      expect(urls.created).to.have.length(2);

      await show(el, '![one](a.png)');
      await settle();
      expect(urls.revoked).to.have.length(1);

      el.remove();
      expect(urls.revoked).to.have.length(2);
    });

    it('makes no URL for an image whose block went before its bytes came', async () => {
      /** @type {(blob: Blob) => void} */
      let arrive = () => {};
      const el = await preview('![one](a.png)', { loadImage: () => new Promise((resolve) => (arrive = resolve)) });

      await show(el, 'gone');
      arrive(await png('a.png'));
      await settle();

      expect(urls.created).to.have.length(0);
    });

    it('keeps the image of a block that stayed, without reading it again', async () => {
      let reads = 0;
      const el = await preview('![one](a.png)\n\ntext', { loadImage: (path) => (reads++, png(path)) });
      await settle();
      const img = body(el).querySelector('img');

      await show(el, '![one](a.png)\n\ntext more');
      await settle();

      expect(body(el).querySelector('img')).to.equal(img);
      expect(reads).to.equal(1);
      expect(urls.revoked).to.have.length(0);
    });

    it('reads its images again when it was away while they were read', async () => {
      /** @type {Array<(blob: Blob) => void>} */
      const arrivals = [];
      const el = await preview('![one](a.png)', { loadImage: () => new Promise((resolve) => arrivals.push(resolve)) });
      const host = /** @type {HTMLElement} */ (el.parentElement);

      el.remove();
      arrivals[0](await png('a.png'));
      await settle();
      host.append(el);
      await el.updateComplete;
      await settle();
      arrivals[1]?.(await png('a.png'));
      await settle();

      expect(arrivals).to.have.length(2);
      expect(/** @type {HTMLImageElement} */ (body(el).querySelector('img')).src).to.match(/^blob:/);
    });

    describe('clicks', () => {
      /**
       * @param {AcpMarkdown} el
       * @param {string[]} types
       */
      function listen(el, types) {
        /** @type {Array<[string, unknown]>} */
        const heard = [];
        for (const type of types) el.addEventListener(type, (e) => heard.push([type, /** @type {CustomEvent} */ (e).detail]));
        return heard;
      }
      /** @param {AcpMarkdown} el @param {string} text */
      const click = (el, text) =>
        [...body(el).querySelectorAll('a')].find((a) => a.textContent === text)?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));

      it('opens a link to a file in a tab, a folder in the tree, a web page in the browser', async () => {
        const el = await preview('[doc](other.md) [dir](sub/) [web](https://a.test/x)');
        const heard = listen(el, ['acp-file-open', 'acp-file-reveal', 'acp-link-open']);

        click(el, 'doc');
        click(el, 'dir');
        click(el, 'web');

        expect(heard).to.deep.equal([
          ['acp-file-open', { path: '/p/docs/other.md' }],
          ['acp-file-reveal', { path: '/p/docs/sub', expand: true }],
          ['acp-link-open', { url: 'https://a.test/x' }],
        ]);
      });

      it('scrolls to the heading an anchor names', async () => {
        const wrap = await fixture(
          html`<div style="height: 80px; overflow: auto">
            <acp-markdown policy="document" base-dir="/p" root="/p" .text=${`[go](#The-End)\n\n${'filler\n\n'.repeat(40)}## The End\n\n${'filler\n\n'.repeat(40)}last`}></acp-markdown>
          </div>`,
        );
        const el = /** @type {AcpMarkdown} */ (wrap.firstElementChild);
        await el.updateComplete;
        const heard = listen(el, ['acp-file-open', 'acp-link-open']);

        click(el, 'go');
        await frame();

        const top = /** @type {HTMLElement} */ (body(el).querySelector('#acp-md-the-end')).getBoundingClientRect().top;
        expect(wrap.scrollTop).to.be.greaterThan(100);
        expect(Math.abs(top - wrap.getBoundingClientRect().top)).to.be.lessThan(20);
        expect(heard).to.deep.equal([]);
      });

      it('leaves a link outside the project as text, with nothing to click', async () => {
        const el = await preview('[out](../../etc/passwd)');

        expect(body(el).querySelector('a')).to.equal(null);
      });

      it('names the source line of a block that is double-clicked', async () => {
        const el = await preview('# Title\n\nfirst\n\n- a\n- b\n\nlast');
        const heard = listen(el, ['acp-block-activate']);

        const target = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (body(el).querySelector(selector));
        target('h1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
        target('li:last-child').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));

        expect(heard).to.deep.equal([
          ['acp-block-activate', { line: 1 }],
          ['acp-block-activate', { line: 5 }],
        ]);
      });
    });

    it('gives a reply none of this', async () => {
      const el = await fixture(html`<acp-markdown base-dir="/p/docs" root="/p" .loadImage=${png} .text=${'# T\n\n![x](a.png) [f](b.md)'}></acp-markdown>`);
      await settle();

      expect(body(el).querySelector('img')).to.equal(null);
      expect(body(el).querySelector('[id]')).to.equal(null);
      expect(urls.created).to.have.length(0);
      /** @type {Event[]} */
      const heard = [];
      el.addEventListener('acp-file-open', (/** @type {Event} */ e) => heard.push(e));
      body(el).querySelector('a[href="b.md"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      expect(heard).to.have.length(0);
    });
  });
});
