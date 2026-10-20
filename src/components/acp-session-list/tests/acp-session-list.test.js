import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-session-list.js';

/** @typedef {import('../acp-session-list.js').AcpSessionList} AcpSessionList */
/** @typedef {import('../../../models/types.js').Session} Session */
/** @typedef {import('../../../models/types.js').Project} Project */

/** @type {Project[]} */
const PROJECTS = [
  { id: '/home/me/brama', name: 'brama', path: '/home/me/brama' },
  { id: '/home/me/rich', name: 'rich', path: '/home/me/rich' },
];

/**
 * @param {string} id
 * @param {Partial<Session>} [fields]
 * @returns {Session}
 */
function session(id, fields = {}) {
  return {
    id,
    projectId: '/home/me/brama',
    title: `Session ${id}`,
    status: 'idle',
    agentId: 'a',
    config: {},
    mode: 'local',
    folder: '/home/me/brama',
    worktreePath: null,
    branch: null,
    baseCommit: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
    ...fields,
  };
}

const SESSIONS = [
  session('a', { lastActivityAt: '2026-01-02T00:00:00.000Z' }),
  session('b', { lastActivityAt: '2026-01-03T00:00:00.000Z' }),
  session('c', { lastActivityAt: '2026-01-01T00:00:00.000Z' }),
  session('r', { projectId: '/home/me/rich', mode: 'worktree', branch: 'brama/r-1' }),
];

/**
 * @param {Partial<AcpSessionList>} [props]
 * @returns {Promise<{ el: AcpSessionList, root: ShadowRoot }>}
 */
async function render(props = {}) {
  const el = /** @type {AcpSessionList} */ (
    await fixture(html`<acp-session-list .projects=${PROJECTS} .sessions=${SESSIONS} home="/home/me"></acp-session-list>`)
  );
  Object.assign(el, props);
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/**
 * @param {Element} el
 * @param {string} type
 * @returns {CustomEvent[]}
 */
function record(el, type) {
  /** @type {CustomEvent[]} */
  const events = [];
  el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
  return events;
}

/**
 * @param {ShadowRoot} root
 * @param {string} title
 */
function row(root, title) {
  const found = [...root.querySelectorAll('.acp-session-list__row')].find((r) => r.textContent?.includes(title));
  if (!found) throw new Error(`no row for ${title}`);
  return /** @type {HTMLElement} */ (found);
}

/** @param {ShadowRoot} root */
function titles(root) {
  return [...root.querySelectorAll('.acp-session-list__title')].map((t) => t.textContent?.trim());
}

describe('acp-session-list', () => {
  it('groups sessions under their project, pinned first, then the most recently active', async () => {
    const { root } = await render({ pinned: ['c'] });
    const groups = [...root.querySelectorAll('.acp-session-list__project-name')].map((n) => n.textContent?.trim());
    expect(groups).to.deep.equal(['brama', 'rich']);
    expect(root.querySelector('.acp-session-list__project-path')?.textContent).to.equal('~/brama');
    expect(titles(root)).to.deep.equal(['Session c', 'Session b', 'Session a', 'Session r']);
    expect(row(root, 'Session c').querySelector('.acp-session-list__pin')).to.not.equal(null);
    expect(row(root, 'Session b').querySelector('.acp-session-list__pin')).to.equal(null);
  });

  it('shows a worktree session’s branch and each session’s age', async () => {
    const { root } = await render();
    expect(row(root, 'Session r').querySelector('.acp-session-list__branch')?.getAttribute('title')).to.equal(
      'Worktree on brama/r-1',
    );
    expect(row(root, 'Session a').querySelector('.acp-session-list__age')?.textContent).to.match(/^\d+d$/);
  });

  it('hides a collapsed project’s sessions and counts them', async () => {
    const { root } = await render({ collapsed: ['/home/me/brama'] });
    expect(titles(root)).to.deep.equal(['Session r']);
    expect(root.querySelector('.acp-session-list__count')?.textContent).to.equal('3');
  });

  it('marks the selected session, and unread ones until they are opened', async () => {
    const { root } = await render({ activeSessionId: 'a', unread: ['b'] });
    expect(row(root, 'Session a').classList.contains('acp-session-list__row_selected')).to.equal(true);
    const title = /** @type {Element} */ (row(root, 'Session b').querySelector('.acp-session-list__title'));
    expect(title.classList.contains('acp-session-list__title_unread')).to.equal(true);
    const status = /** @type {HTMLElementTagNameMap['acp-session-status']} */ (
      row(root, 'Session b').querySelector('acp-session-status')
    );
    expect(status.indicator).to.equal('unread');
  });

  it('shows each session’s status: permission, error, running', async () => {
    const sessions = [session('w', { status: 'working' }), session('e', { status: 'error' }), session('p')];
    const { root } = await render({ sessions, waiting: ['p'] });
    /** @param {string} title */
    const indicator = (title) =>
      /** @type {HTMLElementTagNameMap['acp-session-status']} */ (row(root, title).querySelector('acp-session-status'))
        .indicator;
    expect([indicator('Session w'), indicator('Session e'), indicator('Session p')]).to.deep.equal([
      'running',
      'error',
      'permission',
    ]);
  });

  it('asks to select a session, a project, and to toggle or start one in it', async () => {
    const { el, root } = await render();
    const selects = record(el, 'acp-session-select');
    const projects = record(el, 'acp-project-select');
    const toggles = record(el, 'acp-project-toggle');
    const news = record(el, 'acp-project-new-session');
    row(root, 'Session a').click();
    const project = /** @type {HTMLElement} */ (root.querySelector('.acp-session-list__project'));
    project.click();
    project.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    /** @type {HTMLElement} */ (root.querySelector('.acp-session-list__add')).click();
    expect(selects.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a' }]);
    expect(projects.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
    expect(toggles.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama', expanded: false }]);
    expect(news.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
  });

  it('asks to open a folder from its top bar', async () => {
    const { el, root } = await render();
    const events = record(el, 'acp-project-open-folder');
    /** @type {HTMLElement} */ (root.querySelector('.acp-session-list__open-folder')).click();
    expect(events).to.have.length(1);
  });

  it('says why a project couldn’t open, and that one has no sessions yet', async () => {
    const { root } = await render({ sessions: [], failures: { '/home/me/rich': 'gone' } });
    expect(root.querySelector('.acp-session-list__error')?.textContent).to.contain('gone');
    expect(root.querySelectorAll('.acp-session-list__empty')).to.have.length(2);
  });

  describe('session menu', () => {
    it('swaps the status for a menu button while the row is hovered or focused', async () => {
      const { el, root } = await render({ unread: ['a'] });
      const target = row(root, 'Session a');
      expect(target.querySelector('.acp-session-list__more')).to.equal(null);
      target.dispatchEvent(new PointerEvent('pointerenter'));
      await el.updateComplete;
      expect(target.querySelector('.acp-session-list__more')).to.not.equal(null);
      expect(target.querySelector('acp-session-status')).to.equal(null);
      target.dispatchEvent(new PointerEvent('pointerleave'));
      await el.updateComplete;
      expect(target.querySelector('.acp-session-list__more')).to.equal(null);
      target.dispatchEvent(new FocusEvent('focusin'));
      await el.updateComplete;
      expect(target.querySelector('.acp-session-list__more')).to.not.equal(null);
    });

    it('opens the shared menu under the row’s button, for that session, without selecting it', async () => {
      const { el, root } = await render();
      const selects = record(el, 'acp-session-select');
      const target = row(root, 'Session a');
      target.dispatchEvent(new PointerEvent('pointerenter'));
      await el.updateComplete;
      const more = /** @type {HTMLElement} */ (target.querySelector('.acp-session-list__more'));
      more.click();
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await el.updateComplete;
      const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (menuEl.menu);
      expect([menu.open, menu.anchorElement]).to.deep.equal([true, more]);
      expect(menuEl.sessionTitle).to.equal('Session a');
      expect(selects).to.have.length(0);

      const reveals = record(el, 'acp-session-reveal');
      menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'reveal' }, bubbles: true, composed: true }));
      expect(reveals.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a' }]);
    });

    it('offers Reset to agent title for a session the user renamed after the agent named it', async () => {
      const sessions = [session('u', { titleSource: 'user', agentTitle: 'Agent’s' }), session('p')];
      const { el, root } = await render({ sessions });
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      const resets = record(el, 'acp-session-reset-title');
      for (const title of ['Session u', 'Session p']) {
        row(root, title).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await el.updateComplete;
        expect(menuEl.resettable, title).to.equal(title === 'Session u');
      }
      row(root, 'Session u').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'reset-title' }, bubbles: true, composed: true }));
      expect(resets.map((e) => e.detail)).to.deep.equal([{ sessionId: 'u' }]);
    });

    it('opens at the pointer on a right-click', async () => {
      const { el, root } = await render();
      row(root, 'Session b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await el.updateComplete;
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      expect(menuEl.menu?.open).to.equal(true);
      expect(menuEl.sessionTitle).to.equal('Session b');
    });
  });

  describe('rename', () => {
    /**
     * @param {AcpSessionList} el
     * @param {HTMLElement} target
     */
    async function field(el, target) {
      await el.updateComplete;
      return /** @type {HTMLElementTagNameMap['md-text-field']} */ (target.querySelector('.acp-session-list__rename'));
    }

    it('edits the title in place on F2 or a double-click, and saves on Enter', async () => {
      const { el, root } = await render();
      const renames = record(el, 'acp-session-rename');
      const target = row(root, 'Session a');
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
      const input = await field(el, target);
      expect(input.value).to.equal('Session a');
      input.value = 'Gaps';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await el.updateComplete;
      expect(renames.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a', title: 'Gaps' }]);
      expect(target.querySelector('.acp-session-list__rename')).to.equal(null);

      target.dispatchEvent(new MouseEvent('dblclick'));
      expect(await field(el, target)).to.not.equal(null);
    });

    it('keeps the title on Escape or when left empty', async () => {
      const { el, root } = await render();
      const renames = record(el, 'acp-session-rename');
      const target = row(root, 'Session a');
      for (const [value, key] of [
        ['Other', 'Escape'],
        ['  ', 'Enter'],
      ]) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
        const input = await field(el, target);
        input.value = value;
        input.dispatchEvent(new KeyboardEvent('keydown', { key }));
        await el.updateComplete;
      }
      expect(renames).to.have.length(0);
    });
  });

  it('asks to reveal or remove a project from its context menu', async () => {
    const { el, root } = await render();
    const reveals = record(el, 'acp-project-reveal');
    const removes = record(el, 'acp-project-remove');
    const project = /** @type {HTMLElement} */ (root.querySelector('.acp-session-list__project'));
    project.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 }));
    await el.updateComplete;
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-session-list__project-menu'));
    for (const value of ['reveal', 'remove']) {
      const item = /** @type {HTMLElement} */ (menu.querySelector(`md-menu-item[value="${value}"]`));
      menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
    }
    expect(reveals.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
    expect(removes.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
  });
});
