import { LitElement, html, nothing } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/segmented-button';
import '@symblight/wc-material/select';
import '@symblight/wc-material/text-field';
import lightModeIcon from '@material-design-icons/svg/outlined/light_mode.svg?raw';
import darkModeIcon from '@material-design-icons/svg/outlined/dark_mode.svg?raw';
import systemModeIcon from '@material-design-icons/svg/outlined/settings_brightness.svg?raw';
import colorizeIcon from '@material-design-icons/svg/outlined/colorize.svg?raw';
import removeIcon from '@material-design-icons/svg/outlined/remove.svg?raw';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import dataObjectIcon from '@material-design-icons/svg/outlined/data_object.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { fontStack } from '../../models/editor-fonts.js';
import { loadSystemFonts } from '../../services/fonts.js';
import { $systemFonts } from '../../stores/fonts.js';
import {
  $settings,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  isSectionDefault,
  lineHeightFor,
  normalizeHex,
  resetSection,
  setAccent,
  setAppearance,
  setEditorFont,
  setEditorFontSize,
} from '../../stores/settings.js';
import styles from './acp-settings.css?inline';

/** @typedef {import('../../models/types.js').Appearance} Appearance */
/** @typedef {import('../../models/types.js').FontFamily} FontFamily */

/** @type {{ value: Appearance, label: string, icon: string }[]} */
const APPEARANCES = [
  { value: 'light', label: 'Light', icon: lightModeIcon },
  { value: 'dark', label: 'Dark', icon: darkModeIcon },
  { value: 'system', label: 'System', icon: systemModeIcon },
];

/**
 * @tag acp-settings
 * @summary App settings (`$settings`), shown as a tab in the main column: Theme and Editor.
 */
export class AcpSettings extends LitElement {
  static properties = {
    accentDraft: { state: true },
    fontSizeDraft: { state: true },
  };

  static styles = styles;

  #settings = new StoreController(this, { store: $settings });
  #systemFonts = new StoreController(this, { store: $systemFonts });

  constructor() {
    super();
    /** @type {string | null} Accent HEX being typed; `null` shows the stored one. */
    this.accentDraft = null;
    /** @type {string | null} Font size being typed; `null` shows the stored one. */
    this.fontSizeDraft = null;
  }

  connectedCallback() {
    super.connectedCallback();
    loadSystemFonts();
  }

  async firstUpdated() {
    const select = this.renderRoot.querySelector('md-select');
    await select?.updateComplete;
    // md-menu sets its size on its own :host inside md-select's shadow root, with no part to reach it by;
    // an inline style beats that. The value stays in acp-settings.css.
    select?.menuEl?.style.setProperty('--md-menu-max-height', 'var(--_acp-settings-menu-max-height)');
  }

  /** Opens the system color panel of the swatch, a native color input. */
  #openColorPicker = () => {
    /** @type {HTMLInputElement} */ (this.renderRoot.querySelector('.acp-settings__swatch')).click();
  };

  #onAppearanceChange = (/** @type {Event} */ e) => {
    setAppearance(/** @type {CustomEvent<{ value: Appearance }>} */ (e).detail.value);
  };

  #onColorPicked = (/** @type {Event} */ e) => {
    // Inside the text field, whose own `input` handler would take it for typed text.
    e.stopPropagation();
    this.accentDraft = null;
    setAccent(/** @type {HTMLInputElement} */ (e.target).value);
  };

  #onAccentInput = (/** @type {Event} */ e) => {
    const value = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value;
    this.accentDraft = value;
    setAccent(value);
  };

  #onFontChange = (/** @type {Event} */ e) => {
    setEditorFont(/** @type {HTMLElementTagNameMap['md-select']} */ (e.target).value ?? null);
  };

  #onFontSizeInput = (/** @type {Event} */ e) => {
    const value = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value;
    this.fontSizeDraft = value;
    const size = Number(value.trim());
    if (/^\d+$/.test(value.trim()) && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX) setEditorFontSize(size);
  };

  #onFontSizeKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    this.#stepFontSize(e.key === 'ArrowUp' ? 1 : -1);
  };

  /** @param {number} delta */
  #stepFontSize(delta) {
    this.fontSizeDraft = null;
    setEditorFontSize(this.#settings.value.editorFontSize + delta);
  }

  /** Drops what was typed, showing the stored value again (the last valid one). */
  #revertDrafts = () => {
    this.accentDraft = null;
    this.fontSizeDraft = null;
  };

  /**
   * @param {string} title
   * @param {'theme' | 'editor'} section
   */
  #renderGroupHeader(title, section) {
    return html`<div class="acp-settings__group-header">
      <h3 class="acp-settings__group-title">${title}</h3>
      <md-button
        class="acp-settings__reset"
        variant="text"
        ?disabled=${isSectionDefault(section)}
        @click=${() => {
          this.#revertDrafts();
          resetSection(section);
        }}
        >Reset</md-button
      >
    </div>`;
  }

  #renderTheme() {
    const { appearance, accent } = this.#settings.value;
    const accentError = this.accentDraft !== null && normalizeHex(this.accentDraft) === null;
    return html`<section class="acp-settings__group" aria-label="Theme">
      ${this.#renderGroupHeader('Theme', 'theme')}
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
      <div class="acp-settings__field">
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
            slot="trailing"
            class="acp-settings__icon-button"
            aria-label="Pick a color"
            title="Pick a color"
            @click=${this.#openColorPicker}
          >
            <md-icon class="acp-settings__icon">${unsafeSVG(colorizeIcon)}</md-icon>
          </md-icon-button>
        </md-text-field>
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

  #renderEditor() {
    const { editorFontSize } = this.#settings.value;
    const { editorFont } = this.#settings.value;
    const fonts = this.#systemFonts.value;
    // Until the list arrives, the saved font is offered alone so the field shows it.
    const font = fonts === null || fonts.some(({ family }) => family === editorFont) ? editorFont : null;
    const fontFamily = font ? fontStack(font) : null;
    const lineHeight = lineHeightFor(editorFontSize);
    return html`<section class="acp-settings__group" aria-label="Editor">
      ${this.#renderGroupHeader('Editor', 'editor')}
      <div class="acp-settings__field">
        <md-select
          class="acp-settings__input acp-settings__input_font"
          variant="outlined"
          label="Font"
          style=${styleMap({ '--_acp-settings-font': fontFamily })}
          .value=${font ?? ''}
          @change=${this.#onFontChange}
        >
          <md-option class="acp-settings__option" value="">System default</md-option>
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

  render() {
    return html`<div class="acp-settings__panel">
      <div class="acp-settings__body">
        ${this.#renderTheme()}
        <hr class="acp-settings__divider" />
        ${this.#renderEditor()}
      </div>
      <footer class="acp-settings__footer">
        <span class="acp-settings__link" aria-disabled="true" title="Not available yet">
          <md-icon class="acp-settings__icon">${unsafeSVG(dataObjectIcon)}</md-icon>
          Edit in settings.json
        </span>
      </footer>
    </div>`;
  }
}

customElements.define('acp-settings', AcpSettings);
