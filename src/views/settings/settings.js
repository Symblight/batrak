import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/segmented-button';
import '@symblight/wc-material/select';
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
import { DEFAULT_EDITOR_FONT, fontStack } from '../../models/editor-fonts/editor-fonts.js';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, isSectionDefault, lineHeightFor, normalizeHex } from '../../models/settings/settings.js';
import styles from './settings.css?inline';

/** @typedef {import('../../models/types/types.js').Appearance} Appearance */
/** @typedef {import('../../models/types/types.js').FontFamily} FontFamily */
/** @typedef {import('../../models/types/types.js').Settings} Settings */
/** @typedef {import('../../models/settings/settings.js').SettingsSection} SettingsSection */
/** @typedef {import('../../models/types/types.js').SettingsAnchor} SettingsAnchor */
/** @typedef {import('../../models/types/types.js').SettingsReveal} SettingsReveal */

/** @type {{ id: SettingsAnchor, label: string, icon: string }[]} The sections, top to bottom. */
const SECTIONS = [
  { id: 'theme', label: 'Theme', icon: paletteIcon },
  { id: 'editor', label: 'Editor', icon: codeIcon },
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
 * @summary App settings, shown as a tab in the main column: one card of sections (Theme, Editor) and a list that scrolls to them.
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
    fontSizeDraft: { state: true },
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
    /** @type {string | null} Font size being typed; `null` shows the stored one. */
    this.fontSizeDraft = null;
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
    const select = this.renderRoot.querySelector('md-select');
    if (!select || this.#menuSized) return;
    this.#menuSized = true;
    await select.updateComplete;
    // md-menu sets its size on its own :host inside md-select's shadow root, with no part to reach it by;
    // an inline style beats that. The value stays in acp-settings.css.
    select.menuEl?.style.setProperty('--md-menu-max-height', 'var(--_acp-settings-menu-max-height)');
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

  #onFontChange = (/** @type {Event} */ e) => {
    this.#change({ editorFont: /** @type {HTMLElementTagNameMap['md-select']} */ (e.target).value || null });
  };

  #onFontSizeInput = (/** @type {Event} */ e) => {
    const value = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value;
    this.fontSizeDraft = value;
    const size = Number(value.trim());
    if (/^\d+$/.test(value.trim()) && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX) this.#change({ editorFontSize: size });
  };

  #onFontSizeKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    this.#stepFontSize(e.key === 'ArrowUp' ? 1 : -1);
  };

  /** @param {number} delta */
  #stepFontSize(delta) {
    this.fontSizeDraft = null;
    if (this.settings) this.#change({ editorFontSize: this.settings.editorFontSize + delta });
  }

  /** Drops what was typed, showing the stored value again (the last valid one). */
  #revertDrafts = () => {
    this.accentDraft = null;
    this.fontSizeDraft = null;
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
        ?disabled=${isSectionDefault(settings, section)}
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
    const accentError = this.accentDraft !== null && normalizeHex(this.accentDraft) === null;
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
    return html`<md-option class="acp-settings__option" value=${family} style=${styleMap({ fontFamily: fontStack(family) })}>${family}</md-option>`;
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

  /** @param {Settings} settings */
  #renderEditor(settings) {
    const { editorFontSize, editorFont } = settings;
    const fonts = this.fonts;
    // Until the list arrives, the saved font is offered alone so the field shows it.
    const font = fonts === null || fonts.some(({ family }) => family === editorFont) ? editorFont : null;
    const fontFamily = font ? fontStack(font) : null;
    const lineHeight = lineHeightFor(editorFontSize);
    return html`<section class="acp-settings__group" aria-label="Editor" data-section="editor">
      ${this.#renderGroupHeader('Editor', 'editor', settings)}
      <div class="acp-settings__field">
        <md-select
          class="acp-settings__input acp-settings__input_font"
          variant="outlined"
          label="Font"
          style=${styleMap({ '--_acp-settings-font': fontFamily })}
          .value=${font ?? ''}
          @change=${this.#onFontChange}
        >
          <md-option class="acp-settings__option acp-settings__option_default" value="">${DEFAULT_EDITOR_FONT} (default)</md-option>
          ${fonts === null
            ? font && this.#renderFontOption(font)
            : html`${this.#renderFontGroup('Monospaced', fonts.filter((f) => f.monospace))}
              ${this.#renderFontGroup('Other fonts', fonts.filter((f) => !f.monospace))}`}
        </md-select>
      </div>
      <div class="acp-settings__field">
        <md-text-field
          class="acp-settings__input"
          variant="outlined"
          label="Font size"
          inputmode="numeric"
          suffix-text="px"
          .value=${this.fontSizeDraft ?? String(editorFontSize)}
          @input=${this.#onFontSizeInput}
          @keydown=${this.#onFontSizeKeydown}
          @blur=${this.#revertDrafts}
        >
          <span slot="trailing" class="acp-settings__stepper">
            <md-icon-button
              class="acp-settings__icon-button"
              aria-label="Smaller"
              ?disabled=${editorFontSize <= FONT_SIZE_MIN}
              @click=${() => this.#stepFontSize(-1)}
            >
              <md-icon class="acp-settings__icon">${unsafeSVG(removeIcon)}</md-icon>
            </md-icon-button>
            <md-icon-button
              class="acp-settings__icon-button"
              aria-label="Larger"
              ?disabled=${editorFontSize >= FONT_SIZE_MAX}
              @click=${() => this.#stepFontSize(1)}
            >
              <md-icon class="acp-settings__icon">${unsafeSVG(addIcon)}</md-icon>
            </md-icon-button>
          </span>
        </md-text-field>
        <span class="acp-settings__hint"
          >${FONT_SIZE_MIN}–${FONT_SIZE_MAX} px. Line height follows: ${editorFontSize} / ${lineHeight}.</span
        >
      </div>
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
