import { expect } from '@esm-bundle/chai';
import { assertFragment, classifyUrl, sanitize } from '../policy.js';

const VOID = new Set(['br', 'hr', 'img', 'input']);

/**
 * A node as markup with its attributes sorted (the sanitizer may reorder them). Read node by node: the
 * fragment lives in an inert document, and moving it into the page's would start whatever an
 * `<img src>` asks for.
 * @param {Node} node
 * @returns {string}
 */
function serialize(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return '';
  const attrs = [...node.attributes].map((a) => ` ${a.name}="${a.value}"`).sort().join('');
  const open = `<${node.localName}${attrs}>`;
  return VOID.has(node.localName) ? open : `${open}${[...node.childNodes].map(serialize).join('')}</${node.localName}>`;
}

/** @param {DocumentFragment | HTMLElement} parent */
const markup = (parent) => [...parent.childNodes].map(serialize).join('');

/** Markup as `serialize` writes it, for comparing. @param {string} html */
const norm = (html) => markup(new DOMParser().parseFromString(html, 'text/html').body);

/**
 * @param {string} html
 * @param {import('../types.js').PolicyName} [policy]
 */
const clean = (html, policy = 'document') => markup(sanitize(html, policy));

/**
 * @param {string} html
 * @param {string} expected
 * @param {import('../types.js').PolicyName} [policy]
 */
const expectClean = (html, expected, policy = 'document') => expect(clean(html, policy), html).to.equal(norm(expected));

describe('markdown policy', () => {
  describe('links', () => {
    it('keeps http, https, mailto, relative and anchor targets and refuses everything else', () => {
      const kinds = /** @type {const} */ ({
        'https://a.test/x': 'external',
        'http://a.test': 'external',
        'mailto:me@a.test': 'external',
        './b.md': 'relative',
        'docs/b.md#top': 'relative',
        '../b.md': 'relative',
        '#intro': 'anchor',
        'javascript:alert(1)': 'blocked',
        'JavaScript:alert(1)': 'blocked',
        ' \u0001javascript:alert(1)': 'blocked',
        'jav\tascript:alert(1)': 'blocked',
        'data:text/html,<b>x</b>': 'blocked',
        'vbscript:x': 'blocked',
        'file:///etc/passwd': 'blocked',
        '//evil.test/x': 'blocked',
        '\\\\evil.test\\x': 'blocked',
        '': 'blocked',
      });
      for (const [url, kind] of Object.entries(kinds)) expect(classifyUrl(url), JSON.stringify(url)).to.equal(kind);
    });

    it('turns a link to a script into its text, whatever way the scheme was written', () => {
      for (const href of ['javascript:alert(1)', 'jav&#x09;ascript:alert(1)', 'java&#10;script:alert(1)', '&#106;avascript:alert(1)']) {
        expect(clean(`<a href="${href}">go</a>`), href).to.equal('go');
      }
      expectClean('<a href="data:text/html;base64,AAAA">go</a>', 'go');
    });

    it('marks an external link so the opener and referrer stay out of it, and drops its target', () => {
      expectClean('<a href="https://a.test" target="_blank" title="t">go</a>', '<a href="https://a.test" title="t" rel="noopener noreferrer ugc">go</a>');
    });

    it('leaves a relative link and an anchor as written, for the renderer to resolve', () => {
      expectClean('<a href="./b.md">b</a><a href="#top">t</a>', '<a href="./b.md">b</a><a href="#top">t</a>');
    });
  });

  describe('elements', () => {
    it('removes what is never allowed together with its content', () => {
      for (const tag of ['style', 'script', 'form', 'iframe', 'object', 'svg', 'math', 'video', 'audio', 'picture']) {
        expect(clean(`before<${tag}>inside</${tag}>after`), tag).to.equal('beforeafter');
      }
      expectClean('a<base href="https://evil.test/">b<embed src="x">c', 'abc');
      expectClean('a<link rel="stylesheet" href="https://evil.test/x.css">b<meta http-equiv="refresh" content="0;url=x">c', 'abc');
      expectClean('<form action="https://evil.test"><input name="x"><button>go</button></form>', '');
    });

    it('removes comments and processing instructions', () => {
      expectClean('a<!-- hidden -->b<?php echo 1 ?>c', 'abc');
    });

    it('unwraps formatting wrappers, keeping their children', () => {
      expectClean('<div><span style="color:red"><b>x</b> <i>y</i></span></div><center><u>z</u></center><font color="red">w</font>', 'x yzw');
    });

    it('keeps the document elements, and from a reply only their text', () => {
      const html = '<details><summary>s</summary>d</details><kbd>k</kbd><sup>1</sup><sub>2</sub><img src="a.png" alt="a">';
      expectClean(html, html);
      expectClean(html, 'sdk12', 'reply');
    });

    it('keeps the text of an element it does not know, which a stray <tag> in prose opens', () => {
      expectClean('<p>Use <path> to open <b>it</b>, then <your-key>paste it</p>', '<p>Use  to open it, then paste it</p>');
      expectClean('<ul><li>Vec<t>items</li></ul><table><tr><td>a<x>b</td></tr></table>', '<ul><li>Vecitems</li></ul><table><tbody><tr><td>ab</td></tr></tbody></table>', 'reply');
    });

    it('keeps the structure of a document', () => {
      const html = '<h1>t</h1><p>a<br><em>b</em><strong>c</strong><del>d</del><code>e</code></p><hr><blockquote><p>q</p></blockquote><ul><li>x</li></ul><ol start="3"><li>y</li></ol><pre><code>z</code></pre>';
      expectClean(html, html);
      const table = '<table><thead><tr><th align="left">h</th></tr></thead><tbody><tr><td align="right">c</td></tr></tbody></table>';
      expectClean(table, table);
    });
  });

  describe('attributes', () => {
    it('drops style, class, id, tabindex, data and event attributes', () => {
      expect(
        clean('<p style="color:red" class="x" id="a" tabindex="0" data-x="1" aria-label="l" onclick="alert(1)" onmouseover="alert(2)" title="t">p</p>'),
      ).to.equal('<p>p</p>');
      expectClean('<a href="https://a.test" onclick="x()" style="x" id="i" name="n">a</a>', '<a href="https://a.test" rel="noopener noreferrer ugc">a</a>');
    });

    it('keeps an attribute only on the element it belongs to', () => {
      expectClean('<p href="https://a.test" src="x.png" alt="a" start="2" align="left">p</p>', '<p>p</p>');
      expectClean('<img src="a.png" alt="a" title="t" width="10" height="5" align="left" href="x">', '<img src="a.png" alt="a" title="t" width="10" height="5">');
    });

    it('keeps only language classes on code', () => {
      expectClean('<code class="language-js evil other">x</code>', '<code class="language-js">x</code>');
      expectClean('<code class="evil">x</code>', '<code>x</code>');
    });
  });

  describe('images', () => {
    it('keeps a relative image and turns any other into its alt text, a web one into a link', () => {
      expectClean('<img src="./pics/a.png" alt="a">', '<img src="./pics/a.png" alt="a">');
      expectClean('<img src="https://a.test/x.png" alt="logo">', '<a href="https://a.test/x.png" rel="noopener noreferrer ugc">logo</a>');
      expectClean('<img src="data:image/png;base64,AAAA" alt="inline">', 'inline');
      expectClean('<img src="javascript:alert(1)" alt="x">', 'x');
      expectClean('<img src="//evil.test/x.png" alt="x">', 'x');
      expectClean('<img alt="nothing">', 'nothing');
    });

    it('shows the alt text of a web image that is the content of a link, so the link stays one link', () => {
      expectClean(
        '<a href="https://target.test"><img src="https://img.test/b.svg" alt="badge"></a>',
        '<a href="https://target.test" rel="noopener noreferrer ugc">badge</a>',
      );
    });

    it('falls back to the address when a web image has no alt text', () => {
      expectClean('<img src="https://a.test/x.png">', '<a href="https://a.test/x.png" rel="noopener noreferrer ugc">https://a.test/x.png</a>');
    });
  });

  describe('task lists', () => {
    it('keeps a checkbox and forces it disabled', () => {
      expectClean('<input type="checkbox" checked>', '<input type="checkbox" checked="" disabled="">');
      expectClean('<input type="checkbox" disabled="" name="x" value="1" onclick="x()">', '<input type="checkbox" disabled="">');
    });

    it('removes every other input', () => {
      expectClean('a<input type="text" value="x">b<input>c<input type="password">d', 'abcd');
    });
  });

  describe('a failed sanitizer', () => {
    it('is an error when it answers anything but a fragment', () => {
      expect(() => assertFragment(null)).to.throw();
      expect(() => assertFragment('')).to.throw();
      expect(() => assertFragment('<p>x</p>')).to.throw();
      const fragment = document.createDocumentFragment();
      expect(assertFragment(fragment)).to.equal(fragment);
    });

    it('is still a fragment for empty input', () => {
      expectClean('', '');
    });
  });

  it('does not touch the chat’s sanitizer', async () => {
    const { default: DOMPurify } = await import('dompurify');
    sanitize('<p>x</p>', 'document');
    expect(DOMPurify.sanitize('<p onclick="x" data-y="1">z</p>', { ALLOW_DATA_ATTR: true })).to.contain('data-y');
  });
});
