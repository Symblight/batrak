import { expect, fixture, html } from '../../../../test/fixture.js';
import '../commit-box.js';

/** @typedef {import('../commit-box.js').AcpCommitBox} AcpCommitBox */

/** @param {Partial<AcpCommitBox>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpCommitBox} */ (await fixture(html`<acp-commit-box></acp-commit-box>`));
  Object.assign(el, props);
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return {
    el,
    root,
    commit: () => /** @type {HTMLElementTagNameMap['md-button']} */ (root.querySelector('.acp-commit-box__commit')),
    field: () => /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector('.acp-commit-box__message')),
    amend: () => /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-commit-box__amend md-checkbox')),
  };
}

/**
 * @param {HTMLElement} el
 * @param {string} type
 */
function listen(el, type) {
  /** @type {unknown[]} */
  const details = [];
  el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
  return details;
}

/** @param {Awaited<ReturnType<typeof render>>} view @param {string} value */
async function type(view, value) {
  view.field().value = value;
  view.field().dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  await view.el.updateComplete;
}

describe('acp-commit-box', () => {
  it('says how many files the commit takes, and enables Commit only with a message and files (or Amend)', async () => {
    /** @type {[number, string, boolean, string, boolean][]} */
    const cases = [
      // [included, message, amend, label, enabled]
      [0, '', false, 'Commit', false],
      [0, 'fix', false, 'Commit', false],
      [1, '', false, 'Commit 1 file', false],
      [1, '   ', false, 'Commit 1 file', false],
      [3, 'fix', false, 'Commit 3 files', true],
      [0, 'reword', true, 'Amend commit', true],
      [0, '', true, 'Amend commit', false],
    ];
    for (const [included, message, amend, label, enabled] of cases) {
      const view = await render({ included });
      await type(view, message);
      if (amend) {
        view.amend().checked = true;
        view.amend().dispatchEvent(new Event('change', { bubbles: true }));
        await type(view, message);
      }
      await view.el.updateComplete;
      const text = view.commit().textContent?.replace(/\s+/g, ' ').trim();
      expect([text, !view.commit().disabled], `${included} files, "${message}", amend ${amend}`).to.deep.equal([label, enabled]);
    }
  });

  it('commits with the trimmed message and locks the form until told how it went: kept on failure, cleared on success', async () => {
    const view = await render({ included: 2 });
    const submits = listen(view.el, 'acp-commit-submit');
    await type(view, '  Fix the tabs  ');
    view.commit().click();
    view.commit().click();
    await view.el.updateComplete;
    expect(submits, 'a second press while committing is ignored').to.deep.equal([{ message: 'Fix the tabs', amend: false }]);
    expect(view.commit().textContent?.trim()).to.equal('Committing…');
    expect(view.field().disabled).to.equal(true);

    view.el.finished(false);
    await view.el.updateComplete;
    expect([view.field().disabled, view.field().value], 'kept for another try').to.deep.equal([false, '  Fix the tabs  ']);

    view.commit().click();
    view.el.finished(true);
    await view.el.updateComplete;
    expect([view.field().value, view.commit().disabled], 'cleared').to.deep.equal(['', true]);
  });

  it('asks for the last commit’s message when Amend turns on, fills it only while on, and restores the draft when it turns off', async () => {
    const view = await render({ included: 1 });
    const starts = listen(view.el, 'acp-amend-start');
    await type(view, 'my draft');
    view.el.fillAmendMessage('ignored: amend is off');
    await view.el.updateComplete;
    expect(view.field().value).to.equal('my draft');

    view.amend().checked = true;
    view.amend().dispatchEvent(new Event('change', { bubbles: true }));
    await view.el.updateComplete;
    expect(starts).to.have.length(1);
    view.el.fillAmendMessage(null);
    view.el.fillAmendMessage('Last commit');
    await view.el.updateComplete;
    expect(view.field().value).to.equal('Last commit');

    view.amend().checked = false;
    view.amend().dispatchEvent(new Event('change', { bubbles: true }));
    await view.el.updateComplete;
    expect(view.field().value, 'the draft is back').to.equal('my draft');
  });
});
