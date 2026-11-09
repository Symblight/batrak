import { expect } from '@esm-bundle/chai';
import { markdown } from '../../../hooks/markdown/markdown.js';
import { LitElement } from 'lit';
import { ChatPartsController, formatFileRefs } from '../ChatPartsController.js';
import { $activeSessionId } from '../../../stores/sessions/sessions.js';
import { subagentCardId } from '../../../hooks/sessions/rules.js';

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

  it('folds your own message to its last lines, updating it in place; never an agent reply', async () => {
    // Arrange
    const host = /** @type {PartsHost} */ (document.body.appendChild(new PartsHost()));
    const text = /** @type {(part: unknown, previous: Element | null, message: unknown) => HTMLElement} */ (host.parts.partElements.text);
    try {
      // Act
      const own = text({ id: 'p', type: 'text', text: 'Read @CLAUDE.md\nthen write' }, null, { own: true });
      const again = text({ id: 'p', type: 'text', text: 'Read @CLAUDE.md\nthen write AGENTS.md' }, own, { own: true });
      const reply = text({ id: 'r', type: 'text', text: 'Done' }, null, { own: false });

      // Assert
      expect(own.localName).to.equal('acp-collapsible-text');
      expect(again, 'the same element').to.equal(own);
      expect(again.textContent).to.equal('Read CLAUDE.mdthen write AGENTS.md');
      expect(again.querySelector('chx-chip')?.textContent, 'its file refs as chips').to.equal('CLAUDE.md');
      expect(reply.localName).to.equal('acp-markdown');
    } finally {
      host.remove();
    }
  });

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

  it('draws a reply’s work as one row, live until it finishes, a stopped reply’s running calls cancelled', () => {
    // Arrange
    const host = /** @type {PartsHost} */ (document.body.appendChild(new PartsHost()));
    const work = /** @type {(part: unknown, previous: Element | null) => HTMLElement} */ (host.parts.partElements.work);
    const step = (/** @type {string} */ id, /** @type {string} */ status) => ({
      kind: 'tool',
      call: { toolCallId: id, label: 'Run', worded: false, command: 'npm test', kind: 'execute', status, locations: [], error: '', diff: null, startedAt: null, endedAt: null },
    });
    const steps = [step('t1', 'completed'), step('t2', 'in_progress')];
    try {
      // Act
      const live = /** @type {import('../../../components/reply-work/reply-work.js').AcpReplyWork} */ (work({ id: 'w', type: 'work', status: 'in_progress', data: { steps } }, null));
      const liveFlag = live.live;
      const stopped = /** @type {typeof live} */ (work({ id: 'w', type: 'work', status: 'cancelled', data: { steps } }, live));
      // Assert
      expect([live.localName, liveFlag]).to.deep.equal(['acp-reply-work', true]);
      expect(stopped, 'the same row').to.equal(live);
      expect(stopped.live).to.equal(false);
      expect(stopped.steps.map((s) => s.kind === 'tool' && s.call.status), 'stopped').to.deep.equal(['completed', 'cancelled']);
    } finally {
      host.remove();
    }
  });

  it('draws a folded text or thought as nothing', () => {
    // Arrange
    const host = /** @type {PartsHost} */ (document.body.appendChild(new PartsHost()));
    const { text, thought } = /** @type {Record<string, (part: unknown, previous: Element | null, message: unknown) => HTMLElement>} */ (/** @type {unknown} */ (host.parts.partElements));
    const message = { own: false, parts: [] };
    try {
      // Act
      const shown = [
        text({ id: 'a', type: 'text', text: 'I will look.', data: { folded: true } }, null, message),
        thought({ id: 'b', type: 'thought', text: 'Hmm', data: { folded: true } }, null, message),
        text({ id: 'c', type: 'text', text: 'Done.' }, null, message),
      ].map((el) => el.hidden);
      // Assert
      expect(shown).to.deep.equal([true, true, false]);
    } finally {
      host.remove();
    }
  });

  it('opens the file a group’s summary names', async () => {
    // Arrange
    $activeSessionId.set(null);
    const host = /** @type {PartsHost} */ (document.body.appendChild(new PartsHost()));
    /** @type {unknown[]} */
    const opened = [];
    host.addEventListener('acp-file-open', (e) => opened.push(/** @type {CustomEvent} */ (e).detail));
    try {
      // Act
      host.dispatchEvent(new CustomEvent('acp-tool-location-click', { detail: { path: '/p/a.rs', line: 3 }, bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Assert
      expect(opened).to.deep.equal([{ path: '/p/a.rs', line: 3 }]);
    } finally {
      host.remove();
    }
  });
});
