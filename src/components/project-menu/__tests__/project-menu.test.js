import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import { shortcuts } from '../../../hooks/shortcuts/shortcuts.js';
import '../project-menu.js';

/** @typedef {import('../project-menu.js').AcpProjectMenu} AcpProjectMenu */
/** @typedef {HTMLElementTagNameMap['md-menu']} MdMenu */

const PROJECTS = [
  { id: '/Users/me/Projects/ACP-code-editor', name: 'ACP-code-editor', path: '/Users/me/Projects/ACP-code-editor' },
  { id: '/Users/me/Projects/Test', name: 'Test', path: '/Users/me/Projects/Test' },
  { id: '/opt/work/wc-material', name: 'wc-material', path: '/opt/work/wc-material' },
];

/**
 * @param {Partial<AcpProjectMenu>} [props]
 * @returns {Promise<{ el: AcpProjectMenu, root: ShadowRoot, menu: MdMenu }>}
 */
async function render(props = {}) {
  const el = /** @type {AcpProjectMenu} */ (await fixture(html`<acp-project-menu></acp-project-menu>`));
  Object.assign(el, { projects: PROJECTS, home: '/Users/me', ...props });
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return { el, root, menu: /** @type {MdMenu} */ (root.querySelector('md-menu')) };
}

/**
 * What a click on a menu item fires.
 * @param {ShadowRoot} root
 * @param {MdMenu} menu
 * @param {string} value
 */
function pick(root, menu, value) {
  const item = /** @type {HTMLElement} */ (root.querySelector(`md-menu-item[value="${CSS.escape(value)}"]`));
  menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
}

describe('acp-project-menu', () => {
  it('names the shown project on its button, or invites to open one', async () => {
    // Arrange
    const { el, root } = await render({ currentId: PROJECTS[0].id });
    const button = /** @type {HTMLElement} */ (root.querySelector('.acp-project-menu__button'));

    // Assert: the shown project
    expect(button.textContent).to.contain('ACP-code-editor');
    expect(button.querySelector('.acp-project-menu__tile')?.textContent?.trim()).to.equal('A');
    expect(tooltipOf(button)).to.equal('Project · ~/Projects/ACP-code-editor');
    expect(button.getAttribute('aria-haspopup')).to.equal('menu');

    // Act + Assert: none shown
    el.currentId = null;
    await el.updateComplete;
    expect(button.textContent).to.contain('Open project');
    expect(button.querySelector('.acp-project-menu__tile')).to.equal(null);
  });

  it('lists every project with its folder, marks the shown one and dots the ones with unread sessions', async () => {
    // Arrange
    const { root } = await render({ currentId: PROJECTS[0].id, unread: { [PROJECTS[1].id]: 2 } });

    // Act
    const rows = [...root.querySelectorAll('md-menu-item[data-project]')];

    // Assert
    expect(rows.map((r) => r.getAttribute('data-project'))).to.deep.equal(PROJECTS.map((p) => p.id));
    expect(rows.map((r) => r.querySelector('.acp-project-menu__path')?.textContent?.trim())).to.deep.equal([
      '~/Projects',
      '~/Projects',
      '/opt/work',
    ]);
    expect(rows.some((r) => r.querySelector('[slot="supporting-text"]')), 'name and folder share one line').to.equal(false);
    expect(rows.map((r) => r.hasAttribute('selected'))).to.deep.equal([true, false, false]);
    const dots = rows.map((r) => r.querySelector('.acp-project-menu__dot'));
    expect(dots.map((d) => d !== null)).to.deep.equal([false, true, false]);
    expect(tooltipOf(/** @type {Element} */ (dots[1]))).to.equal('2 unread sessions');
  });

  it('reports each pick as its event, and nothing for the shown project', async () => {
    // Arrange
    const { el, root, menu } = await render({ currentId: PROJECTS[0].id });
    /** @type {{ type: string, detail: unknown }[]} */
    const events = [];
    const types = ['select', 'open-folder', 'reveal', 'open-terminal', 'remove'].map((t) => `acp-project-${t}`);
    for (const type of types) {
      el.addEventListener(type, (e) => events.push({ type, detail: /** @type {CustomEvent} */ (e).detail }));
    }

    // Act
    for (const value of [PROJECTS[1].id, PROJECTS[0].id, 'open-folder', 'reveal', 'open-terminal', 'remove']) {
      pick(root, menu, value);
    }

    // Assert
    expect(events).to.deep.equal([
      { type: 'acp-project-select', detail: { projectId: PROJECTS[1].id } },
      { type: 'acp-project-open-folder', detail: null },
      { type: 'acp-project-reveal', detail: { projectId: PROJECTS[0].id } },
      { type: 'acp-project-open-terminal', detail: null },
      { type: 'acp-project-remove', detail: { projectId: PROJECTS[0].id } },
    ]);
  });

  it('offers the shown project’s actions only while one is shown, and no group label with no projects', async () => {
    // Arrange
    const { el, root } = await render({ currentId: PROJECTS[0].id });
    const actions = () => [...root.querySelectorAll('md-menu-item:not([data-project])')].map((i) => i.getAttribute('value'));
    expect(actions()).to.deep.equal(['open-folder', 'reveal', 'open-terminal', 'remove']);
    const hint = root.querySelector('md-menu-item[value="open-folder"] [slot="trailing"]');
    expect(hint?.textContent?.trim(), 'Add project shows its shortcut').to.equal(shortcuts.hint('openFolder'));

    // Act
    el.currentId = null;
    el.projects = [];
    await el.updateComplete;

    // Assert
    expect(actions()).to.deep.equal(['open-folder']);
    expect(root.querySelector('md-menu-group[label="Projects"]')).to.equal(null);
  });

  it('opens and closes from its button', async () => {
    // Arrange
    const { el, root, menu } = await render({ currentId: PROJECTS[0].id });
    const button = /** @type {HTMLElement} */ (root.querySelector('.acp-project-menu__button'));

    // Act + Assert
    button.click();
    await menu.updateComplete;
    expect(menu.open).to.equal(true);
    menu.dispatchEvent(new Event('opening'));
    await el.updateComplete;
    expect(button.getAttribute('aria-expanded')).to.equal('true');
    button.click();
    expect(menu.open).to.equal(false);
    menu.dispatchEvent(new Event('closing'));
    await el.updateComplete;
    expect(button.getAttribute('aria-expanded')).to.equal('false');
  });
});
