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
const shown = (el) => el.shadowRoot?.querySelector('md-icon')?.innerHTML.replace(/<!--.*?-->/g, '') ?? '';

describe('fileIcon', () => {
  it('finds a language logo by extension, case-insensitively', () => {
    expect(fileIcon.svgFor('main.rs')).to.equal(fileIcon.svgFor('LIB.RS'));
    expect(fileIcon.svgFor('main.rs')).to.not.equal(fileIcon.svgFor('main.py'));
  });

  it('finds a logo by file name before the extension', () => {
    expect(fileIcon.svgFor('package.json')).to.not.equal(fileIcon.svgFor('other.json'));
    expect(fileIcon.svgFor('Dockerfile')).to.not.equal(fileIcon.svgFor('Makefile'));
  });

  it('falls back to the generic file icon, and to the folder icon for a folder', () => {
    const generic = fileIcon.svgFor('notes.unknownext');
    expect(generic).to.equal(fileIcon.svgFor('README'));
    expect(fileIcon.svgFor('src', true)).to.not.equal(generic);
    expect(fileIcon.svgFor('main.rs', true)).to.equal(fileIcon.svgFor('src', true));
  });

  it('knows which names have a logo of their own', () => {
    expect(fileIcon.has('main.rs')).to.equal(true);
    expect(fileIcon.has('notes.unknownext')).to.equal(false);
  });
});

describe('acp-file-icon', () => {
  it('shows the logo of a known file', async () => {
    const el = await fixture(html`<acp-file-icon name="main.rs"></acp-file-icon>`);
    expect(shown(el)).to.equal(asHtml(fileIcon.svgFor('main.rs')));
  });

  it('shows the generic icon for an unknown file and the folder icon for a folder', async () => {
    const el = await fixture(html`<acp-file-icon name="notes.unknownext"></acp-file-icon>`);
    expect(shown(el)).to.equal(asHtml(fileIcon.svgFor('notes.unknownext')));
    el.folder = true;
    await el.updateComplete;
    expect(shown(el)).to.equal(asHtml(fileIcon.svgFor('notes.unknownext', true)));
  });

  it('follows the name', async () => {
    const el = await fixture(html`<acp-file-icon name="a.rs"></acp-file-icon>`);
    el.name = 'a.py';
    await el.updateComplete;
    expect(shown(el)).to.equal(asHtml(fileIcon.svgFor('a.py')));
  });
});
