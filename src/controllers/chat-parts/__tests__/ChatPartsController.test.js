import { expect } from '@esm-bundle/chai';
import { fileIcon } from '../../../components/file-icon/file-icon.js';
import { locationChip } from '../ChatPartsController.js';

/** @param {string | null} svg The markup as the DOM serializes it. */
const asHtml = (svg) => Object.assign(document.createElement('div'), { innerHTML: svg ?? '' }).innerHTML;

describe('locationChip', () => {
  it("shows a tool call's file with its type's icon, its name, and its path and line as the title", () => {
    const chip = locationChip({ path: 'docs/CLAUDE.md', line: 12 });
    expect(chip.localName).to.equal('chx-chip');
    expect(chip.querySelector('md-icon[slot="icon"]')?.innerHTML).to.equal(asHtml(fileIcon.svgFor('CLAUDE.md')));
    expect(chip.textContent).to.equal('CLAUDE.md');
    expect(chip.title).to.equal('docs/CLAUDE.md:12');
    expect({ ...chip.dataset }).to.deep.equal({ path: 'docs/CLAUDE.md', line: '12' });
  });

  it('falls back to the plain file icon for a type it has no icon for', () => {
    const chip = locationChip({ path: 'notes.unknownext' });
    expect(chip.querySelector('md-icon')?.innerHTML).to.equal(asHtml(fileIcon.svgFor('README')));
    expect(chip.title).to.equal('notes.unknownext');
    expect({ ...chip.dataset }).to.deep.equal({ path: 'notes.unknownext' });
  });
});
