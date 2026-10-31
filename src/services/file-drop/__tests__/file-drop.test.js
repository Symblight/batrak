import { app } from '../../../hooks/app/app.js';
import { expect } from '@esm-bundle/chai';
import { osScale } from '../../../models/file-drop/file-drop.js';
import { $fileDropTarget } from '../../../stores/file-drop/file-drop.js';
import { fileDrop } from '../file-drop.js';

/** @typedef {import('../../../models/types/types.js').FileDrop} FileDrop */

/**
 * The center of `el`, in the units the webview's drag events use on this platform.
 * @param {Element} el
 */
function osPointOf(el) {
  const r = el.getBoundingClientRect();
  const scale = osScale(app.platformOf(navigator.userAgent), devicePixelRatio);
  return { x: (r.left + r.width / 2) * scale, y: (r.top + r.height / 2) * scale };
}

describe('fileDrop', () => {
  /** @type {HTMLElement} */
  let page;
  /** @type {HTMLElement} */
  let terminal;
  /** @type {HTMLElement} */
  let other;
  /** @type {FileDrop[]} */
  let drops;
  /** @param {Event} e */
  const onDrop = (e) => drops.push(/** @type {CustomEvent<FileDrop>} */ (e).detail);

  beforeEach(() => {
    page = document.createElement('div');
    page.style.cssText = 'position: fixed; inset: 0; display: flex; align-items: start';
    terminal = document.createElement('acp-terminal');
    terminal.attachShadow({ mode: 'open' }).innerHTML = '<div style="width: 200px; height: 100px"></div>';
    terminal.style.display = 'block';
    other = document.createElement('div');
    other.style.cssText = 'width: 100px; height: 100px';
    page.append(terminal, other);
    document.body.append(page);
    drops = [];
    fileDrop.addEventListener('drop', onDrop);
  });

  afterEach(() => {
    fileDrop.handle({ type: 'leave' });
    fileDrop.removeEventListener('drop', onDrop);
    page.remove();
  });

  it('marks the drop target under a file dragged over the window, until it leaves', () => {
    fileDrop.handle({ type: 'enter', paths: ['/a.png'], position: osPointOf(terminal) });
    expect($fileDropTarget.get()).to.equal(terminal);
    fileDrop.handle({ type: 'over', position: osPointOf(other) });
    expect($fileDropTarget.get(), 'over something else').to.equal(null);
    fileDrop.handle({ type: 'over', position: osPointOf(terminal) });
    expect($fileDropTarget.get()).to.equal(terminal);
    fileDrop.handle({ type: 'leave' });
    expect($fileDropTarget.get(), 'left').to.equal(null);
  });

  it('marks nothing for a drag that carries no files', () => {
    fileDrop.handle({ type: 'enter', paths: [], position: osPointOf(terminal) });
    expect($fileDropTarget.get()).to.equal(null);
  });

  it('delivers a drop on a target with its paths and unmarks it, nothing for a drop elsewhere', () => {
    fileDrop.handle({ type: 'drop', paths: ['/a.png'], position: osPointOf(other) });
    expect(drops, 'drop elsewhere').to.deep.equal([]);
    fileDrop.handle({ type: 'enter', paths: ['/a.png', '/b c'], position: osPointOf(terminal) });
    fileDrop.handle({ type: 'drop', paths: ['/a.png', '/b c'], position: osPointOf(terminal) });
    expect(drops).to.deep.equal([{ target: terminal, paths: ['/a.png', '/b c'] }]);
    expect($fileDropTarget.get()).to.equal(null);
  });
});
