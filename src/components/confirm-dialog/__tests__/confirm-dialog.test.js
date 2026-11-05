import { expect, fixture, html } from '../../../../test/fixture.js';
import '../confirm-dialog.js';

describe('acp-confirm-dialog', () => {
  it('names its actions and sits at the top when asked', async () => {
    const el = await fixture(html`<acp-confirm-dialog></acp-confirm-dialog>`);
    const answer = el.confirm({
      headline: 'Trust?',
      message: 'Runs things',
      confirmLabel: 'Trust',
      cancelLabel: 'Not now',
      placement: 'top',
    });
    await el.updateComplete;
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const actions = [...root.querySelectorAll('.acp-confirm-dialog__action')].map((a) => a.textContent?.trim());
    expect(actions).to.deep.equal(['Not now', 'Trust']);
    expect(root.querySelector('.acp-confirm-dialog__dialog_top')).not.to.equal(null);
    /** @type {HTMLElement} */ (root.querySelectorAll('.acp-confirm-dialog__action')[1]).click();
    expect(await answer).to.equal(true);
  });

  it('answers no when closed from outside', async () => {
    const el = await fixture(html`<acp-confirm-dialog></acp-confirm-dialog>`);
    const answer = el.confirm({ headline: 'Q', message: 'M' });
    await el.updateComplete;
    el.close();
    expect(await answer).to.equal(false);
  });

  it('offers a third action and says which one was chosen', async () => {
    const el = await fixture(html`<acp-confirm-dialog></acp-confirm-dialog>`);
    const options = { headline: 'Q', message: 'M', confirmLabel: 'Overwrite', extraLabel: 'Reload' };
    let answer = el.choose(options);
    await el.updateComplete;
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const actions = () => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.acp-confirm-dialog__action')]);
    expect(actions().map((a) => a.textContent?.trim())).to.deep.equal(['Cancel', 'Reload', 'Overwrite']);
    actions()[1].click();
    expect(await answer).to.equal('extra');
    answer = el.choose(options);
    await el.updateComplete;
    el.close();
    expect(await answer).to.equal('cancel');
    const confirmed = el.confirm({ headline: 'Q', message: 'M' });
    await el.updateComplete;
    expect(actions().length, 'no third action unless asked').to.equal(2);
    actions()[1].click();
    expect(await confirmed).to.equal(true);
  });
});
