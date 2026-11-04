import { render, html } from 'lit';
import { expect } from '@esm-bundle/chai';

export { expect, html };

/** @type {Set<HTMLElement>} Hosts of the fixtures of the running test. */
const hosts = new Set();

// Registered by the first test file that imports this: removes what a test rendered once it ends, so
// a host's store subscriptions and IPC listeners never reach the next test. Runs after the file's
// own `afterEach` hooks, which can still read the elements.
afterEach(async () => {
  for (const host of hosts) host.remove();
  hosts.clear();
  // A removed terminal lets go of its screen a task later: the next test's mustn't take it over.
  await new Promise((resolve) => setTimeout(resolve));
});

/**
 * Renders a template into the page and resolves with its first element once it has updated. The
 * page is cleared after each test.
 * @param {import('lit').TemplateResult} template
 * @returns {Promise<any>}
 */
export async function fixture(template) {
  const host = document.createElement('div');
  hosts.add(host);
  document.body.append(host);
  render(template, host);
  const el = /** @type {any} */ (host.firstElementChild);
  await el.updateComplete;
  return el;
}

/**
 * What the backend's `read_file` replies with.
 * @param {string} text
 */
export function fileBytes(text) {
  return new TextEncoder().encode(text).buffer;
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
