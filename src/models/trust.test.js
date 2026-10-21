import { expect } from '@esm-bundle/chai';
import { trustConfirm, trustKey } from './trust.js';

/** @typedef {import('./types.js').UntrustedAgent} UntrustedAgent */

/** @type {UntrustedAgent} */
const REPO = {
  name: 'Repo',
  launch: { agentId: 'repo', command: './run-agent', args: ['--acp'], env: { TOKEN: '${env:TOKEN}' }, mcpServers: [] },
};
/** @type {UntrustedAgent} */
const OTHER = {
  name: 'Other',
  launch: { agentId: 'other', command: 'npx', args: ['other'], env: {}, mcpServers: [{ name: 'docs' }, { name: 'db' }] },
};

describe('trust', () => {
  it('asks at the top of the window, naming the project but not what its agents run', () => {
    const options = trustConfirm({ projectPath: '/work/demo', agents: [REPO, OTHER] });
    expect(options).to.include({ headline: 'Trust this project?', confirmLabel: 'Trust project', cancelLabel: 'Not now', placement: 'top' });
    expect(options.message).to.equal('Brama provides features that may run potentially malicious code from "demo".');
    expect(options.detail).to.equal("If you don't trust the source, choose Not now to only browse its code: its agents won't start.");
    expect(options).not.to.have.property('items');
  });

  it('names the keychain items the agents would read', () => {
    /** @type {UntrustedAgent} */
    const secret = {
      name: 'Codex',
      launch: { agentId: 'codex', command: 'npx', args: [], env: { A: '${keychain:openai}', B: 'x-${keychain:github}-${env:HOME}' }, mcpServers: [] },
    };
    const options = trustConfirm({ projectPath: '/work/demo', agents: [REPO, secret, { ...secret, name: 'Again' }] });
    expect(options.detail).to.equal(
      "Its agents would read these keychain items: openai, github. If you don't trust the source, choose Not now to only browse its code: its agents won't start.",
    );
  });

  it('keys a prompt by its project and launches, so a changed launch asks again', () => {
    const key = trustKey({ projectPath: '/p', agents: [REPO] });
    expect(trustKey({ projectPath: '/p', agents: [REPO] })).to.equal(key);
    expect(trustKey({ projectPath: '/q', agents: [REPO] })).not.to.equal(key);
    const changed = { ...REPO, launch: { ...REPO.launch, command: './other' } };
    expect(trustKey({ projectPath: '/p', agents: [changed] })).not.to.equal(key);
  });
});
