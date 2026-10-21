import { expect } from '@esm-bundle/chai';
import { agentStatus, commandLine, glyphOf, parseCommandLine, splitArgs } from './agents.js';

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

  it('says whether an agent has run, or has not yet', () => {
    expect(agentStatus({ id: 'a', name: 'A', scope: 'user', version: '1.0.0', command: 'a', args: [] })).to.deep.equal({
      kind: 'ready',
      label: 'Ready',
    });
    expect(agentStatus({ id: 'a', name: 'A', scope: 'user', version: null, command: 'a', args: [] })).to.deep.equal({
      kind: 'unknown',
      label: 'Not started yet',
    });
  });
});
