import { html } from 'lit';
import { agents } from '../../hooks/agents/agents.js';
import { settings as settingsHook } from '../../hooks/settings/settings.js';
import { $activePath, $settingsReveal, SETTINGS_TAB_ID, settingsRevealed } from '../../stores/editor/editor.js';
import { $systemFonts } from '../../stores/fonts/fonts.js';
import {
  $settings,
  resetSection,
  setAccent,
  setAppearance,
  setEditorFont,
  setEditorFontSize,
} from '../../stores/settings/settings.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/settings/settings.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/settings/types.js').Settings} Settings */
/** @typedef {import('../../hooks/settings/types.js').SettingsReveal} SettingsReveal */
/** @typedef {import('../../stores/settings/rules.js').SettingsSection} SettingsSection */

/**
 * @tag acp-settings-view
 * @summary The Settings tab wired to its data: the settings, the installed fonts and the section to scroll to.
 */
export class AcpSettingsView extends ViewElement {
  #settings = new StoreController(this, { store: $settings });
  #fonts = new StoreController(this, { store: $systemFonts });
  #reveal = new StoreController(this, { store: $settingsReveal });
  /** Settings lists the fonts, and the agents with the versions they reported since. */
  #activePath = new StoreController(this, {
    store: $activePath,
    onChange: (path) => {
      if (path !== SETTINGS_TAB_ID) return;
      settingsHook.loadSystemFonts();
      agents.refresh();
    },
  });

  /** @param {Event} e */
  #onChange(e) {
    e.stopPropagation();
    const { patch } = /** @type {CustomEvent<{ patch: Partial<Settings> }>} */ (e).detail;
    if (patch.appearance !== undefined) setAppearance(patch.appearance);
    if (patch.accent !== undefined) setAccent(patch.accent);
    if (patch.editorFont !== undefined) setEditorFont(patch.editorFont);
    if (patch.editorFontSize !== undefined) setEditorFontSize(patch.editorFontSize);
  }

  /** @param {Event} e */
  #onReset(e) {
    e.stopPropagation();
    resetSection(/** @type {CustomEvent<{ section: SettingsSection }>} */ (e).detail.section);
  }

  /** @param {Event} e */
  #onRevealed(e) {
    e.stopPropagation();
    settingsRevealed(/** @type {CustomEvent<{ reveal: SettingsReveal }>} */ (e).detail.reveal);
  }

  render() {
    return html`<acp-settings
      .settings=${this.#settings.value}
      .fonts=${this.#fonts.value}
      .reveal=${this.#reveal.value}
      @acp-settings-change=${this.#onChange}
      @acp-settings-reset=${this.#onReset}
      @acp-settings-revealed=${this.#onRevealed}
    ></acp-settings>`;
  }
}

customElements.define('acp-settings-view', AcpSettingsView);
