import { expect } from '@esm-bundle/chai';
import { fileIcon } from '../../../components/file-icon/file-icon.js';
import { markdown } from '../../../hooks/markdown/markdown.js';
import { LitElement } from 'lit';
import { ChatPartsController, formatFileRefs, locationChip } from '../ChatPartsController.js';
import { $activeSessionId } from '../../../stores/sessions/sessions.js';
import { subagentCardId } from '../../../hooks/sessions/rules.js';

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

describe('formatFileRefs', () => {
  it('turns a file ref in a reply into a chip that carries its path and lines', async () => {
    // Arrange: a reply with a file ref, rendered into the inert fragment
    const { fragment } = markdown.render('See `src/main.js:3` now', {
      decorate: (root) => formatFileRefs(root, { links: true }),
    });
    const host = document.body.appendChild(document.createElement('div'));

    // Act: the fragment goes into the page
    host.append(fragment);
    const chip = /** @type {HTMLElement} */ (host.querySelector('chx-chip'));

    // Assert
    expect({ ...chip.dataset }).to.deep.equal({ templateId: 'acp-chat-file-chip', path: 'src/main.js', lines: '3' });
    expect(chip.title).to.equal('src/main.js:3');
    expect(chip.textContent).to.equal('main.js:3');
    host.remove();
  });
});

describe('ChatPartsController', () => {
  class PartsHost extends LitElement {
    parts = new ChatPartsController(this, { attachments: () => /** @type {never} */ (null) });
  }
  customElements.define('test-chat-parts-host', PartsHost);
  afterEach(() => $activeSessionId.set(null));

  it("opens a subagent's chat when its card in a reply is clicked, never for a tool call of the agent's", async () => {
    const cases = [
      { data: { toolCallId: subagentCardId('c1'), subagentId: 'c1' }, opened: [{ sessionId: 's1', subagentId: 'c1' }], why: 'a card' },
      { data: { toolCallId: 'subagent-x' }, opened: [], why: "the agent's tool call, whatever its id" },
    ];
    for (const c of cases) {
      // Arrange
      $activeSessionId.set('s1');
      const host = /** @type {PartsHost} */ (document.body.appendChild(new PartsHost()));
      const list = host.appendChild(document.createElement('chx-message-list'));
      const toolCall = /** @type {(part: unknown, previous: Element | null) => HTMLElement} */ (host.parts.partElements.tool_call);
      const card = list.appendChild(toolCall({ id: 'p', type: 'tool_call', label: 'Explore · Find usages', status: 'in_progress', data: c.data }, null));
      /** @type {unknown[]} */
      const opened = [];
      host.addEventListener('acp-subagent-open', (e) => opened.push(/** @type {CustomEvent} */ (e).detail));
      try {
        // Act
        card.click();
        // Assert
        expect(opened, c.why).to.deep.equal(c.opened);
      } finally {
        host.remove();
      }
    }
  });
});
