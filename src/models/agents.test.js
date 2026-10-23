import { expect } from '@esm-bundle/chai';
import { commandLine, glyphOf, ownSignIns, parseCommandLine, signInAfterAdd, splitArgs } from './agents.js';

/** @typedef {import('./types.js').SignInMethod} SignInMethod */

/**
 * @param {string} id
 * @param {SignInMethod['apiKey']} [apiKey]
 * @returns {SignInMethod}
 */
const method = (id, apiKey = null) => ({ id, name: id, description: null, kind: 'agent', label: null, apiKey });

describe('agents', () => {
  it('makes a glyph of one or two letters', () => {
    expect(glyphOf('Claude Code')).to.equal('CC');
    expect(glyphOf('gemini-cli')).to.equal('GC');
    expect(glyphOf('codex')).to.equal('CO');
  });

  it('splits arguments as a shell would, quotes kept together', () => {
    expect(splitArgs('')).to.deep.equal([]);
    expect(splitArgs('  -y   @zed/claude-code-acp ')).to.deep.equal(['-y', '@zed/claude-code-acp']);
    expect(splitArgs(`--name "my agent" --flag='a b' x`)).to.deep.equal(['--name', 'my agent', '--flag=a b', 'x']);
    expect(splitArgs(`a\\ b ""`)).to.deep.equal(['a b', '']);
  });

  it('writes a command line a shell would split back the same', () => {
    expect(commandLine('npx', ['-y', '@google/gemini-cli', '--acp'])).to.equal('npx -y @google/gemini-cli --acp');
    expect(commandLine('/Apps/My Agent/run', ['--name', 'a b', "it's", ''])).to.equal(`'/Apps/My Agent/run' --name 'a b' 'it'\\''s' ''`);
    const line = commandLine('my agent', ['--x', "it's a b", '']);
    expect(parseCommandLine(line)).to.deep.equal({ command: 'my agent', args: ['--x', "it's a b", ''] });
    expect(parseCommandLine('  ')).to.deep.equal({ command: '', args: [] });
  });

  it('signs in from here with every method but an API key', () => {
    expect(ownSignIns([method('browser'), method('key', { provider: 'openai' })]).map((m) => m.id)).to.deep.equal(['browser']);
  });

  it('says how to sign in to an agent just added, from what its probe learned', () => {
    expect(signInAfterAdd([]), 'options: signed in').to.equal(null);
    expect(signInAfterAdd({ signIn: [method('browser'), method('key', { provider: null })] })).to.deep.equal({ methodId: 'browser' });
    expect(signInAfterAdd({ signIn: [method('browser'), method('device')] }), 'its row offers them').to.deep.equal({ methodId: null });
    expect(signInAfterAdd({ signIn: [method('key', { provider: null })] }), 'only Retry').to.deep.equal({ methodId: null });
  });
});
