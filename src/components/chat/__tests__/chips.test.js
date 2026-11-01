import { expect } from '@esm-bundle/chai';
import { buildBrowseItem, buildEntryItem, buildMenuItem, codeChip, commentLines, fileChipAttrs } from '../chips.js';

/**
 * A stand-in for the composer's schema: nodes record what they were created with.
 * @returns {import('../chips.js').PmSchema}
 */
function schema() {
  const node = (/** @type {string} */ type) => ({
    create: (/** @type {object | null} */ attrs, /** @type {unknown[]} */ content = []) => ({ type, attrs, content }),
  });
  return /** @type {never} */ ({ nodes: { chip: node('chip'), line: node('line') }, text: (/** @type {string} */ text) => ({ type: 'text', text }) });
}

/** @param {unknown} chip */
const attrsOf = (chip) => /** @type {{ attrs: { label: string, data: Record<string, string>, templateId: string, icon: string } }} */ (chip).attrs;

describe('composer chips', () => {
  it('names a file or folder chip by its name, with the path in its data', () => {
    const file = fileChipAttrs('src/app.js', false);
    expect([file.label, file.data]).to.deep.equal(['app.js', { path: 'src/app.js' }]);
    const folder = fileChipAttrs('/Users/me/docs', true);
    expect([folder.label, folder.data]).to.deep.equal(['docs', { path: '/Users/me/docs', kind: 'folder' }]);
    expect(file.templateId).to.equal(folder.templateId);
    expect(file.icon, 'a file icon').to.match(/^<svg/);
    expect(folder.icon).to.not.equal(file.icon);
  });

  it('labels a code chip with its file relative to the project and its lines', () => {
    /** @type {[string, number, number, string | null, string, string][]} */
    const cases = [
      ['/p/src/app.js', 12, 12, '/p', 'src/app.js:12', 'one line'],
      ['/p/src/app.js', 12, 23, '/p', 'src/app.js:12-23', 'several lines'],
      ['/elsewhere/a.js', 3, 3, '/p', '/elsewhere/a.js:3', 'outside the project stays absolute'],
      ['/p/a.js', 1, 2, null, '/p/a.js:1-2', 'no project'],
    ];
    for (const [path, fromLine, toLine, root, label, why] of cases) {
      const chip = codeChip(schema(), { path, fromLine, toLine, body: '' }, root);
      expect(attrsOf(chip).label, why).to.equal(label);
      expect(attrsOf(chip).data.lines, why).to.equal(fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`);
    }
  });

  it('writes a comment as a line with its chip and first line, then a plain line for each further one', () => {
    const lines = /** @type {{ content: { type: string, text?: string }[] }[]} */ (
      /** @type {unknown} */ (commentLines(schema(), { path: '/p/a.js', fromLine: 4, toLine: 4, body: 'first\nsecond\n\nfourth' }, '/p'))
    );
    expect(lines).to.have.length(4);
    expect(lines[0].content.map((c) => c.type)).to.deep.equal(['chip', 'text']);
    expect(lines[0].content[1].text, 'a space after the chip').to.equal(' first');
    expect(lines.slice(1).map((l) => l.content.map((c) => c.text))).to.deep.equal([['second'], [], ['fourth']]);
  });

  it('builds the @ menu’s items: the entry with its name matches marked, the browse step, a command', () => {
    const entry = buildEntryItem({ path: 'src/components/app.js', name: 'app.js', isDir: false, indices: [15, 16] });
    expect(entry.getAttribute('value')).to.equal('src/components/app.js');
    expect(entry.dataset.kind, 'a file').to.equal(undefined);
    expect([...entry.querySelectorAll('b')].map((b) => b.textContent), 'the matched characters').to.deep.equal(['a', 'p']);
    expect(entry.querySelector('[slot="leading"] svg'), 'its icon').to.not.equal(null);
    expect(entry.querySelector('[slot="trailing"]')?.textContent, 'the folder it is in').to.equal('src/components');

    const folder = buildEntryItem({ path: 'src', name: 'src', isDir: true, indices: [] });
    expect(folder.dataset.kind).to.equal('folder');
    expect(folder.querySelector('[slot="trailing"]'), 'at the top: no folder to name').to.equal(null);

    const browse = buildBrowseItem();
    expect([browse.dataset.browse, browse.textContent?.trim()]).to.deep.equal(['', 'Files and Folders']);

    const command = buildMenuItem('init', '/init', 'Set up the project');
    expect([command.getAttribute('value'), command.firstChild?.textContent, command.querySelector('[slot="supporting-text"]')?.textContent]).to.deep.equal(['init', '/init', 'Set up the project']);
  });
});
