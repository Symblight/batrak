import { app } from '../../hooks/app/app.js';
import { settings as settingsHook } from '../../hooks/settings/settings.js';
import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/segmented-button';
import '@symblight/wc-material/select';
import '@symblight/wc-material/switch';
import '@symblight/wc-material/text-field';
import '@symblight/wc-material/tooltip';
import lightModeIcon from '@material-design-icons/svg/outlined/light_mode.svg?raw';
import darkModeIcon from '@material-design-icons/svg/outlined/dark_mode.svg?raw';
import systemModeIcon from '@material-design-icons/svg/outlined/settings_brightness.svg?raw';
import colorizeIcon from '@material-design-icons/svg/outlined/colorize.svg?raw';
import removeIcon from '@material-design-icons/svg/outlined/remove.svg?raw';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import dataObjectIcon from '@material-design-icons/svg/outlined/data_object.svg?raw';
import paletteIcon from '@material-design-icons/svg/outlined/palette.svg?raw';
import codeIcon from '@material-design-icons/svg/outlined/code.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import styles from './settings.css?inline';

/** @typedef {import('../../hooks/settings/types.js').Appearance} Appearance */
/** @typedef {import('../../hooks/settings/types.js').FontFamily} FontFamily */
/** @typedef {import('../../hooks/settings/types.js').Settings} Settings */
/** @typedef {import('../../stores/settings/rules.js').SettingsSection} SettingsSection */
/** @typedef {import('../../hooks/settings/types.js').SettingsAnchor} SettingsAnchor */
/** @typedef {import('../../hooks/settings/types.js').SettingsReveal} SettingsReveal */

/** @typedef {'editorFontSize' | 'terminalFontSize'} FontSizeField */

/** @type {{ id: SettingsAnchor, label: string, icon: string }[]} The sections, top to bottom. */
const SECTIONS = [
  { id: 'theme', label: 'Theme', icon: paletteIcon },
  { id: 'editor', label: 'Editor', icon: codeIcon },
  { id: 'terminal', label: 'Terminal', icon: terminalIcon },
];

/** @type {{ key: import('../../hooks/settings/types.js').TerminalColorKey, label: string }[]} */
const TERMINAL_COLORS = [
  { key: 'background', label: 'Background' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'black', label: 'Black' },
  { key: 'red', label: 'Red' },
  { key: 'green', label: 'Green' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'blue', label: 'Blue' },
  { key: 'magenta', label: 'Magenta' },
  { key: 'cyan', label: 'Cyan' },
  { key: 'white', label: 'White' },
  { key: 'brightBlack', label: 'Bright black' },
  { key: 'brightRed', label: 'Bright red' },
  { key: 'brightGreen', label: 'Bright green' },
  { key: 'brightYellow', label: 'Bright yellow' },
  { key: 'brightBlue', label: 'Bright blue' },
  { key: 'brightMagenta', label: 'Bright magenta' },
  { key: 'brightCyan', label: 'Bright cyan' },
  { key: 'brightWhite', label: 'Bright white' },
];

/** How far below the scroller's top a section counts as the one being read. */
const SPY_OFFSET = 24;

/** @type {{ value: Appearance, label: string, icon: string }[]} */
const APPEARANCES = [
  { value: 'light', label: 'Light', icon: lightModeIcon },
  { value: 'dark', label: 'Dark', icon: darkModeIcon },
  { value: 'system', label: 'System', icon: systemModeIcon },
];

/**
 * @tag acp-settings
 * @summary App settings, shown as a tab in the main column: one card of sections (Theme, Editor, Terminal) and a list that scrolls to them.
 * @fires acp-settings-change `{ patch }` A `Partial<Settings>`; the accent as typed, the font size unclamped.
 * @fires acp-settings-project-accent `{ accent }` For the project shown: the color as typed.
 * @fires acp-settings-project-accent-enabled `{ enabled }` For the project shown.
 * @fires acp-settings-reset `{ section }`
 * @fires acp-settings-revealed `{ reveal }` The `reveal` asked for was shown.
 */
export class AcpSettings extends LitElement {
  static properties = {
    settings: { attribute: false },
    projectName: { attribute: false },
    projectAccent: { attribute: false },
    fonts: { attribute: false },
    reveal: { attribute: false },
    platform: { attribute: false },
    current: { state: true },
    accentDraft: { state: true },
    projectAccentDraft: { state: true },
    fontSizeDrafts: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Settings | null} */
    this.settings = null;
    /** @type {string | null} The project shown; `null` offers no accent of its own. */
    this.projectName = null;
    /** @type {import('../../hooks/settings/types.js').ProjectAccent | null} Its own accent; `null` when it never had one. */
    this.projectAccent = null;
    /** @type {FontFamily[] | null} Installed fonts, sorted; `null` until listed. */
    this.fonts = null;
    /** @type {SettingsReveal | null} A section to scroll to; `acp-settings-revealed` once it has. */
    this.reveal = null;
    /** @type {import('../../hooks/app/types.js').Platform} */
    this.platform = app.platform;
    /** @type {SettingsAnchor} The section being read, marked in the list. */
    this.current = 'theme';
    /** @type {string | null} Accent HEX being typed; `null` shows the stored one. */
    this.accentDraft = null;
    /** @type {string | null} The project's accent HEX being typed; `null` shows the stored one. */
    this.projectAccentDraft = null;
    /** @type {Partial<Record<FontSizeField, string>>} Font sizes being typed; none shows the stored one. */
    this.fontSizeDrafts = {};
  }

  /** @param {Partial<Settings>} patch */
  #change(patch) {
    this.dispatchEvent(new CustomEvent('acp-settings-change', { detail: { patch }, bubbles: true, composed: true }));
  }

  /** Whether the font menu's height is set; the select renders once `settings` arrive. */
  #menuSized = false;

  /** @param {import('lit').PropertyValues<this>} changed */
  async updated(changed) {
    if ((changed.has('reveal') || changed.has('settings')) && this.reveal && this.settings) this.#reveal(this.reveal);
    const selects = [...this.renderRoot.querySelectorAll('md-select')];
    if (!selects.length || this.#menuSized) return;
    this.#menuSized = true;
    await Promise.all(selects.map((select) => select.updateComplete));
    // md-menu sets its size on its own :host inside md-select's shadow root, with no part to reach it by;
    // an inline style beats that. The value stays in acp-settings.css.
    for (const select of selects) select.menuEl?.style.setProperty('--md-menu-max-height', 'var(--_acp-settings-menu-max-height)');
  }

  get #scroller() {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-settings__scroller'));
  }

  /**
   * Scrolls the card so a section starts at the top.
   * @param {SettingsAnchor} id
   * @param {ScrollBehavior} behavior
   */
  #scrollTo(id, behavior) {
    const scroller = this.#scroller;
    const section = this.renderRoot.querySelector(`[data-section="${id}"]`);
    if (!scroller || !section) return;
    const top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: top - parseFloat(getComputedStyle(scroller).paddingTop), behavior: reduced ? 'instant' : behavior });
  }

  /** @param {SettingsReveal} reveal */
  #reveal(reveal) {
    this.#scrollTo(reveal.section, 'instant');
    this.dispatchEvent(new CustomEvent('acp-settings-revealed', { detail: { reveal }, bubbles: true, composed: true }));
  }

  /** Marks the section being read: the last one whose top has passed the scroller's, or the last at the end. */
  #onScroll = () => {
    const scroller = /** @type {HTMLElement} */ (this.#scroller);
    const top = scroller.getBoundingClientRect().top + SPY_OFFSET;
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    let current = SECTIONS[0].id;
    for (const { id } of SECTIONS) {
      const section = this.renderRoot.querySelector(`[data-section="${id}"]`);
      if (atEnd || (section && section.getBoundingClientRect().top <= top)) current = id;
    }
    this.current = current;
  };

  /** Opens the system color panel of the swatch beside the button, a native color input. */
  #openColorPicker = (/** @type {Event} */ e) => {
    /** @type {HTMLInputElement} */ (/** @type {Element} */ (e.currentTarget).parentElement?.querySelector('.acp-settings__swatch')).click();
  };

  #onAppearanceChange = (/** @type {Event} */ e) => {
    this.#change({ appearance: /** @type {CustomEvent<{ value: Appearance }>} */ (e).detail.value });
  };

  #onColorPicked = (/** @type {Event} */ e) => {
    // Inside the text field, whose own `input` handler would take it for typed text.
    e.stopPropagation();
    this.accentDraft = null;
    this.#change({ accent: /** @type {HTMLInputElement} */ (e.target).value });
  };

  #onAccentInput = (/** @type {Event} */ e) => {
    const value = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value;
    this.accentDraft = value;
    this.#change({ accent: value });
  };

  /** @param {string} accent */
  #changeProjectAccent(accent) {
    this.dispatchEvent(new CustomEvent('acp-settings-project-accent', { detail: { accent }, bubbles: true, composed: true }));
  }

  #onProjectColorPicked = (/** @type {Event} */ e) => {
    e.stopPropagation();
    this.projectAccentDraft = null;
    this.#changeProjectAccent(/** @type {HTMLInputElement} */ (e.target).value);
  };

  #onProjectAccentInput = (/** @type {Event} */ e) => {
    const value = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value;
    this.projectAccentDraft = value;
    this.#changeProjectAccent(value);
  };

  #onProjectAccentToggle = (/** @type {Event} */ e) => {
    this.projectAccentDraft = null;
    const { selected: enabled } = /** @type {HTMLElementTagNameMap['md-switch']} */ (e.target);
    this.dispatchEvent(new CustomEvent('acp-settings-project-accent-enabled', { detail: { enabled }, bubbles: true, composed: true }));
  };

  #onMarkdownSyncChange = (/** @type {Event} */ e) => {
    this.#change({ markdownScrollSync: /** @type {HTMLElementTagNameMap['md-switch']} */ (e.target).selected });
  };

  /**
   * @param {FontSizeField} field
   * @param {string} value As typed: a size within bounds is asked for; the terminal's emptied goes back to the editor's.
   */
  #typeFontSize(field, value) {
    this.fontSizeDrafts = { ...this.fontSizeDrafts, [field]: value };
    const typed = value.trim();
    const size = Number(typed);
    if (typed === '' && field === 'terminalFontSize') this.#change({ terminalFontSize: null });
    else if (/^\d+$/.test(typed) && size >= settingsHook.fontSizeMin && size <= settingsHook.fontSizeMax) this.#change({ [field]: size });
  }

  /**
   * @param {FontSizeField} field
   * @param {number} from The size now.
   * @param {number} delta
   */
  #stepFontSize(field, from, delta) {
    this.fontSizeDrafts = {};
    this.#change({ [field]: from + delta });
  }

  /** Drops what was typed, showing the stored value again (the last valid one). */
  #revertDrafts = () => {
    this.accentDraft = null;
    this.projectAccentDraft = null;
    this.fontSizeDrafts = {};
  };

  /**
   * @param {string} title
   * @param {SettingsSection} section
   * @param {Settings} settings
   */
  #renderGroupHeader(title, section, settings) {
    return html`<div class="acp-settings__group-header">
      <h3 class="acp-settings__group-title">${title}</h3>
      <md-button
        class="acp-settings__header-button"
        variant="text"
        ?disabled=${settingsHook.isSectionDefault(settings, section) && !(section === 'theme' && this.projectAccent)}
        @click=${() => {
          this.#revertDrafts();
          this.dispatchEvent(new CustomEvent('acp-settings-reset', { detail: { section }, bubbles: true, composed: true }));
        }}
        >Reset</md-button
      >
    </div>`;
  }

  /**
   * @param {Object} field
   * @param {string} field.id The pick button's, unique in the shadow root.
   * @param {string} field.label
   * @param {string} field.value The stored color.
   * @param {string | null} field.draft What is being typed.
   * @param {(e: Event) => void} field.onInput
   * @param {(e: Event) => void} field.onPicked
   * @param {boolean} [field.disabled]
   */
  #renderAccentInput({ id, label, value, draft, onInput, onPicked, disabled = false }) {
    return html`<md-text-field
        class="acp-settings__input"
        variant="outlined"
        label=${label}
        spellcheck="false"
        ?disabled=${disabled}
        .value=${draft ?? value}
        ?error=${draft !== null && settingsHook.normalizeHex(draft) === null}
        @input=${onInput}
        @blur=${this.#revertDrafts}
      >
        <input slot="leading" class="acp-settings__swatch" type="color" aria-label="${label} picker" ?disabled=${disabled} .value=${value.toLowerCase()} @input=${onPicked} />
        <md-icon-button id=${id} slot="trailing" class="acp-settings__icon-button" aria-label="Pick a color" ?disabled=${disabled} @click=${this.#openColorPicker}>
          <md-icon class="acp-settings__icon">${unsafeSVG(colorizeIcon)}</md-icon>
        </md-icon-button>
      </md-text-field>
      <md-tooltip for=${id} show-delay="800">Pick a color</md-tooltip>`;
  }

  /**
   * @param {string} name The project's.
   */
  #renderProjectAccent(name) {
    const own = this.projectAccent?.enabled ? this.projectAccent.color : null;
    return html`<label class="acp-settings__toggle">
        <md-switch class="acp-settings__switch acp-settings__switch_project-accent" .selected=${live(own !== null)} @change=${this.#onProjectAccentToggle}></md-switch>
        <span>Own accent color for ${name}</span>
      </label>
      ${own === null
        ? nothing
        : html`<div class="acp-settings__field">
            ${this.#renderAccentInput({
              id: 'acp-settings-pick-project-color',
              label: 'Project accent color',
              value: own,
              draft: this.projectAccentDraft,
              onInput: this.#onProjectAccentInput,
              onPicked: this.#onProjectColorPicked,
            })}
          </div>`}`;
  }

  /** @param {Settings} settings */
  #renderTheme(settings) {
    const { appearance, accent } = settings;
    const accentError = this.accentDraft !== null && settingsHook.normalizeHex(this.accentDraft) === null;
    return html`<section class="acp-settings__group" aria-label="Theme" data-section="theme">
      ${this.#renderGroupHeader('Theme', 'theme', settings)}
      <div class="acp-settings__field">
        <span class="acp-settings__label" id="acp-settings-appearance">Appearance</span>
        <md-segmented-button-group
          class="acp-settings__segments"
          label="Appearance"
          aria-labelledby="acp-settings-appearance"
          .value=${appearance}
          @change=${this.#onAppearanceChange}
        >
          ${APPEARANCES.map(
            ({ value, label, icon }) => html`<md-segmented-button value=${value}>
              <md-icon slot="icon" class="acp-settings__segment-icon">${unsafeSVG(icon)}</md-icon>
              ${label}
            </md-segmented-button>`,
          )}
        </md-segmented-button-group>
      </div>
      <div class="acp-settings__field acp-settings__field_accent">
        ${this.#renderAccentInput({
          id: 'acp-settings-pick-color',
          label: 'Accent color',
          value: accent,
          draft: this.accentDraft,
          onInput: this.#onAccentInput,
          onPicked: this.#onColorPicked,
          disabled: Boolean(this.projectAccent?.enabled),
        })}
        ${accentError
          ? nothing
          : html`<span class="acp-settings__hint">Buttons, links, the caret and selection use this color.</span>`}
      </div>
      ${this.projectName ? this.#renderProjectAccent(this.projectName) : nothing}
    </section>`;
  }

  /** @param {string} family Shown in itself. */
  #renderFontOption(family) {
    return html`<md-option class="acp-settings__option" value=${family} style=${styleMap({ fontFamily: settingsHook.fontStack(family) })}>${family}</md-option>`;
  }

  /**
   * @param {string} label
   * @param {FontFamily[]} fonts
   */
  #renderFontGroup(label, fonts) {
    if (fonts.length === 0) return nothing;
    return html`<md-option-group label=${label}>
      ${fonts.map(({ family }) => this.#renderFontOption(family))}
    </md-option-group>`;
  }

  /**
   * @param {'editorFont' | 'terminalFont'} field
   * @param {string | null} saved
   * @param {string} unset What no font picked means.
   * @param {boolean} anyFont Offers proportional fonts too.
   */
  #renderFontSelect(field, saved, unset, anyFont) {
    const fonts = this.fonts;
    // Until the list arrives, the saved font is offered alone so the field shows it.
    const font = fonts === null || fonts.some(({ family }) => family === saved) ? saved : null;
    return html`<div class="acp-settings__field">
      <md-select
        class="acp-settings__input acp-settings__input_font"
        variant="outlined"
        label="Font"
        style=${styleMap({ '--_acp-settings-font': font ? settingsHook.fontStack(font) : null })}
        .value=${font ?? ''}
        @change=${(/** @type {Event} */ e) => this.#change({ [field]: /** @type {HTMLElementTagNameMap['md-select']} */ (e.target).value || null })}
      >
        <md-option class="acp-settings__option acp-settings__option_default" value="">${unset}</md-option>
        ${fonts === null
          ? font && this.#renderFontOption(font)
          : html`${this.#renderFontGroup('Monospaced', fonts.filter((f) => f.monospace))}
            ${anyFont ? this.#renderFontGroup('Other fonts', fonts.filter((f) => !f.monospace)) : nothing}`}
      </md-select>
    </div>`;
  }

  /**
   * @param {FontSizeField} field
   * @param {number | null} saved `null`: the size is `size`, not its own.
   * @param {number} size The size in use.
   * @param {string} hint
   */
  #renderFontSize(field, saved, size, hint) {
    return html`<div class="acp-settings__field">
      <md-text-field
        class="acp-settings__input"
        variant="outlined"
        label="Font size"
        inputmode="numeric"
        suffix-text="px"
        .value=${this.fontSizeDrafts[field] ?? (saved === null ? '' : String(saved))}
        @input=${(/** @type {Event} */ e) => this.#typeFontSize(field, /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value)}
        @keydown=${(/** @type {KeyboardEvent} */ e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          this.#stepFontSize(field, size, e.key === 'ArrowUp' ? 1 : -1);
        }}
        @blur=${this.#revertDrafts}
      >
        <span slot="trailing" class="acp-settings__stepper">
          <md-icon-button
            class="acp-settings__icon-button"
            aria-label="Smaller"
            ?disabled=${size <= settingsHook.fontSizeMin}
            @click=${() => this.#stepFontSize(field, size, -1)}
          >
            <md-icon class="acp-settings__icon">${unsafeSVG(removeIcon)}</md-icon>
          </md-icon-button>
          <md-icon-button
            class="acp-settings__icon-button"
            aria-label="Larger"
            ?disabled=${size >= settingsHook.fontSizeMax}
            @click=${() => this.#stepFontSize(field, size, 1)}
          >
            <md-icon class="acp-settings__icon">${unsafeSVG(addIcon)}</md-icon>
          </md-icon-button>
        </span>
      </md-text-field>
      <span class="acp-settings__hint">${hint}</span>
    </div>`;
  }

  /** @param {Settings} settings */
  #renderEditor(settings) {
    const { editorFontSize, editorFont } = settings;
    const fontFamily = editorFont ? settingsHook.fontStack(editorFont) : null;
    const lineHeight = settingsHook.lineHeightFor(editorFontSize);
    return html`<section class="acp-settings__group" aria-label="Editor" data-section="editor">
      ${this.#renderGroupHeader('Editor', 'editor', settings)}
      ${this.#renderFontSelect('editorFont', editorFont, `${settingsHook.defaultEditorFont} (default)`, true)}
      ${this.#renderFontSize(
        'editorFontSize',
        editorFontSize,
        editorFontSize,
        `${settingsHook.fontSizeMin}–${settingsHook.fontSizeMax} px. Line height follows: ${editorFontSize} / ${lineHeight}.`,
      )}
      <label class="acp-settings__toggle">
        <md-switch
          class="acp-settings__switch acp-settings__switch_markdown-sync"
          .selected=${live(settings.markdownScrollSync)}
          @change=${this.#onMarkdownSyncChange}
        ></md-switch>
        <span>Scroll a markdown file's editor and preview together</span>
      </label>
      <div
        class="acp-settings__preview"
        aria-label="Preview"
        style=${styleMap({
          '--_acp-settings-preview-font': fontFamily,
          fontSize: `${editorFontSize}px`,
          lineHeight: `${lineHeight}px`,
        })}
      >
        <span class="acp-settings__line-number">1</span><span
          ><span class="acp-settings__keyword">const</span> greeting =
          <span class="acp-settings__string">"Hello, Brama"</span>;</span
        >
        <span class="acp-settings__line-number">2</span><span
          ><span class="acp-settings__keyword">export</span> <span class="acp-settings__keyword">default</span>
          greeting;</span
        >
      </div>
    </section>`;
  }

  /** @param {import('../../hooks/settings/types.js').TerminalColors} colors */
  #renderTerminalColors(colors) {
    return html`<div class="acp-settings__colors">
      ${TERMINAL_COLORS.map(
        ({ key, label }) => html`<label class="acp-settings__color">
          <input
            class="acp-settings__swatch"
            type="color"
            aria-label=${label}
            .value=${colors.dark[key].toLowerCase()}
            @input=${(/** @type {Event} */ e) =>
              this.#change({ terminalColors: settingsHook.withTerminalColor(colors, key, /** @type {HTMLInputElement} */ (e.target).value) })}
          />
          <span>${label}</span>
        </label>`,
      )}
    </div>`;
  }

  /** @param {Settings} settings */
  #renderTerminal(settings) {
    const { terminalFont, terminalFontSize, editorFontSize } = settings;
    return html`<section class="acp-settings__group" aria-label="Terminal" data-section="terminal">
      ${this.#renderGroupHeader('Terminal', 'terminal', settings)}
      ${this.#renderFontSelect('terminalFont', terminalFont, 'Same as the editor', false)}
      ${this.#renderFontSize(
        'terminalFontSize',
        terminalFontSize,
        terminalFontSize ?? editorFontSize,
        terminalFontSize === null ? `Same as the editor: ${editorFontSize} px.` : `${settingsHook.fontSizeMin}–${settingsHook.fontSizeMax} px. Empty follows the editor.`,
      )}
      <div class="acp-settings__field">
        <span class="acp-settings__label" id="acp-settings-terminal-colors">Colors</span>
        <md-segmented-button-group
          class="acp-settings__segments"
          label="Terminal colors"
          aria-labelledby="acp-settings-terminal-colors"
          .value=${settings.terminalTheme}
          @change=${(/** @type {CustomEvent<{ value: Settings['terminalTheme'] }>} */ e) => this.#change({ terminalTheme: e.detail.value })}
        >
          <md-segmented-button value="app">From the app</md-segmented-button>
          <md-segmented-button value="custom">Custom</md-segmented-button>
        </md-segmented-button-group>
      </div>
      ${settings.terminalTheme === 'custom' && settings.terminalColors ? this.#renderTerminalColors(settings.terminalColors) : nothing}
      ${this.platform === 'mac'
        ? html`<label class="acp-settings__toggle">
            <md-switch
              class="acp-settings__switch"
              .selected=${live(settings.terminalOptionMeta)}
              @change=${(/** @type {Event} */ e) => this.#change({ terminalOptionMeta: /** @type {HTMLElementTagNameMap['md-switch']} */ (e.target).selected })}
            ></md-switch>
            <span>Use ⌥ as Meta, so Alt shortcuts reach the shell. ⌥ then no longer types characters like @ or € on some layouts.</span>
          </label>`
        : nothing}
    </section>`;
  }

  #renderNav() {
    return html`<nav class="acp-settings__nav" aria-label="Settings sections">
      ${SECTIONS.map(
        ({ id, label, icon }) => html`<button
          id="acp-settings-nav-${id}"
          class=${classMap({ 'acp-settings__nav-item': true, 'acp-settings__nav-item_active': id === this.current })}
          type="button"
          aria-label=${label}
          aria-current=${id === this.current ? 'true' : 'false'}
          @click=${() => this.#scrollTo(id, 'smooth')}
        >
          <md-icon class="acp-settings__nav-icon">${unsafeSVG(icon)}</md-icon>
          <span class="acp-settings__nav-label">${label}</span>
        </button>
        <md-tooltip for="acp-settings-nav-${id}" placement="right" show-delay="800">${label}</md-tooltip>`,
      )}
    </nav>`;
  }

  render() {
    const settings = this.settings;
    if (!settings) return nothing;
    return html`${this.#renderNav()}
      <div class="acp-settings__scroller" @scroll=${this.#onScroll}>
        <div class="acp-settings__panel">
          <div class="acp-settings__body">
            ${this.#renderTheme(settings)}
            <hr class="acp-settings__divider" />
            ${this.#renderEditor(settings)}
            <hr class="acp-settings__divider" />
            ${this.#renderTerminal(settings)}
          </div>
          <footer class="acp-settings__footer">
            <span id="acp-settings-edit-json" class="acp-settings__link" aria-disabled="true">
              <md-icon class="acp-settings__icon">${unsafeSVG(dataObjectIcon)}</md-icon>
              Edit in settings.json
            </span>
            <md-tooltip for="acp-settings-edit-json" show-delay="800">Not available yet</md-tooltip>
          </footer>
        </div>
      </div>`;
  }
}

customElements.define('acp-settings', AcpSettings);
