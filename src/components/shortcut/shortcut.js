import { LitElement, html } from 'lit';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './shortcut.css?inline';

/** @typedef {import('../../hooks/shortcuts/shortcuts.js').ShortcutId} ShortcutId */

/**
 * @tag acp-shortcut
 * @summary A key chip: a table shortcut's hint, a group's, or else its slotted text (↑↓, Enter, Esc). Its fill is `--acp-shortcut-background`, its text `--acp-shortcut-color` (the parent's by default).
 */
export class AcpShortcut extends LitElement {
  static properties = {
    shortcut: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {ShortcutId | ShortcutId[] | null} */
    this.shortcut = null;
  }

  render() {
    const { shortcut } = this;
    const text = shortcut === null ? null : Array.isArray(shortcut) ? shortcuts.group(shortcut) : shortcuts.hint(shortcut);
    return html`<kbd class="acp-shortcut__key">${text ?? html`<slot></slot>`}</kbd>`;
  }
}

customElements.define('acp-shortcut', AcpShortcut);
