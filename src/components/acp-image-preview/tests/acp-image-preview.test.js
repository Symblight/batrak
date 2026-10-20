import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-image-preview.js';

/** @typedef {import('../acp-image-preview.js').AcpImagePreview} AcpImagePreview */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20"/></svg>';
const svgBlob = () => new Blob([SVG], { type: 'image/svg+xml' });

/**
 * @param {AcpImagePreview} el
 * @param {string} selector
 */
const query = (el, selector) => el.shadowRoot?.querySelector(selector) ?? null;

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).to.equal(true);
}

describe('acp-image-preview', () => {
  it('shows the image from its blob', async () => {
    const el = await fixture(html`<acp-image-preview path="/p/logo.svg" .image=${svgBlob()}></acp-image-preview>`);
    const img = /** @type {HTMLImageElement} */ (query(el, '.acp-image-preview__image'));
    expect(img.src).to.match(/^blob:/);
    await until(() => img.complete && img.naturalWidth > 0);
  });

  it('describes the file in the footer: resolution, type and size', async () => {
    const image = svgBlob();
    const el = await fixture(html`<acp-image-preview path="/p/logo.svg" .image=${image}></acp-image-preview>`);
    const footer = () => query(el, '.acp-image-preview__footer')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    await until(() => footer().includes('30 × 20 px'));
    expect(footer()).to.include('SVG');
    const bytes = /** @type {import('../../acp-bytes/acp-bytes.js').AcpBytes} */ (query(el, 'acp-bytes'));
    expect(bytes.value).to.equal(image.size);
  });

  it('shows no image while the file is still being read', async () => {
    const el = await fixture(html`<acp-image-preview path="/p/a.png"></acp-image-preview>`);
    expect(query(el, '.acp-image-preview__image')).to.equal(null);
    expect(query(el, 'acp-bytes')).to.equal(null);
  });

  it('says so when the image cannot be decoded', async () => {
    const broken = new Blob(['not a png'], { type: 'image/png' });
    const el = await fixture(html`<acp-image-preview path="/p/a.png" .image=${broken}></acp-image-preview>`);
    await until(() => query(el, 'acp-view-placeholder') !== null);
    expect(query(el, '.acp-image-preview__image')).to.equal(null);
  });

  it('replaces the blob URL when the image changes and frees it when removed', async () => {
    const el = await fixture(html`<acp-image-preview path="/p/logo.svg" .image=${svgBlob()}></acp-image-preview>`);
    const first = /** @type {HTMLImageElement} */ (query(el, '.acp-image-preview__image')).src;
    el.image = svgBlob();
    await el.updateComplete;
    const second = /** @type {HTMLImageElement} */ (query(el, '.acp-image-preview__image')).src;
    expect(second).to.not.equal(first);
    expect(await fetch(first).then(() => true, () => false)).to.equal(false);
    el.remove();
    expect(await fetch(second).then(() => true, () => false)).to.equal(false);
  });

  it('draws a checkerboard behind the image by default; auto keeps the column background', async () => {
    // The app's tokens, which the checkerboard is drawn with.
    const tokens = '--md-surface-container: #eee; --md-surface-container-high: #ddd';
    const el = await fixture(html`<acp-image-preview style=${tokens} path="/p/a.png"></acp-image-preview>`);
    expect(el.background).to.equal('grid');
    const canvas = /** @type {HTMLElement} */ (query(el, '.acp-image-preview__canvas'));
    expect(getComputedStyle(canvas).backgroundImage).to.include('gradient');
    el.background = 'auto';
    await el.updateComplete;
    expect(getComputedStyle(canvas).backgroundImage).to.equal('none');
  });
});
