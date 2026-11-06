import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import { app } from '../../../hooks/app/app.js';
import { shortcuts } from '../../../hooks/shortcuts/shortcuts.js';
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
    amend: () => /** @type {HTMLElementTagNameMap['md-filter-chip']} */ (root.querySelector('.acp-commit-box__amend')),
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
        view.amend().selected = true;
        view.amend().dispatchEvent(new Event('change', { bubbles: true }));
        await type(view, message);
      }
      await view.el.updateComplete;
      const text = view.commit().textContent?.replace(/\s+/g, ' ').trim();
      expect([text, !view.commit().disabled], `${included} files, "${message}", amend ${amend}`).to.deep.equal([label, enabled]);
    }
  });

  it('says why Commit is disabled', async () => {
    /** @type {[number, string, boolean, string | null][]} */
    const cases = [
      // [included, message, amend, why]
      [1, '', false, 'Write a commit message'],
      [0, '', false, 'Write a commit message'],
      [0, 'fix', false, 'Select files to commit'],
      [1, 'fix', false, null],
      [0, '', true, 'Write a commit message'],
      [0, 'reword', true, null],
    ];
    for (const [included, message, amend, why] of cases) {
      // Arrange
      const view = await render({ included });
      if (amend) {
        view.amend().selected = true;
        view.amend().dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Act
      await type(view, message);
      // Assert
      const reason = /** @type {HTMLElement} */ (view.root.querySelector('.acp-commit-box__reason'));
      expect(tooltipOf(reason), `${included} files, "${message}", amend ${amend}`).to.equal(why);
    }
  });

  it('counts the summary line under the field, marks one past 72, and names the shortcut', async () => {
    /** @type {[string, string, boolean][]} */
    const cases = [
      // [message, summary text, too long]
      ['', 'First line is the summary', false],
      ['  fix it  \n\nbody that does not count', 'Summary 6/72', false],
      ['x'.repeat(72), 'Summary 72/72', false],
      ['x'.repeat(73), 'Summary 73/72', true],
    ];
    for (const [message, text, over] of cases) {
      // Arrange
      const view = await render();
      // Act
      await type(view, message);
      // Assert
      const summary = /** @type {HTMLElement} */ (view.root.querySelector('.acp-commit-box__summary'));
      expect(summary.textContent?.trim(), message).to.equal(text);
      expect(summary.classList.contains('acp-commit-box__summary_over'), message).to.equal(over);
    }
    const view = await render();
    expect(view.root.querySelector('.acp-commit-box__shortcut')?.textContent?.replace(/\s+/g, ' ').trim()).to.equal(`${shortcuts.hint('commit')} to commit`);
  });

  it('commits on the shortcut only when Commit could, not on a plain Enter', async () => {
    // Arrange
    const view = await render({ included: 1 });
    const commits = listen(view.el, 'acp-commit-submit');
    const mac = app.platform === 'mac';
    const press = (/** @type {KeyboardEventInit} */ init) => view.field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, composed: true, ...init }));
    // Act
    press({ metaKey: mac, ctrlKey: !mac });
    await type(view, 'fix');
    press({});
    const afterPlainEnter = commits.length;
    press({ metaKey: mac, ctrlKey: !mac });
    // Assert
    expect(afterPlainEnter).to.equal(0);
    expect(commits).to.deep.equal([{ message: 'fix', amend: false }]);
  });

  it('keeps the field at two lines at least, grows it with its lines up to six, and shrinks it again', async () => {
    // Arrange
    const view = await render();
    await view.field().updateComplete;
    const area = /** @type {HTMLTextAreaElement} */ (view.field().shadowRoot?.querySelector('textarea'));
    const heightWith = async (/** @type {number} */ lines) => {
      await type(view, Array(lines).fill('line').join('\n'));
      await view.field().updateComplete;
      await view.el.updateComplete;
      return area.offsetHeight;
    };
    // Act
    const one = await heightWith(1);
    const two = await heightWith(2);
    const three = await heightWith(3);
    const six = await heightWith(6);
    const twenty = await heightWith(20);
    const oneAgain = await heightWith(1);
    // Assert
    expect(two).to.equal(one);
    expect(three).to.be.greaterThan(two);
    expect(six).to.be.greaterThan(three);
    expect(twenty).to.equal(six);
    expect(oneAgain).to.equal(one);
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
    expect(view.commit().querySelector('md-progress-circular'), 'a spinner').to.not.equal(null);
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

    view.amend().selected = true;
    view.amend().dispatchEvent(new Event('change', { bubbles: true }));
    await view.el.updateComplete;
    expect(starts).to.have.length(1);
    view.el.fillAmendMessage(null);
    view.el.fillAmendMessage('Last commit');
    await view.el.updateComplete;
    expect(view.field().value).to.equal('Last commit');

    view.amend().selected = false;
    view.amend().dispatchEvent(new Event('change', { bubbles: true }));
    await view.el.updateComplete;
    expect(view.field().value, 'the draft is back').to.equal('my draft');
  });
});
