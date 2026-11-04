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
 * @fires acp-settings-reset `{ section }`
 * @fires acp-settings-revealed `{ reveal }` The `reveal` asked for was shown.
 */
export class AcpSettings extends LitElement {
  static properties = {
    settings: { attribute: false },
    fonts: { attribute: false },
    reveal: { attribute: false },
    current: { state: true },
    accentDraft: { state: true },
    fontSizeDrafts: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Settings | null} */
    this.settings = null;
    /** @type {FontFamily[] | null} Installed fonts, sorted; `null` until listed. */
    this.fonts = null;
    /** @type {SettingsReveal | null} A section to scroll to; `acp-settings-revealed` once it has. */
    this.reveal = null;
    /** @type {SettingsAnchor} The section being read, marked in the list. */
    this.current = 'theme';
    /** @type {string | null} Accent HEX being typed; `null` shows the stored one. */
    this.accentDraft = null;
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

  /** Opens the system color panel of the swatch, a native color input. */
  #openColorPicker = () => {
    /** @type {HTMLInputElement} */ (this.renderRoot.querySelector('.acp-settings__swatch')).click();
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
        ?disabled=${settingsHook.isSectionDefault(settings, section)}
        @click=${() => {
          this.#revertDrafts();
          this.dispatchEvent(new CustomEvent('acp-settings-reset', { detail: { section }, bubbles: true, composed: true }));
        }}
        >Reset</md-button
      >
    </div>`;
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
        <md-text-field
          class="acp-settings__input"
          variant="outlined"
          label="Accent color"
          spellcheck="false"
          .value=${this.accentDraft ?? accent}
          ?error=${accentError}
          @input=${this.#onAccentInput}
          @blur=${this.#revertDrafts}
        >
          <input
            slot="leading"
            class="acp-settings__swatch"
            type="color"
            aria-label="Accent color picker"
            .value=${accent.toLowerCase()}
            @input=${this.#onColorPicked}
          />
          <md-icon-button
            id="acp-settings-pick-color"
            slot="trailing"
            class="acp-settings__icon-button"
            aria-label="Pick a color"
            @click=${this.#openColorPicker}
          >
            <md-icon class="acp-settings__icon">${unsafeSVG(colorizeIcon)}</md-icon>
          </md-icon-button>
        </md-text-field>
        <md-tooltip for="acp-settings-pick-color" show-delay="800">Pick a color</md-tooltip>
        ${accentError
          ? nothing
          : html`<span class="acp-settings__hint">Buttons, links, the caret and selection use this color.</span>`}
      </div>
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
