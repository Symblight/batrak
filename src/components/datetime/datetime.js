import { LitElement, html, nothing } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import styles from './datetime.css?inline';

const MINUTE = 60_000;

/**
 * @tag acp-datetime
 * @summary A time as text: `compact` is its age (`now`, `12m`, `3h`, `2d`), `medium` the date and time in the reader's locale.
 */
export class AcpDatetime extends LitElement {
  static properties = {
    value: { attribute: false },
    now: { attribute: false },
    format: { type: String },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string | number | null} An ISO string or milliseconds since the epoch. */
    this.value = null;
    /** @type {number | null} What `compact` counts from; the current time while `null`. */
    this.now = null;
    /** @type {'compact' | 'medium'} */
    this.format = 'medium';
  }

  /** @param {number} time */
  #age(time) {
    const minutes = Math.floor(((this.now ?? Date.now()) - time) / MINUTE);
    if (!(minutes >= 1)) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / (60 * 24))}d`;
  }

  render() {
    if (this.value === null || this.value === '') return nothing;
    const time = new Date(this.value).getTime();
    const valid = !Number.isNaN(time);
    const label = this.format === 'compact'
      ? this.#age(time)
      : valid
        ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : '';
    return html`<time datetime=${ifDefined(valid ? new Date(time).toISOString() : undefined)}>${label}</time>`;
  }
}

customElements.define('acp-datetime', AcpDatetime);
