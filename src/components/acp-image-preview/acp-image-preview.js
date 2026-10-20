import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import brokenImageIcon from '@material-design-icons/svg/outlined/broken_image.svg?raw';
import '../acp-bytes/acp-bytes.js';
import '../acp-view-placeholder/acp-view-placeholder.js';
import { imageTypeOf } from '../../models/image-types.js';
import styles from './acp-image-preview.css?inline';

/** @typedef {'grid' | 'auto'} ImageBackground */

/**
 * @tag acp-image-preview
 * @summary An image file's tab, SVG included: the image centered, never scaled up, over a background, and a footer describing the file.
 */
export class AcpImagePreview extends LitElement {
  static properties = {
    path: {},
    image: { attribute: false },
    background: {},
    _size: { state: true },
    _broken: { state: true },
  };

  static styles = styles;

  /** @type {string | null} Object URL of `image`, made while connected. */
  #url = null;
  /** @type {Blob | null} The blob `#url` points at. */
  #urlOf = null;

  constructor() {
    super();
    /** @type {string} Absolute. */
    this.path = '';
    /** @type {Blob | null} The file's bytes; `null` while it is read. */
    this.image = null;
    /** @type {ImageBackground} `grid`: a checkerboard, so transparency shows; `auto`: the column's background. */
    this.background = 'grid';
    /** @type {{ width: number, height: number } | null} Natural size, once decoded. */
    this._size = null;
    /** Whether the image failed to decode. */
    this._broken = false;
  }

  connectedCallback() {
    super.connectedCallback();
    // Freed on disconnect: a tab switched back to needs its URL again.
    if (this.image && !this.#url) this.requestUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#revoke();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('image')) {
      this._size = null;
      this._broken = false;
    }
    if (this.image !== this.#urlOf) {
      this.#revoke();
      if (this.image) {
        this.#url = URL.createObjectURL(this.image);
        this.#urlOf = this.image;
      }
    }
  }

  #revoke() {
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = null;
    this.#urlOf = null;
  }

  #onLoad = (/** @type {Event} */ e) => {
    const img = /** @type {HTMLImageElement} */ (e.currentTarget);
    this._size = { width: img.naturalWidth, height: img.naturalHeight };
  };

  #onError = () => {
    this._broken = true;
  };

  render() {
    return html`
      <div
        class=${classMap({
          'acp-image-preview__canvas': true,
          'acp-image-preview__canvas_grid': this.background === 'grid',
        })}
      >
        ${this.#renderImage()}
      </div>
      <div class="acp-image-preview__footer">${this.#renderFacts()}</div>
    `;
  }

  #renderImage() {
    if (this._broken) {
      return html`<acp-view-placeholder
        class="acp-image-preview__placeholder"
        .icon=${brokenImageIcon}
        heading="Can't preview this image"
        text="The file isn't an image this view can decode."
      ></acp-view-placeholder>`;
    }
    if (!this.#url) return nothing;
    return html`<img
      class="acp-image-preview__image"
      src=${this.#url}
      alt=${this.path.split(/[\\/]/).pop() ?? ''}
      draggable="false"
      @load=${this.#onLoad}
      @error=${this.#onError}
    />`;
  }

  #renderFacts() {
    const facts = [];
    if (this._size && this._size.width > 0) {
      facts.push(html`<span class="acp-image-preview__fact">
        <span class="acp-image-preview__value">${this._size.width} × ${this._size.height}</span> px
      </span>`);
    }
    const { label } = imageTypeOf(this.path);
    if (label) facts.push(html`<span class="acp-image-preview__fact">${label}</span>`);
    if (this.image) {
      facts.push(html`<acp-bytes class="acp-image-preview__fact" .value=${this.image.size}></acp-bytes>`);
    }
    return facts.map((fact, i) => (i ? html`<span class="acp-image-preview__separator"></span>${fact}` : fact));
  }
}

customElements.define('acp-image-preview', AcpImagePreview);
