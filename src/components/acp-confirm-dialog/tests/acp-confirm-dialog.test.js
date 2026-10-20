import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-confirm-dialog.js';

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
});
