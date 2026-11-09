import { expect } from '@esm-bundle/chai';
import { kindVerb, liveLine, past, progressive, rowOf, summaryOf } from '../rules.js';

/** @typedef {import('../../sessions/types.js').ToolCallView} ToolCallView */

/**
 * @param {string} kind
 * @param {Partial<ToolCallView>} [fields]
 * @returns {ToolCallView}
 */
const call = (kind, fields = {}) => ({
  toolCallId: crypto.randomUUID(),
  label: kind,
  command: '',
  kind,
  status: 'completed',
  locations: [],
  error: '',
  diff: null,
  startedAt: null,
  endedAt: null,
  ...fields,
});
/** @param {string} path */
const at = (path) => ({ locations: [{ path }] });

describe('summaryOf', () => {
  it('words each kind with its file when one call names it, else counts, in order of first appearance', () => {
    /** @type {[ToolCallView[], { text: string, path?: string }[]][]} */
    const cases = [
      [[call('read', at('a.rs'))], [{ text: 'Read', path: 'a.rs' }]],
      [[call('read')], [{ text: 'Read 1 file' }]],
      [[call('read', at('a.rs')), call('read', at('b.rs')), call('read', at('a.rs'))], [{ text: 'Read 2 files' }]],
      [[call('edit', at('a.rs'))], [{ text: 'Edited', path: 'a.rs' }]],
      [[call('edit', { ...at('n.md'), diff: { added: 3, removed: 0, created: true } })], [{ text: 'Created', path: 'n.md' }]],
      [[call('edit', at('a.rs')), call('edit', at('b.rs'))], [{ text: 'Edited 2 files' }]],
      [[call('delete', at('a.rs'))], [{ text: 'Deleted', path: 'a.rs' }]],
      [[call('move', at('a.rs')), call('move', at('b.rs'))], [{ text: 'Moved 2 files' }]],
      [[call('search')], [{ text: 'Searched' }]],
      [[call('search'), call('search')], [{ text: 'Searched 2 times' }]],
      [[call('execute')], [{ text: 'Ran a command' }]],
      [[call('execute'), call('execute')], [{ text: 'Ran 2 commands' }]],
      [[call('fetch')], [{ text: 'Fetched a page' }]],
      [[call('fetch'), call('fetch')], [{ text: 'Fetched 2 pages' }]],
      [[call('think'), call('other'), call('switch_mode')], [{ text: 'Used 3 tools' }]],
      [[call('other')], [{ text: 'Used a tool' }]],
      [
        [call('execute'), call('edit', { ...at('AGENTS.md'), diff: { added: 52, removed: 0, created: true } }), call('execute'), call('read')],
        [{ text: 'Ran 2 commands' }, { text: 'created', path: 'AGENTS.md' }, { text: 'read 1 file' }],
      ],
    ];
    for (const [calls, clauses] of cases) {
      // Act
      const summary = summaryOf(calls);
      // Assert
      expect(summary.clauses, JSON.stringify(clauses)).to.deep.equal(clauses);
    }
  });

  it('counts the failed calls and the lines the edits add and remove', () => {
    // Arrange
    const calls = [
      call('execute', { status: 'failed' }),
      call('edit', { ...at('a.rs'), diff: { added: 4, removed: 1, created: false } }),
      call('edit', { ...at('b.rs'), diff: { added: 2, removed: 3, created: false } }),
      call('execute', { status: 'failed' }),
    ];
    // Act
    const { failed, added, removed } = summaryOf(calls);
    // Assert
    expect({ failed, added, removed }).to.deep.equal({ failed: 2, added: 6, removed: 4 });
    expect(summaryOf([call('read')]), 'nothing failed or edited').to.include({ failed: 0, added: 0, removed: 0 });
  });
});

describe('progressive', () => {
  it('puts the verbs of a label in the -ing form, leaving a label that starts with no known verb alone', () => {
    /** @type {[string, string][]} */
    const cases = [
      ['Check for build inputs and try the build script', 'Checking for build inputs and trying the build script'],
      ['List project files', 'Listing project files'],
      ['Run the tests', 'Running the tests'],
      ['Write the config', 'Writing the config'],
      ['Read manifest, HTML, spec and config files', 'Reading manifest, HTML, spec and config files'],
      ['Get status and see what changed', 'Getting status and seeing what changed'],
      ['Grep for TODOs', 'Grepping for TODOs'],
      ['Format the files and run the tests', 'Formatting the files and running the tests'],
      ['git status', 'git status'],
      ['Project files', 'Project files'],
      ['', ''],
    ];
    for (const [label, expected] of cases) {
      // Act + Assert
      expect(progressive(label), label).to.equal(expected);
    }
  });
});

describe('past', () => {
  it('puts the verbs of a label in the past tense, leaving a label that starts with no known verb alone', () => {
    /** @type {[string, string][]} */
    const cases = [
      ['Check for build inputs and try the build script', 'Checked for build inputs and tried the build script'],
      ['List project files', 'Listed project files'],
      ['Run the tests', 'Ran the tests'],
      ['Write the config', 'Wrote the config'],
      ['Read manifest, HTML, spec and config files', 'Read manifest, HTML, spec and config files'],
      ['Get status and see what changed', 'Got status and saw what changed'],
      ['Verify imports and create a file', 'Verified imports and created a file'],
      ['Stop the server and commit', 'Stopped the server and committed'],
      ['Grep for TODOs', 'Grepped for TODOs'],
      ['Deploy the build', 'Deployed the build'],
      ['Format the files and run the tests', 'Formatted the files and ran the tests'],
      ['git status', 'git status'],
      ['', ''],
    ];
    for (const [label, expected] of cases) {
      // Act + Assert
      expect(past(label), label).to.equal(expected);
    }
  });
});

describe('rowOf', () => {
  it('words a call’s row: its file by its kind’s verb, its description in the past tense (-ing while it runs, as asked when it failed or was cancelled), else its label', () => {
    /** @type {[string, ToolCallView, { text: string, path?: string }][]} */
    const cases = [
      ['a read file', call('read', at('src/a.rs')), { text: 'Read', path: 'src/a.rs' }],
      ['an edit', call('edit', at('AGENTS.md')), { text: 'Edited', path: 'AGENTS.md' }],
      ['a new file', call('edit', { ...at('AGENTS.md'), diff: { added: 59, removed: 0, created: true } }), { text: 'Created', path: 'AGENTS.md' }],
      ['an edit running', call('edit', { ...at('AGENTS.md'), status: 'in_progress' }), { text: 'Editing', path: 'AGENTS.md' }],
      ['a described command', call('execute', { label: 'List repo root', command: 'ls' }), { text: 'Listed repo root' }],
      ['one running', call('execute', { label: 'List repo root', command: 'ls', status: 'in_progress' }), { text: 'Listing repo root' }],
      ['a failed command', call('execute', { label: 'Run the tests', command: 'npm test', status: 'failed' }), { text: 'Run the tests' }],
      ['a cancelled edit', call('edit', { ...at('a.rs'), status: 'cancelled' }), { text: 'Edit', path: 'a.rs' }],
      ['a failed new file', call('edit', { ...at('a.rs'), status: 'failed', diff: { added: 1, removed: 0, created: true } }), { text: 'Create', path: 'a.rs' }],
      ['an undescribed call', call('fetch', { label: 'https://example.com' }), { text: 'https://example.com' }],
      ['a read naming no file', call('read', { label: 'Read files' }), { text: 'Read files' }],
    ];
    for (const [name, view, expected] of cases) {
      // Act + Assert
      expect(rowOf(view), name).to.deep.equal(expected);
    }
  });
});

describe('liveLine', () => {
  it('says what runs: the last started call’s label in the -ing form, its kind’s verb when unworded, the waiting one, or nothing', () => {
    /** @type {[string, ToolCallView[], string | null][]} */
    const cases = [
      ['one running', [call('execute', { label: 'Run the tests', command: 'npm test', status: 'in_progress' })], 'Running the tests'],
      [
        'the last started of two',
        [call('execute', { label: 'List files', command: 'ls', status: 'in_progress' }), call('execute', { label: 'Check git', command: 'git status', status: 'pending' })],
        'Checking git',
      ],
      ['unworded', [call('read', { label: 'Read a.rs', status: 'in_progress' })], 'Reading'],
      ['a new file', [call('edit', { label: 'Write n.md', status: 'in_progress', diff: { added: 1, removed: 0, created: true } })], 'Creating'],
      ['waiting', [call('execute', { status: 'in_progress' }), call('edit', { label: 'Edit a.txt', status: 'awaiting-permission' })], 'Waiting for permission: Edit a.txt'],
      ['between calls', [call('execute', { label: 'List files', command: 'ls' }), call('read', { label: 'Read a.rs' })], null],
      ['no calls', [], null],
    ];
    for (const [why, calls, expected] of cases) {
      // Act + Assert
      expect(liveLine(calls), why).to.equal(expected);
    }
  });
});

describe('kindVerb', () => {
  it('names what a call of each kind is doing', () => {
    // Act
    const verbs = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'other'].map((k) => kindVerb(k, false));
    // Assert
    expect(verbs).to.deep.equal(['Reading', 'Editing', 'Deleting', 'Moving', 'Searching', 'Running a command', 'Fetching', 'Working', 'Working']);
    expect(kindVerb('edit', true)).to.equal('Creating');
  });
});
