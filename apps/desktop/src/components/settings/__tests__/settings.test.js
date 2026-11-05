import { settings as settingsHook } from '../../../hooks/settings/settings.js';
import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../settings.js';

/** @typedef {import('../settings.js').AcpSettings} AcpSettings */

/**
 * A short tab, so the sections scroll.
 * @param {number} [height]
 */
async function render(height = 320) {
  const el = /** @type {AcpSettings} */ (
    await fixture(
      html`<acp-settings style="height: ${height}px" .settings=${settingsHook.defaults} .fonts=${[]}></acp-settings>`,
    )
  );
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/** @param {ShadowRoot} root */
function current(root) {
  return root.querySelector('.acp-settings__nav-item[aria-current="true"]')?.textContent?.trim();
}

/**
 * The scroller, scrolling at once: a background test page gets no frames, which smooth scrolling and
 * `scroll` events wait for. `scroll` is fired after each scroll instead.
 * @param {ShadowRoot} root
 */
function scrollerOf(root) {
  const scroller = /** @type {HTMLElement} */ (root.querySelector('.acp-settings__scroller'));
  const original = /** @type {(options: ScrollToOptions) => void} */ (scroller.scrollTo.bind(scroller));
  /** @param {ScrollToOptions} options */
  const scrollTo = (options) => {
    original({ ...options, behavior: 'instant' });
    scroller.dispatchEvent(new Event('scroll'));
  };
  scroller.scrollTo = /** @type {HTMLElement['scrollTo']} */ (scrollTo);
  return scroller;
}

/** @param {AcpSettings} el */
const rendered = (el) => el.updateComplete;

describe('acp-settings', () => {
  it('names the bundled font the editor uses by default', async () => {
    const { root } = await render();
    const option = /** @type {HTMLElement} */ (root.querySelector('.acp-settings__input_font md-option[value=""]'));
    expect(option.textContent?.trim()).to.equal('Google Sans Code (default)');
  });

  it('lists its sections and follows the scroll', async () => {
    const { el, root } = await render();
    const items = [...root.querySelectorAll('.acp-settings__nav-item')];
    expect(items.map((i) => i.textContent?.trim())).to.deep.equal(['Theme', 'Editor', 'Terminal', 'Agents']);
    expect(current(root)).to.equal('Theme');

    const scroller = scrollerOf(root);
    /** @type {HTMLElement} */ (items[1]).click();
    await rendered(el);
    expect(scroller.scrollTop).to.be.greaterThan(0);
    expect(current(root)).to.equal('Editor');

    scroller.scrollTo({ top: 0 });
    await rendered(el);
    expect(current(root)).to.equal('Theme');
  });

  it('marks the section picked even when the end of the scroll stops short of it, until scrolled away', async () => {
    // Arrange
    const { el, root } = await render(600);
    const scroller = scrollerOf(root);
    const item = (/** @type {string} */ label) => /** @type {HTMLElement} */ ([...root.querySelectorAll('.acp-settings__nav-item')].find((i) => i.textContent?.trim() === label));
    // Act
    item('Terminal').click();
    await rendered(el);
    // Assert
    expect(scroller.scrollTop + scroller.clientHeight, 'at the end').to.be.greaterThan(scroller.scrollHeight - 2);
    expect(current(root)).to.equal('Terminal');
    // Act
    item('Agents').click();
    await rendered(el);
    // Assert
    expect(current(root), 'no scroll is left to report it').to.equal('Agents');
    // Act
    item('Terminal').click();
    scroller.scrollTo({ top: 0 });
    scroller.scrollTo({ top: scroller.scrollHeight });
    await rendered(el);
    // Assert
    expect(current(root), 'scrolled there by hand').to.equal('Agents');
  });

  it('explains its controls in tooltips, not titles', async () => {
    const { root } = await render();
    const items = [...root.querySelectorAll('.acp-settings__nav-item')];
    expect(items.map(tooltipOf)).to.deep.equal(['Theme', 'Editor', 'Terminal', 'Agents']);
    expect(tooltipOf(root.querySelector('.acp-settings__icon-button'))).to.equal('Pick a color');
    expect(tooltipOf(root.querySelector('.acp-settings__link'))).to.equal('Not available yet');
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it('scrolls to a section when asked, then says so', async () => {
    const { el, root } = await render();
    const scroller = scrollerOf(root);
    /** @type {unknown[]} */
    const revealed = [];
    el.addEventListener('acp-settings-revealed', (e) => revealed.push(/** @type {CustomEvent} */ (e).detail.reveal));
    const reveal = { section: /** @type {const} */ ('editor') };
    el.reveal = reveal;
    await el.updateComplete;
    expect(revealed).to.deep.equal([reveal]);
    await rendered(el);
    expect(scroller.scrollTop).to.be.greaterThan(0);
    expect(current(root)).to.equal('Editor');
  });

  it('links to the Agents tab from its Agents section, with nothing there to reset', async () => {
    // Arrange
    const { el, root } = await render();
    const section = /** @type {HTMLElement} */ (root.querySelector('[data-section="agents"]'));
    const buttons = [...section.querySelectorAll('md-button')];
    let asked = 0;
    el.addEventListener('acp-agents-manage', () => asked++);
    // Act
    /** @type {HTMLElement} */ (buttons[0]).click();
    // Assert
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Edit ACP agents']);
    expect(asked).to.equal(1);
  });

  describe('the project accent', () => {
    /** @param {import('../../../hooks/settings/types.js').ProjectAccent | null} projectAccent */
    async function renderProject(projectAccent) {
      const el = /** @type {AcpSettings} */ (
        await fixture(html`<acp-settings .settings=${settingsHook.defaults} .fonts=${[]} .projectName=${'Batrak'} .projectAccent=${projectAccent}></acp-settings>`)
      );
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      /** @type {(string | boolean)[]} */
      const asked = [];
      el.addEventListener('acp-settings-project-accent', (e) => asked.push(/** @type {CustomEvent<{ accent: string }>} */ (e).detail.accent));
      el.addEventListener('acp-settings-project-accent-enabled', (e) => asked.push(/** @type {CustomEvent<{ enabled: boolean }>} */ (e).detail.enabled));
      const toggle = () => /** @type {HTMLElementTagNameMap['md-switch']} */ (root.querySelector('.acp-settings__switch_project-accent'));
      const field = () => /** @type {HTMLElementTagNameMap['md-text-field'] | null} */ (root.querySelector('md-text-field[label="Project accent color"]'));
      return { el, root, asked, toggle, field };
    }

    it('is offered only with a project open', async () => {
      // Arrange + Act
      const { root } = await render();
      // Assert
      expect(root.querySelector('md-text-field[label="Project accent color"]')).to.equal(null);
      expect(root.textContent).not.to.include('Own accent color');
    });

    it('asks to switch on and off, showing the color field only while on', async () => {
      // Arrange
      const { el, asked, toggle, field } = await renderProject({ color: '#AA00BB', enabled: false });
      expect(field(), 'off').to.equal(null);
      // Act
      toggle().click();
      await rendered(el);
      // Assert
      expect(asked).to.deep.equal([true]);
      // Act
      el.projectAccent = { color: '#AA00BB', enabled: true };
      await rendered(el);
      // Assert
      expect(field()?.value).to.equal('#AA00BB');
      // Act
      toggle().click();
      // Assert
      expect(asked).to.deep.equal([true, false]);
    });

    it('asks for a color typed, and flags one that is not, leaving the global field alone', async () => {
      // Arrange
      const { el, asked, field, root } = await renderProject({ color: '#AA00BB', enabled: true });
      const input = /** @type {HTMLElementTagNameMap['md-text-field']} */ (field());
      // Act
      input.value = 'nope';
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      await rendered(el);
      // Assert
      expect(asked).to.deep.equal(['nope']);
      expect(input.hasAttribute('error')).to.equal(true);
      expect(/** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector('md-text-field[label="Accent color"]')).hasAttribute('error')).to.equal(false);
    });

    it('disables the global accent while the project has its own', async () => {
      // Arrange
      const { el, root } = await renderProject({ color: '#AA00BB', enabled: true });
      const field = /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector('md-text-field[label="Accent color"]'));
      const swatch = /** @type {HTMLInputElement} */ (field.querySelector('.acp-settings__swatch'));
      const pick = /** @type {HTMLElementTagNameMap['md-icon-button']} */ (field.querySelector('.acp-settings__icon-button'));
      // Assert
      expect([field.disabled, swatch.disabled, pick.disabled]).to.deep.equal([true, true, true]);
      // Act
      el.projectAccent = { color: '#AA00BB', enabled: false };
      await rendered(el);
      // Assert
      expect([field.disabled, swatch.disabled, pick.disabled]).to.deep.equal([false, false, false]);
    });

    it('lets the Theme section reset while it is set', async () => {
      // Arrange
      const { el, root } = await renderProject(null);
      const reset = () => /** @type {HTMLElementTagNameMap['md-button']} */ (root.querySelector('[data-section="theme"] .acp-settings__header-button'));
      expect(reset().disabled, 'all default').to.equal(true);
      // Act
      el.projectAccent = { color: '#AA00BB', enabled: false };
      await rendered(el);
      // Assert
      expect(reset().disabled, 'a color is kept').to.equal(false);
    });
  });

  describe('markdown', () => {
    /** @param {ShadowRoot} root */
    const toggle = (root) => /** @type {HTMLElementTagNameMap['md-switch']} */ (root.querySelector('.acp-settings__switch_markdown-sync'));

    /** @param {AcpSettings} el */
    function changes(el) {
      /** @type {unknown[]} */
      const patches = [];
      el.addEventListener('acp-settings-change', (e) => patches.push(/** @type {CustomEvent} */ (e).detail.patch));
      return patches;
    }

    it('shows whether the editor and preview scroll together, and asks to flip it', async () => {
      const { el, root } = await render();
      const patches = changes(el);
      expect(toggle(root).selected).to.equal(true);

      toggle(root).selected = false;
      toggle(root).dispatchEvent(new Event('change', { bubbles: true }));
      el.settings = { ...settingsHook.defaults, markdownScrollSync: false };
      await el.updateComplete;

      expect(patches).to.deep.equal([{ markdownScrollSync: false }]);
      expect(toggle(root).selected).to.equal(false);
    });

    it('is reset with the rest of the Editor section', async () => {
      const { el, root } = await render();
      el.settings = { ...settingsHook.defaults, markdownScrollSync: false };
      await el.updateComplete;
      /** @type {unknown[]} */
      const resets = [];
      el.addEventListener('acp-settings-reset', (e) => resets.push(/** @type {CustomEvent} */ (e).detail));

      /** @type {HTMLElement} */ (root.querySelector('[data-section="editor"] .acp-settings__header-button')).click();

      expect(resets).to.deep.equal([{ section: 'editor' }]);
    });
  });

  describe('the terminal section', () => {
    const section = (/** @type {ShadowRoot} */ root) => /** @type {HTMLElement} */ (root.querySelector('[data-section="terminal"]'));
    const sizeField = (/** @type {ShadowRoot} */ root) => /** @type {HTMLElementTagNameMap['md-text-field']} */ (section(root).querySelector('md-text-field'));

    /** @param {AcpSettings} el */
    function changes(el) {
      /** @type {unknown[]} */
      const patches = [];
      el.addEventListener('acp-settings-change', (e) => patches.push(/** @type {CustomEvent} */ (e).detail.patch));
      return patches;
    }

    it('offers only monospaced fonts, or the editor’s, and asks for what is picked', async () => {
      // Arrange
      const { el, root } = await render();
      el.fonts = [{ family: 'Fira Code', monospace: true }, { family: 'Arial', monospace: false }];
      await rendered(el);
      const patches = changes(el);
      const select = /** @type {HTMLElementTagNameMap['md-select']} */ (section(root).querySelector('md-select'));
      // Assert
      expect([...select.querySelectorAll('md-option')].map((o) => o.textContent?.trim())).to.deep.equal(['Same as the editor', 'Fira Code']);
      // Act
      select.value = 'Fira Code';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      // Assert
      expect(patches).to.deep.equal([{ terminalFont: 'Fira Code' }, { terminalFont: null }]);
    });

    it('takes a size typed, a size stepped from the editor’s, and goes back to the editor’s when emptied', async () => {
      // Arrange
      const { el, root } = await render();
      el.settings = { ...settingsHook.defaults, editorFontSize: 14 };
      await rendered(el);
      const patches = changes(el);
      const field = sizeField(root);
      const type = (/** @type {string} */ value) => {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      };
      // Assert
      expect(field.value, 'empty while it is the editor’s').to.equal('');
      expect(section(root).textContent, 'says whose').to.include('14 px');
      // Act
      /** @type {HTMLElement} */ (section(root).querySelector('[aria-label="Larger"]')).click();
      type('16');
      type('3');
      type('');
      // Assert
      expect(patches, 'a size out of bounds is not asked for').to.deep.equal([{ terminalFontSize: 15 }, { terminalFontSize: 16 }, { terminalFontSize: null }]);
    });

    it('offers no terminal colors for now', async () => {
      // Arrange + Act
      const { root } = await render();

      // Assert
      expect(section(root).querySelector('md-segmented-button-group') === null, 'no theme choice').to.equal(true);
      expect(section(root).textContent?.includes('Colors'), 'no label').to.equal(false);
    });

    // Back with `SHOW_TERMINAL_COLORS` in settings.js.
    it.skip('asks for custom colors, and offers them only then, each edit for both schemes', async () => {
      // Arrange
      const { el, root } = await render();
      const patches = changes(el);
      const colors = () => [...section(root).querySelectorAll('input[type="color"]')].map((i) => /** @type {HTMLInputElement} */ (i));
      expect(colors(), 'the app’s').to.deep.equal([]);
      // Act
      section(root).querySelector('md-segmented-button-group')?.dispatchEvent(new CustomEvent('change', { detail: { value: 'custom' }, bubbles: true }));
      const pair = { light: settingsHook.terminalPalette, dark: settingsHook.terminalPalette };
      el.settings = { ...settingsHook.defaults, terminalTheme: 'custom', terminalColors: pair };
      await rendered(el);
      const red = /** @type {HTMLInputElement} */ (section(root).querySelector('input[aria-label="Red"]'));
      expect(colors().length, 'background, foreground, cursor and 16 ANSI').to.equal(19);
      expect(red.value).to.equal(settingsHook.terminalPalette.red.toLowerCase());
      red.value = '#123456';
      red.dispatchEvent(new Event('input', { bubbles: true }));
      // Assert
      const edited = { ...settingsHook.terminalPalette, red: '#123456' };
      expect(patches).to.deep.equal([{ terminalTheme: 'custom' }, { terminalColors: { light: edited, dark: edited } }]);
    });

    it('offers ⌥ as Meta only on a Mac, and asks to flip it', async () => {
      // Arrange
      const { el, root } = await render();
      const patches = changes(el);
      const toggle = () => /** @type {HTMLElementTagNameMap['md-switch'] | null} */ (section(root).querySelector('md-switch'));
      el.platform = 'windows';
      await rendered(el);
      expect(toggle(), 'not on Windows').to.equal(null);
      el.platform = 'mac';
      await rendered(el);
      // Act
      const on = /** @type {HTMLElementTagNameMap['md-switch']} */ (toggle());
      on.selected = true;
      on.dispatchEvent(new Event('change', { bubbles: true }));
      // Assert
      expect(patches).to.deep.equal([{ terminalOptionMeta: true }]);
    });

    it('resets on its own, once something is set', async () => {
      // Arrange
      const { el, root } = await render();
      const reset = () => /** @type {HTMLElementTagNameMap['md-button']} */ (section(root).querySelector('.acp-settings__header-button'));
      /** @type {unknown[]} */
      const resets = [];
      el.addEventListener('acp-settings-reset', (e) => resets.push(/** @type {CustomEvent} */ (e).detail));
      expect(reset().disabled, 'nothing to reset').to.equal(true);
      el.settings = { ...settingsHook.defaults, terminalFontSize: 15 };
      await rendered(el);
      // Act
      reset().click();
      // Assert
      expect(resets).to.deep.equal([{ section: 'terminal' }]);
    });
  });
});
