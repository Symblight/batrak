import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../session-list.js';

/** @typedef {import('../session-list.js').AcpSessionList} AcpSessionList */
/** @typedef {import('../../../models/types/types.js').Session} Session */
/** @typedef {import('../../../models/types/types.js').Project} Project */

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
 * The session row element whose session has `title`.
 * @param {ShadowRoot} root
 * @param {string} title
 */
function row(root, title) {
  const found = [...root.querySelectorAll('acp-session-row')].find((r) => r.session?.title === title);
  if (!found) throw new Error(`no row for ${title}`);
  return found;
}

/** @param {ShadowRoot} root */
function titles(root) {
  return [...root.querySelectorAll('acp-session-row')].map((r) => r.session?.title);
}

/** @param {ShadowRoot} root */
const projectRows = (root) => [...root.querySelectorAll('acp-project-row')];

/** @param {AcpSessionList} el */
async function settle(el) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
}

describe('acp-session-list', () => {
  it('groups sessions under their project, pinned first, then the most recently active', async () => {
    const { root } = await render({ pinned: ['c'] });
    expect(projectRows(root).map((p) => [p.project?.name, p.path])).to.deep.equal([['brama', '~/brama'], ['rich', '~/rich']]);
    expect(titles(root)).to.deep.equal(['Session c', 'Session b', 'Session a', 'Session r']);
    expect(['c', 'b'].map((id) => row(root, `Session ${id}`).pinned)).to.deep.equal([true, false]);
    expect(tooltipOf(root.querySelector('.acp-session-list__open-folder'))).to.equal('Open folder…');
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
  });

  it('hands each row its state: selected, pinned, unread, waiting for a permission, the time', async () => {
    const now = Date.parse('2026-10-23T13:00:00.000Z');
    const { root } = await render({ pinned: ['a'], unread: ['b'], waiting: ['c'], activeSessionId: 'b', now });
    const state = (/** @type {string} */ id) => {
      const r = row(root, `Session ${id}`);
      return [r.selected, r.pinned, r.unread, r.waiting, r.now];
    };
    expect(state('a')).to.deep.equal([false, true, false, false, now]);
    expect(state('b')).to.deep.equal([true, false, true, false, now]);
    expect(state('c')).to.deep.equal([false, false, false, true, now]);
  });

  it('hides a collapsed project’s sessions and counts them', async () => {
    const { root } = await render({ collapsed: ['/home/me/brama'], activeProjectId: '/home/me/rich', openingProjectId: '/home/me/brama' });
    expect(titles(root)).to.deep.equal(['Session r']);
    const [brama, rich] = projectRows(root);
    expect([brama.expanded, brama.count, brama.loading, brama.active]).to.deep.equal([false, 3, true, false]);
    expect([rich.expanded, rich.count, rich.loading, rich.active]).to.deep.equal([true, 1, false, true]);
  });

  it('passes what its rows ask on: select, toggle, new session, and opens a folder', async () => {
    const { el, root } = await render();
    const selects = record(el, 'acp-session-select');
    const projects = record(el, 'acp-project-select');
    const news = record(el, 'acp-project-new-session');
    const folders = record(el, 'acp-project-open-folder');
    row(root, 'Session a').shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const project = /** @type {ShadowRoot} */ (projectRows(root)[0].shadowRoot);
    /** @type {HTMLElement} */ (project.querySelector('.acp-project-row__row')).click();
    /** @type {HTMLElement} */ (project.querySelector('.acp-project-row__add')).click();
    /** @type {HTMLElement} */ (root.querySelector('.acp-session-list__open-folder')).click();
    expect(selects.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a' }]);
    expect(projects.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
    expect(news.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
    expect(folders).to.have.length(1);
  });

  it('says why a project couldn’t open, and that one has no sessions yet', async () => {
    const { root } = await render({ sessions: [], failures: { '/home/me/rich': 'gone' } });
    expect(root.querySelector('.acp-session-list__error')?.textContent).to.contain('gone');
    expect(root.querySelectorAll('.acp-session-list__empty')).to.have.length(2);
  });

  describe('session menu', () => {
    it('opens the one shared menu under a row’s menu button for that session, marks the row, and passes its picks on', async () => {
      const { el, root } = await render();
      const selects = record(el, 'acp-session-select');
      const target = row(root, 'Session a');
      const inner = /** @type {ShadowRoot} */ (target.shadowRoot);
      inner.querySelector('.acp-session-row__row')?.dispatchEvent(new PointerEvent('pointerenter'));
      await target.updateComplete;
      const more = /** @type {HTMLElement} */ (inner.querySelector('.acp-session-row__more'));

      more.click();
      await settle(el);
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (menuEl.menu);
      expect([menu.open, menu.anchorElement]).to.deep.equal([true, more]);
      expect(menuEl.sessionTitle).to.equal('Session a');
      expect(target.menuOpen, 'the row keeps its button').to.equal(true);
      expect(selects).to.have.length(0);

      for (const [value, type] of [['reveal', 'acp-session-reveal'], ['open-terminal', 'acp-session-open-terminal'], ['delete', 'acp-session-delete']]) {
        const heard = record(el, type);
        menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value }, bubbles: true, composed: true }));
        expect(heard.map((e) => e.detail), value).to.deep.equal([{ sessionId: 'a' }]);
      }
    });

    it('opens at the pointer on a right-click, offering Reset to agent title for a session the user renamed after the agent named it', async () => {
      const sessions = [session('u', { titleSource: 'user', agentTitle: 'Agent’s' }), session('p')];
      const { el, root } = await render({ sessions });
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      const resets = record(el, 'acp-session-reset-title');
      /** @param {string} title */
      const rightClick = async (title) => {
        row(root, title).shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }));
        await settle(el);
      };
      for (const title of ['Session u', 'Session p']) {
        await rightClick(title);
        expect(menuEl.menu?.open, title).to.equal(true);
        expect(menuEl.sessionTitle).to.equal(title);
        expect(menuEl.resettable, title).to.equal(title === 'Session u');
      }
      await rightClick('Session u');
      menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'reset-title' }, bubbles: true, composed: true }));
      expect(resets.map((e) => e.detail)).to.deep.equal([{ sessionId: 'u' }]);
    });

    it('renames the row in place when the menu says Rename', async () => {
      const { el, root } = await render();
      const target = row(root, 'Session a');
      target.shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }));
      await settle(el);
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'rename' }, bubbles: true, composed: true }));
      await settle(el);
      expect(target.shadowRoot?.querySelector('.acp-session-row__rename'), 'its field').to.not.equal(null);
    });
  });

  it('asks to reveal or remove a project from its context menu', async () => {
    const { el, root } = await render();
    const reveals = record(el, 'acp-project-reveal');
    const removes = record(el, 'acp-project-remove');
    projectRows(root)[0].shadowRoot?.querySelector('.acp-project-row__row')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 1, clientY: 1 }),
    );
    await settle(el);
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-session-list__project-menu'));
    expect(projectRows(root)[0].menuOpen, 'the row stays marked').to.equal(true);
    for (const value of ['reveal', 'remove']) {
      const item = /** @type {HTMLElement} */ (menu.querySelector(`md-menu-item[value="${value}"]`));
      menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
    }
    expect(reveals.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
    expect(removes.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
  });

  it("shows the active project's sync beside the heading", async () => {
    /** @type {import('../../../models/types/types.js').SessionSync} */
    const sync = { running: true, report: null };
    const { root } = await render({ sync });
    const indicator = /** @type {import('../../session-sync/session-sync.js').AcpSessionSync | null} */ (
      root.querySelector('.acp-session-list__top acp-session-sync')
    );
    expect(indicator?.sync).to.equal(sync);
  });

  it("shows a project's five newest sessions, five more with each Show more", async () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(`s${i}`, { lastActivityAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const { root } = await render({ sessions });
    expect(titles(root)).to.deep.equal(['Session s11', 'Session s10', 'Session s9', 'Session s8', 'Session s7']);
    const more = () => /** @type {HTMLElement | null} */ (root.querySelector('.acp-session-list__show-more'));
    expect(more()?.textContent?.trim()).to.equal('Show more…');
    more()?.click();
    await /** @type {AcpSessionList} */ (/** @type {ShadowRoot} */ (root).host).updateComplete;
    expect(titles(root)).to.have.length(10);
    more()?.click();
    await /** @type {AcpSessionList} */ (/** @type {ShadowRoot} */ (root).host).updateComplete;
    expect(titles(root)).to.have.length(12);
    expect(more(), 'all shown').to.equal(null);
  });

  it('shows skeleton rows for a loading project with no sessions to show yet', async () => {
    const { root } = await render({ sessions: [SESSIONS[3]], loading: ['/home/me/brama', '/home/me/rich'] });
    const loading = root.querySelector('.acp-session-list__loading');
    expect(loading?.getAttribute('aria-label')).to.equal('Loading sessions');
    expect(loading?.querySelectorAll('.acp-session-list__skeleton-row md-skeleton').length).to.equal(6);
    expect(loading?.querySelectorAll('.acp-session-list__skeleton-row').length, 'three rows').to.equal(3);
    expect(root.querySelector('.acp-session-list__empty'), 'not "No sessions yet"').to.equal(null);
    expect(titles(root), 'a project with sessions shows them').to.deep.equal(['Session r']);
    expect(root.querySelectorAll('.acp-session-list__loading').length).to.equal(1);
  });
});

