import { expect } from '@esm-bundle/chai';
import { markdown } from '../markdown.js';

const FILE = { baseDir: '/p/docs', root: '/p' };

/**
 * @param {string} text
 * @param {Parameters<typeof markdown.render>[1]} [options]
 */
const doc = (text, options = { policy: 'document', ...FILE }) => markdown.render(text, options);

/** @param {DocumentFragment} fragment */
const tags = (fragment) => [...fragment.children].map((n) => n.localName);

describe('markdown.render', () => {
  describe('block map', () => {
    it('pairs each top-level node with the line its source starts on', () => {
      const { fragment, blocks } = doc(['# Title', '', 'Para', '', '```js', 'a', '```', '', '- x', '- y', '', '> q'].join('\n'));
      expect(blocks.map((b) => b.line)).to.deep.equal([1, 3, 5, 9, 12]);
      expect(blocks.map((b) => b.node)).to.deep.equal([...fragment.children]);
    });

    it('has no map when the nodes cannot be told from the blocks (HTML that sanitizes away or splits)', () => {
      expect(doc('<script>x</script>\n\ntext').blocks).to.deep.equal([]);
      expect(doc('<h1>a</h1>\n<h2>b</h2>\n\ntext').blocks).to.have.length(0);
    });

    it('pairs the nodes of a file of blank lines, definitions and rules', () => {
      const { blocks } = doc('\n\n[r]: https://a.test\n\n---\n\ntext [r]');
      expect(blocks.map((b) => b.line)).to.deep.equal([5, 7]);
    });
  });

  describe('headings', () => {
    it('gives a document heading an id from its text, numbered when it repeats', () => {
      const { fragment } = doc('# Intro\n\n## Usage\n\n## Usage\n\n### Hello, World!');
      expect([...fragment.querySelectorAll('h1,h2,h3')].map((h) => h.id)).to.deep.equal([
        'acp-md-intro',
        'acp-md-usage',
        'acp-md-usage-1',
        'acp-md-hello-world',
      ]);
    });

    it('never takes an id the file wrote itself', () => {
      const { fragment } = doc('<h2 id="x">Hi</h2>\n\n<p id="intro">p</p>');
      expect([...fragment.querySelectorAll('[id]')].map((n) => n.id)).to.deep.equal(['acp-md-hi']);
    });

    it('gives a reply no ids', () => {
      expect(markdown.render('# Intro', { policy: 'reply' }).fragment.querySelector('[id]')).to.equal(null);
    });
  });

  describe('code', () => {
    it('puts a fence in a code block with its language, and a copy button', () => {
      const { fragment } = doc('```ts\nconst a: number = 1;\n```\n\n```\nplain\n```\n\n```sh\nls\n```');
      const blocks = /** @type {any[]} */ ([...fragment.querySelectorAll('chx-code-block')]);
      expect(blocks.map((b) => [b.lang, b.code, b.copyable])).to.deep.equal([
        ['typescript', 'const a: number = 1;', true],
        ['', 'plain', true],
        ['bash', 'ls', true],
      ]);
      expect(fragment.querySelector('pre')).to.equal(null);
    });
  });

  describe('classes', () => {
    it('names the elements by the block’s classes', () => {
      const { fragment } = doc('# T\n\ntext `code` [l](https://a.test)\n\n- [x] done\n\n> q');
      expect(fragment.querySelector('h1')?.className).to.equal('acp-markdown__heading acp-markdown__heading_level-1');
      expect(fragment.querySelector('p')?.className).to.equal('acp-markdown__paragraph');
      expect(fragment.querySelector('code')?.className).to.equal('acp-markdown__code');
      expect(fragment.querySelector('a')?.className).to.equal('acp-markdown__link');
      expect(fragment.querySelector('input')?.className).to.equal('acp-markdown__checkbox');
      expect(fragment.querySelector('blockquote')?.className).to.equal('acp-markdown__quote');
    });

    it('lets the caller rewrite the nodes before the classes go on', () => {
      const { fragment } = markdown.render('hello', {
        policy: 'reply',
        decorate: (root) => root.querySelector('p')?.append(Object.assign(document.createElement('a'), { href: '#x' })),
      });
      expect(fragment.querySelector('a')?.className).to.equal('acp-markdown__link');
    });
  });

  describe('the reply policy', () => {
    it('turns an image into a link to it', () => {
      const { fragment, images } = markdown.render('![logo](https://a.test/x.png)\n\n![local](pic.png)', { policy: 'reply' });
      expect(fragment.querySelector('img')).to.equal(null);
      expect([...fragment.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).to.deep.equal([
        ['logo', 'https://a.test/x.png'],
        ['local', 'pic.png'],
      ]);
      expect(images).to.deep.equal([]);
    });

    it('drops document-only elements and keeps tables, task lists and quotes', () => {
      const { fragment } = markdown.render('<kbd>k</kbd> <sup>1</sup>\n\n| a |\n| - |\n| 1 |\n\n- [ ] t', { policy: 'reply' });
      expect(fragment.querySelector('kbd,sup')).to.equal(null);
      expect(fragment.querySelector('table')).to.not.equal(null);
      expect(fragment.querySelector('input[type=checkbox]')).to.not.equal(null);
    });

    it('keeps the text around something like <path> or Vec<T> that is no markup', () => {
      const { fragment } = markdown.render('Use <path> to open it. A Vec<T> of things, and <your-key> last.', { policy: 'reply' });
      expect(fragment.textContent).to.contain('to open it').and.contain('of things').and.contain('last.');
    });

    it('records the web links to open in the browser', () => {
      const { links } = markdown.render('[a](https://a.test/x?q=1) and <https://b.test> and [m](mailto:me@a.test)', { policy: 'reply' });
      expect([...links.values()]).to.deep.equal([
        { kind: 'external', target: 'https://a.test/x?q=1' },
        { kind: 'external', target: 'https://b.test/' },
        { kind: 'external', target: 'mailto:me@a.test' },
      ]);
    });

    it('keeps a relative link as written, for the caller’s own file refs', () => {
      const { fragment, links } = markdown.render('[f](src/app.js)', { policy: 'reply' });
      expect(fragment.querySelector('a')?.getAttribute('href')).to.equal('src/app.js');
      expect(links.size).to.equal(0);
    });
  });

  describe('links in a document', () => {
    it('resolves a relative link against the file’s folder into a path in the project', () => {
      const { links } = doc('[a](other.md) [b](../README.md#top) [c](./sub/x.png) [d](sub/) [e](my%20file.md)');
      expect([...links.values()]).to.deep.equal([
        { kind: 'file', target: '/p/docs/other.md', folder: false, hash: '' },
        { kind: 'file', target: '/p/README.md', folder: false, hash: 'top' },
        { kind: 'file', target: '/p/docs/sub/x.png', folder: false, hash: '' },
        { kind: 'file', target: '/p/docs/sub', folder: true, hash: '' },
        { kind: 'file', target: '/p/docs/my file.md', folder: false, hash: '' },
      ]);
    });

    it('takes an absolute path inside the project too', () => {
      expect([...doc('[a](/p/src/a.js)').links.values()][0]).to.include({ kind: 'file', target: '/p/src/a.js' });
    });

    it('leaves a link out of the project, or into .git, as plain text', () => {
      const { fragment, links } = doc('[a](../../etc/passwd) [b](/etc/passwd) [c](../.git/config) [d](.GIT/HEAD)');
      expect(fragment.querySelector('a')).to.equal(null);
      expect(fragment.textContent?.trim()).to.equal('a b c d');
      expect(links.size).to.equal(0);
    });

    it('leaves a relative link as text when the file has no place in a project', () => {
      const { fragment } = doc('[a](b.md)', { policy: 'document' });
      expect(fragment.querySelector('a')).to.equal(null);
    });

    it('points an anchor at the heading id it names', () => {
      const { links } = doc('[a](#Hello-World) [b](#usage-1) [c](#%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82)');
      expect([...links.values()]).to.deep.equal([
        { kind: 'anchor', target: 'acp-md-hello-world' },
        { kind: 'anchor', target: 'acp-md-usage-1' },
        { kind: 'anchor', target: 'acp-md-привет' },
      ]);
    });

    it('turns a script link into its text', () => {
      const { fragment, links } = doc('[x](javascript:alert(1)) <a href="data:text/html,x">y</a>');
      expect(fragment.querySelector('a')).to.equal(null);
      expect(links.size).to.equal(0);
    });
  });

  describe('images in a document', () => {
    it('lists a local image to be loaded and leaves its node without a source', () => {
      const { fragment, images } = doc('![one](pic.png) ![two](../shots/a.png "t") <img src="/p/b.png" alt="three">');
      expect(images.map((i) => i.path)).to.deep.equal(['/p/docs/pic.png', '/p/shots/a.png', '/p/b.png']);
      for (const { node } of images) {
        expect(fragment.contains(node)).to.equal(true);
        expect(node.hasAttribute('src')).to.equal(false);
      }
      expect(images.map((i) => i.node.alt)).to.deep.equal(['one', 'two', 'three']);
    });

    it('shows the alt text of an image outside the project, a web link for a web image', () => {
      const { fragment, images } = doc('![a](../../x.png) ![b](https://a.test/b.png) ![c](data:image/png;base64,AAAA) ![d](//evil.test/d.png)');
      expect(images).to.deep.equal([]);
      expect(fragment.querySelector('img')).to.equal(null);
      expect(fragment.textContent?.trim()).to.equal('a b c d');
      expect(fragment.querySelector('a')?.getAttribute('href')).to.equal('https://a.test/b.png');
    });

    it('keeps a badge that is a link one link to where the link goes', () => {
      const { fragment, links } = doc('[![build](https://img.test/b.svg)](https://target.test/ci)');

      expect(fragment.querySelectorAll('a')).to.have.length(1);
      expect([...links.values()]).to.deep.equal([{ kind: 'external', target: 'https://target.test/ci' }]);
      expect(fragment.querySelector('a')?.textContent).to.equal('build');
    });

    it('lists at most 200 and gives the rest as alt text', () => {
      const text = Array.from({ length: 205 }, (_, i) => `![n${i}](i${i}.png)`).join(' ');
      const { fragment, images } = doc(text);
      expect(images).to.have.length(200);
      expect(fragment.textContent).to.contain('n204').and.not.contain('n199 ');
      expect(fragment.querySelectorAll('img')).to.have.length(200);
    });
  });

  describe('safety', () => {
    it('makes no request for an image in what it renders', async () => {
      const probe = `/__markdown_probe_${Date.now()}`;
      const requested = () => performance.getEntriesByType('resource').filter((e) => e.name.includes(probe)).map((e) => e.name);
      const { fragment } = doc(
        `<img src="${probe}/raw.png"> <img src="http://localhost:1${probe}/web.png"> ![m](${probe}/md.png)\n\n<picture><source srcset="${probe}/s.png"></picture>`,
        { policy: 'document', baseDir: '/p', root: '/p' },
      );
      // A control: the same markup in the page itself does load, so the check can see a request.
      const live = new Image();
      live.src = `${probe}/live.png`;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fragment.ownerDocument).to.not.equal(document);
      expect(requested()).to.deep.equal([new URL(`${probe}/live.png`, location.href).href]);
    });

    it('is fine with an empty text', () => {
      const { fragment, blocks, images, links } = doc('');
      expect(tags(fragment)).to.deep.equal([]);
      expect([blocks, images]).to.deep.equal([[], []]);
      expect(links.size).to.equal(0);
    });

    it('does not run what the text holds', async () => {
      const { fragment } = doc('<img src=x onerror="window.__pwned = 1"><svg onload="window.__pwned = 1"></svg>');
      const host = document.body.appendChild(document.createElement('div'));
      host.append(fragment);
      await new Promise((resolve) => setTimeout(resolve, 50));
      host.remove();
      expect(/** @type {any} */ (window).__pwned).to.equal(undefined);
    });
  });
});
