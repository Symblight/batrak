import { render, html } from 'lit';
import { expect } from '@esm-bundle/chai';

export { expect, html };

/**
 * Renders a template into the page and resolves with its first element once it has updated.
 * @param {import('lit').TemplateResult} template
 * @returns {Promise<any>}
 */
export async function fixture(template) {
  const host = document.createElement('div');
  document.body.append(host);
  render(template, host);
  const el = /** @type {any} */ (host.firstElementChild);
  await el.updateComplete;
  return el;
}
