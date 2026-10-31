import { expect, fixture, html } from '../../../../test/fixture.js';
import '../file-icon.js';
import { fileIcon } from '../file-icon.js';

/** The markup as the browser serializes it, so it compares with what an element renders. */
const asHtml = (/** @type {string} */ svg) => {
  const template = document.createElement('template');
  template.innerHTML = svg;
  return template.innerHTML;
};

/** @param {Element} el */
const shown = (el) => el.querySelector('md-icon')?.innerHTML.replace(/<!--.*?-->/g, '') ?? '';

describe('fileIcon', () => {
  it('finds a logo by file name, then by extension, case-insensitively', () => {
    expect(fileIcon.svgFor('main.rs')).to.equal(fileIcon.svgFor('LIB.RS'));
    expect(fileIcon.svgFor('main.rs')).to.not.equal(fileIcon.svgFor('main.py'));
    expect(fileIcon.svgFor('package.json')).to.not.equal(fileIcon.svgFor('other.json'));
    expect(fileIcon.svgFor('Dockerfile')).to.not.equal(fileIcon.svgFor('Makefile'));
  });

  it('falls back to the generic file icon, and to the folder icon for a folder; knows which names have a logo', () => {
    const generic = fileIcon.svgFor('notes.unknownext');
    expect(generic).to.equal(fileIcon.svgFor('README'));
    expect(fileIcon.svgFor('src', true)).to.not.equal(generic);
    expect(fileIcon.svgFor('main.rs', true)).to.equal(fileIcon.svgFor('src', true));
    expect(fileIcon.has('main.rs')).to.equal(true);
    expect(fileIcon.has('notes.unknownext')).to.equal(false);
  });
});

describe('acp-file-icon', () => {
  it('renders into itself, showing the logo of a known file, the generic icon, or the folder icon, following name and folder', async () => {
    const el = await fixture(html`<acp-file-icon name="main.rs"></acp-file-icon>`);
    expect(el.shadowRoot === null, 'no shadow root').to.equal(true);
    expect(shown(el), 'known file').to.equal(asHtml(fileIcon.svgFor('main.rs')));
    el.name = 'a.py';
    await el.updateComplete;
    expect(shown(el), 'follows the name').to.equal(asHtml(fileIcon.svgFor('a.py')));
    el.name = 'notes.unknownext';
    await el.updateComplete;
    expect(shown(el), 'unknown file').to.equal(asHtml(fileIcon.svgFor('notes.unknownext')));
    el.folder = true;
    await el.updateComplete;
    expect(shown(el), 'folder').to.equal(asHtml(fileIcon.svgFor('notes.unknownext', true)));
  });
});
