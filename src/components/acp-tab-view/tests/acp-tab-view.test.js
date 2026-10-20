import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-tab-view.js';

/** @typedef {import('../../../models/types.js').EditorTab} EditorTab */

/**
 * @param {string} path
 * @returns {EditorTab}
 */
const fileTab = (path) => ({
  id: path,
  kind: 'file',
  path,
  content: '',
  error: '',
  loaded: false,
  image: null,
  baseline: null,
  draft: null,
});

describe('acp-tab-view', () => {
  it("shows a file tab's path relative to the project in its tooltip", async () => {
    const el = await fixture(html`<acp-tab-view
      .tabs=${[fileTab('/work/app/src/main.js')]}
      .root=${'/work/app'}
    ></acp-tab-view>`);
    expect(el.shadowRoot.querySelector('md-tooltip')?.textContent.trim()).to.equal('src/main.js');
  });

  it('keeps the absolute path for a file outside the project', async () => {
    const el = await fixture(html`<acp-tab-view
      .tabs=${[fileTab('/elsewhere/notes.md')]}
      .root=${'/work/app'}
    ></acp-tab-view>`);
    expect(el.shadowRoot.querySelector('md-tooltip')?.textContent.trim()).to.equal('/elsewhere/notes.md');
  });
});
