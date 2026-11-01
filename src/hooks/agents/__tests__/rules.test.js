import { expect } from '@esm-bundle/chai';
import { agentBrandOf, commandLine, isAgentsFile, isUserAgentsFile, ownSignIns, parseCommandLine, signInAfterAdd, trustConfirm } from '../rules.js';

/** @typedef {import('../types.js').SignInMethod} SignInMethod */
/** @typedef {import('../types.js').UntrustedAgent} UntrustedAgent */

/**
 * @param {string} id
 * @param {SignInMethod['apiKey']} [apiKey]
 * @returns {SignInMethod}
 */
const method = (id, apiKey = null) => ({ id, name: id, description: null, kind: 'agent', label: null, apiKey });

/**
 * @param {Record<string, string>} env
 * @returns {UntrustedAgent}
 */
const untrusted = (env) => ({ name: 'Repo', launch: { agentId: 'repo', command: './run', args: [], env, mcpServers: [] } });

describe('agents: rules', () => {
  it('knows the brand of an agent by its id or name', () => {
    const cases = [
      // [id, name, brand]
      ['claude-code', 'Claude Code', 'claude'],
      ['claude-acp', null, 'claude'],
      ['codex-acp', 'Codex CLI', 'codex'],
      ['github-copilot-cli', 'Copilot', 'copilot'],
      ['antigravity-acp', 'Google Antigravity', 'antigravity'],
      ['mine', 'My Claude', 'claude'],
      ['a', 'Something else', null],
    ];
    for (const [id, name, brand] of cases) {
      // Act
      const result = agentBrandOf(/** @type {string} */ (id), name);
      // Assert
      expect(result, `${id} / ${name}`).to.equal(brand);
    }
  });

  it('reads a typed command line as a shell would, and writes one that reads back the same', () => {
    const typed = [
      // [line, command, args]
      ['', '', []],
      ['  npx   -y @zed/claude-code-acp ', 'npx', ['-y', '@zed/claude-code-acp']],
      [`run --name "my agent" --flag='a b' x`, 'run', ['--name', 'my agent', '--flag=a b', 'x']],
      [`a\\ b ""`, 'a b', ['']],
    ];
    for (const [line, command, args] of typed) {
      // Act + Assert
      expect(parseCommandLine(/** @type {string} */ (line)), JSON.stringify(line)).to.deep.equal({ command, args });
    }
    // Act
    const plain = commandLine('npx', ['-y', '@google/gemini-cli', '--acp']);
    const quoted = commandLine('/Apps/My Agent/run', ['--name', "it's a b", '']);
    // Assert
    expect(plain, 'no quotes where none are needed').to.equal('npx -y @google/gemini-cli --acp');
    expect(quoted).to.equal(`'/Apps/My Agent/run' --name 'it'\\''s a b' ''`);
    expect(parseCommandLine(quoted)).to.deep.equal({ command: '/Apps/My Agent/run', args: ['--name', "it's a b", ''] });
  });

  it('signs in from here with every method but an API key, also right after adding an agent', () => {
    // Arrange
    const key = method('key', { provider: 'openai' });
    // Act + Assert
    expect(ownSignIns([method('browser'), key]).map((m) => m.id)).to.deep.equal(['browser']);
    expect(signInAfterAdd([]), 'options: signed in').to.equal(null);
    expect(signInAfterAdd({ signIn: [method('browser'), key] }), 'its one method').to.deep.equal({ methodId: 'browser' });
    expect(signInAfterAdd({ signIn: [method('browser'), method('device')] }), 'its row offers them').to.deep.equal({ methodId: null });
    expect(signInAfterAdd({ signIn: [key] }), 'only Retry').to.deep.equal({ methodId: null });
  });

  it("tells a project's and the user's agents.json from other files", () => {
    const cases = [
      // [path, agents file, the user's]
      ['/work/demo/.brama/agents.json', true, false],
      ['C:\\work\\demo\\.brama\\agents.json', true, false],
      ['/Users/me/Library/Application Support/brama/agents.json', true, true],
      ['/work/demo/agents.json', false, false],
      ['/work/demo/.brama/workspace.json', false, false],
    ];
    for (const [path, agents, user] of cases) {
      // Act + Assert
      expect(isAgentsFile(/** @type {string} */ (path)), `${path}`).to.equal(agents);
      expect(isUserAgentsFile(/** @type {string} */ (path)), `${path}: the user's`).to.equal(user);
    }
  });

  it('asks to trust a project at the top of the window, naming it and the keychain items its agents read', () => {
    // Arrange
    const plain = untrusted({ TOKEN: '${env:TOKEN}' });
    const secret = untrusted({ A: '${keychain:openai}', B: 'x-${keychain:github}-${env:HOME}' });
    // Act
    const options = trustConfirm({ projectPath: '/work/demo', agents: [plain] });
    const withSecrets = trustConfirm({ projectPath: '/work/demo', agents: [plain, secret, secret] });
    // Assert
    expect(options).to.include({ headline: 'Trust this project?', confirmLabel: 'Trust project', cancelLabel: 'Not now', placement: 'top' });
    expect(options.message).to.equal('Brama provides features that may run potentially malicious code from "demo".');
    expect(options.detail).to.equal("If you don't trust the source, choose Not now to only browse its code: its agents won't start.");
    expect(withSecrets.detail, 'each item once').to.equal(
      "Its agents would read these keychain items: openai, github. If you don't trust the source, choose Not now to only browse its code: its agents won't start.",
    );
  });
});
