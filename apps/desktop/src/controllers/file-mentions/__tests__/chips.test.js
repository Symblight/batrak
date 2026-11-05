import { expect } from '@esm-bundle/chai';
import { buildBrowseItem, buildEntryItem, buildMenuItem, codeChip, commentLines, fileChipAttrs, recalledDoc } from '../chips.js';
import { COMMAND_CHIP_TEMPLATE } from '../../chat-parts/ChatPartsController.js';

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

  it('rebuilds a replayed prompt from its text: chips, pastes and lines', () => {
    // Arrange
    /** @param {string} text */
    const text = (text) => ({ type: 'text', text });
    /** @param {string} path */
    const file = (path) => ({ type: 'chip', attrs: fileChipAttrs(path, false) });
    /** @param {string} path */
    const folder = (path) => ({ type: 'chip', attrs: fileChipAttrs(path, true) });
    /** @param {string} label */
    const command = (label) => ({ type: 'chip', attrs: { templateId: COMMAND_CHIP_TEMPLATE, label, icon: null, data: {} } });
    /** @param {string} code @param {number} lines @param {string} lang */
    const code = (code, lines, lang) => ({ type: 'paste', attrs: { text: code, lines, data: { kind: 'code', lang } } });
    /** @type {[string, unknown[][], string][]} */
    const cases = [
      ['plain\n\nlines', [[text('plain')], [], [text('lines')]], 'text and line breaks'],
      ['see @src/a.js now', [[text('see '), file('src/a.js'), text(' now')]], 'a file chip'],
      ['in @src/ please', [[text('in '), folder('src'), text(' please')]], 'a folder chip'],
      ['src/a.js:12-23 why', [[text('src/a.js:12-23 why')]], 'lines stay text: they may be a pasted stack trace'],
      ['/review the rest', [[command('/review'), text(' the rest')]], 'a command chip at the start'],
      ['run /review now', [[text('run /review now')]], 'a command only at the start'],
      ['/etc/hosts is odd', [[text('/etc/hosts is odd')]], 'a path is not a command'],
      ['look\n```js\na\nb\n```\nthen', [[text('look'), code('a\nb', 2, 'js'), text('then')]], 'a fence is a paste'],
      ['bare src/app.js stays', [[text('bare src/app.js stays')]], 'a bare path stays one text'],
    ];

    for (const [written, content, why] of cases) {
      // Act
      const doc = recalledDoc({ id: 'm', own: true, createdAt: 0, parts: [{ id: 'p', type: 'text', text: written }] });

      // Assert
      expect(doc, why).to.deep.equal({
        type: 'doc',
        content: content.map((line) => (line.length ? { type: 'line', content: line } : { type: 'line' })),
      });
    }
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
