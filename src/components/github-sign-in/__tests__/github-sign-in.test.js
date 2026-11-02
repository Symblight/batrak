import { expect, fixture, html } from '../../../../test/fixture.js';
import '../github-sign-in.js';

/** @typedef {import('../../../hooks/github/types.js').GithubSignIn} GithubSignIn */

/** @type {GithubSignIn} */
const IDLE = { phase: 'idle', code: null, error: null, installCommand: null };

/**
 * Records the events of these names that `el` sends, with their details.
 * @param {HTMLElement} el
 * @param {Iterable<string>} names
 * @returns {[string, unknown][]}
 */
function listen(el, names) {
  /** @type {[string, unknown][]} */
  const heard = [];
  for (const name of new Set(names)) el.addEventListener(name, (e) => heard.push([name, /** @type {CustomEvent} */ (e).detail]));
  return heard;
}

describe('acp-github-sign-in', () => {
  it('opens for each phase of the sign-in with the actions that fit it, and closes when idle', async () => {
    /** @type {[GithubSignIn, string[], string[]][]} Expected buttons and the events each one sends, in order. */
    const cases = [
      [{ ...IDLE, phase: 'starting' }, ['Cancel'], ['acp-github-sign-in-cancel']],
      [{ ...IDLE, phase: 'code', code: '91BE-580F' }, ['Cancel', 'Copy code', 'Open github.com'], ['acp-github-sign-in-cancel', 'acp-github-copy', 'acp-github-open']],
      [{ ...IDLE, phase: 'failed', error: 'authorization was declined' }, ['Close', 'Try again'], ['acp-github-sign-in-cancel', 'acp-github-sign-in']],
      [{ ...IDLE, phase: 'noCli', installCommand: 'brew install gh' }, ['Close', 'Check again', 'Open install page'], ['acp-github-sign-in-cancel', 'acp-github-sign-in', 'acp-github-open']],
    ];
    const el = await fixture(html`<acp-github-sign-in .state=${IDLE}></acp-github-sign-in>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const dialog = /** @type {HTMLElementTagNameMap['md-dialog']} */ (root.querySelector('md-dialog'));
    expect(dialog.open, 'closed while idle').to.equal(false);
    for (const [state, labels, events] of cases) {
      // Arrange
      el.state = state;
      await el.updateComplete;
      const heard = listen(el, events);
      const buttons = [...root.querySelectorAll('.acp-github-sign-in__action')];
      // Act
      for (const button of buttons) /** @type {HTMLElement} */ (button).click();
      // Assert
      expect(dialog.open, state.phase).to.equal(true);
      expect(buttons.map((b) => b.textContent?.trim()), state.phase).to.deep.equal(labels);
      expect(heard.map(([name]) => name), state.phase).to.deep.equal(events);
      expect(root.querySelector('.acp-github-sign-in__content')?.textContent, state.phase).to.contain(state.code ?? state.error ?? state.installCommand ?? 'Starting');
    }
    // The code is what gets copied, and the page is where it is entered.
    el.state = { ...IDLE, phase: 'code', code: '91BE-580F' };
    await el.updateComplete;
    const details = listen(el, ['acp-github-copy', 'acp-github-open']);
    for (const button of [...root.querySelectorAll('.acp-github-sign-in__action')].slice(1)) /** @type {HTMLElement} */ (button).click();
    expect(details.map(([, detail]) => detail)).to.deep.equal([{ text: '91BE-580F' }, { url: 'https://github.com/login/device' }]);

    el.state = IDLE;
    await el.updateComplete;
    expect(dialog.open, 'closed again').to.equal(false);
  });
});
