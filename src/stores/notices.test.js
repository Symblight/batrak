import { expect } from '@esm-bundle/chai';
import { $notices, dismissNotice, notify, runNoticeAction } from './notices.js';

describe('notices', () => {
  afterEach(() => {
    for (const notice of $notices.get()) dismissNotice(notice.id);
  });

  it('runs a notice’s action once, then dismisses it', () => {
    let undone = 0;
    notify('info', 'Gemini CLI removed', { action: { label: 'Undo', run: () => undone++ } });
    const [notice] = $notices.get();
    expect(notice.action?.label).to.equal('Undo');
    runNoticeAction(notice.id);
    runNoticeAction(notice.id);
    expect(undone).to.equal(1);
    expect($notices.get()).to.deep.equal([]);
  });

  it('keeps a notice for the time it asks for', async () => {
    notify('info', 'short', { timeout: 10 });
    expect($notices.get()).to.have.length(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect($notices.get()).to.deep.equal([]);
  });
});
