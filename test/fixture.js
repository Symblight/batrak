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

/**
 * The text of the `md-tooltip` anchored to `el` (by its id, in `el`'s root), or null.
 * @param {Element | null | undefined} el
 */
export function tooltipOf(el) {
  if (!el?.id) return null;
  const root = /** @type {Document | ShadowRoot} */ (el.getRootNode());
  return root.querySelector(`md-tooltip[for="${CSS.escape(el.id)}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
}
