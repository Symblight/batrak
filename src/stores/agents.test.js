import { expect } from '@esm-bundle/chai';
import { $agentsPending, whileUpdating } from './agents.js';

describe('agents', () => {
  it('shows agents as updating while their call runs, a failed one too', async () => {
    /** @type {(value: string) => void} */
    let finish = () => {};
    const first = whileUpdating(['a'], () => new Promise((resolve) => (finish = resolve)));
    const second = whileUpdating(['a', 'b'], () => Promise.reject(new Error('npm')));
    await second.catch(() => {});
    expect($agentsPending.get().updating, 'the first call still runs').to.deep.equal(['a']);
    finish('done');
    expect(await first).to.equal('done');
    expect($agentsPending.get().updating).to.deep.equal([]);
  });
});
