import { expect } from '@esm-bundle/chai';
import { chat } from '../chat.js';

describe('chat thoughts', () => {
  it('takes a bold first line as the title and shows elapsed time from one second', () => {
    expect(chat.splitThought('**Checking the pin**\n\nLooking at it.')).to.deep.equal({ title: 'Checking the pin', body: 'Looking at it.' });
    expect(chat.splitThought('No title **here**'), 'no leading bold').to.deep.equal({ title: '', body: 'No title **here**' });
    /** @type {[number, string][]} */
    const cases = [[999, ''], [12_000, '12s'], [60_000, '1m 0s'], [125_000, '2m 5s']];
    for (const [ms, text] of cases) expect(chat.formatElapsed(ms), `${ms}ms`).to.equal(text);
  });
});
