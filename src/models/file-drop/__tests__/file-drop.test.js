import { expect } from '@esm-bundle/chai';
import { chatDropOf, composedContains, deepElementFromPoint, dropTargetAt, toCssPoint } from '../file-drop.js';

/**
 * A host with an open shadow root holding `html`.
 * @param {string} tag
 * @param {string} inner
 */
function shadowHost(tag, inner) {
  const host = document.createElement(tag);
  host.attachShadow({ mode: 'open' }).innerHTML = inner;
  return host;
}

/** @param {Element} el */
function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

describe('file drop hit-testing', () => {
  /** @type {HTMLElement} */
  let page;
  /** @type {HTMLElement} */
  let column;
  /** @type {HTMLElement} */
  let terminal;
  /** @type {HTMLElement} */
  let screen;
  /** @type {HTMLElement} */
  let other;

  beforeEach(() => {
    page = document.createElement('div');
    page.style.cssText = 'position: fixed; inset: 0; display: flex';
    column = shadowHost('test-column', '<div style="display: flex; gap: 10px"><span class="other" style="width: 100px; height: 100px"></span></div>');
    terminal = shadowHost('acp-terminal', '<div class="screen" style="width: 200px; height: 100px"></div>');
    terminal.style.display = 'block';
    /** @type {Element} */ (column.shadowRoot?.firstElementChild).append(terminal);
    screen = /** @type {HTMLElement} */ (terminal.shadowRoot?.querySelector('.screen'));
    other = /** @type {HTMLElement} */ (column.shadowRoot?.querySelector('.other'));
    page.append(column);
    document.body.append(page);
  });

  afterEach(() => page.remove());

  it('finds the innermost target under a point through shadow roots, none outside the page', () => {
    const inside = centerOf(screen);
    const beside = centerOf(other);
    expect(deepElementFromPoint(document, inside.x, inside.y), 'innermost element').to.equal(screen);
    expect(dropTargetAt(document, inside.x, inside.y, 'acp-terminal')).to.equal(terminal);
    expect(dropTargetAt(document, inside.x, inside.y, 'test-column, acp-terminal'), 'nested targets').to.equal(terminal);
    expect(dropTargetAt(document, beside.x, beside.y, 'test-column, acp-terminal')).to.equal(column);
    expect(dropTargetAt(document, beside.x, beside.y, 'acp-terminal'), 'not over a target').to.equal(null);
    expect(dropTargetAt(document, -10, -10, 'acp-terminal'), 'outside the page').to.equal(null);
  });

  it('tells whether a node is inside a host, across shadow roots', () => {
    expect(composedContains(column, terminal)).to.equal(true);
    expect(composedContains(column, screen)).to.equal(true);
    expect(composedContains(terminal, other)).to.equal(false);
    expect(composedContains(column, column)).to.equal(true);
  });
});

describe('toCssPoint', () => {
  it('scales Windows physical pixels by the device pixel ratio, keeps macOS and Linux logical ones', () => {
    const cases = [
      ['windows', 1.5, { x: 200, y: 100 }],
      ['mac', 2, { x: 300, y: 150 }],
      ['linux', 2, { x: 300, y: 150 }],
    ];
    for (const [platform, ratio, expected] of cases) {
      expect(toCssPoint({ x: 300, y: 150 }, /** @type {any} */ (platform), /** @type {number} */ (ratio)), String(platform)).to.deep.equal(expected);
    }
  });
});

describe('chatDropOf', () => {
  it('mentions files and folders in the session folder by their relative path, others by their absolute one, images too (the agent reads them)', () => {
    const drop = chatDropOf(
      [
        { path: '/p/src/app.js', kind: 'file' },
        { path: '/p/src', kind: 'folder' },
        { path: '/Users/me/notes.md', kind: 'file' },
        { path: '/Users/me/docs', kind: 'folder' },
        { path: '/p/logo.svg', kind: 'file' },
        { path: '/Users/me/Screen Shot.PNG', kind: 'file' },
      ],
      '/p',
    );
    expect(drop).to.deep.equal([
      { path: 'src/app.js', folder: false },
      { path: 'src', folder: true },
      { path: '/Users/me/notes.md', folder: false },
      { path: '/Users/me/docs', folder: true },
      { path: 'logo.svg', folder: false },
      { path: '/Users/me/Screen Shot.PNG', folder: false },
    ]);
  });

  it('skips what is neither a file nor a folder (gone, a device), and a folder named like an image', () => {
    const drop = chatDropOf(
      [
        { path: '/Users/me/gone.md', kind: 'other' },
        { path: '/Users/me/shots.png', kind: 'folder' },
      ],
      null,
    );
    expect(drop).to.deep.equal([{ path: '/Users/me/shots.png', folder: true }]);
  });
});
