import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { actions } from '../actions.js';
import { $notices } from '../../../stores/notices/notices.js';
import { applyAgentOptions, composerOf } from '../../../stores/composer/composer.js';
import { $sessionNotices, $permissionRequests, addPermissionRequest, clearPermissionRequests } from '../../../stores/session-runtime/session-runtime.js';
import { $sessions } from '../../../stores/sessions/sessions.js';

/** @typedef {import('../types.js').Session} Session */

/** @param {Partial<Session>} [fields] */
function session(fields = {}) {
  return /** @type {Session} */ ({ id: 's1', projectId: '/p', title: 'Old', agentId: 'actions-test-agent', status: 'idle', folder: '/p', lastActivityAt: '', mode: 'local', branch: null, ...fields });
}

// The composer keeps the last picks and an agent's options in localStorage per agent id, and another test file
// that uses the same agent can read them: these tests use an agent id of their own.
describe('session actions', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string) => unknown} */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      const value = answer(cmd);
      if (value instanceof Error) throw value;
      return value;
    });
    $sessions.set([session()]);
    $notices.set([]);
  });

  afterEach(() => {
    $sessions.set([]);
    $notices.set([]);
    clearMocks();
  });

  const sent = (/** @type {string} */ cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it('passes a stop, a restart, an answer to a permission request and Open log to the backend; a restart says it is starting', async () => {
    actions.stop('s1');
    actions.respondPermission('s1', 'r1', 'allow');
    actions.respondPermission('s1', 'r2', null);
    actions.openLog('s1');
    actions.restart('s1');
    await tick();
    expect(sent('session_stop')).to.deep.equal([{ sessionId: 's1' }]);
    expect(sent('session_respond_permission')).to.deep.equal([
      { sessionId: 's1', requestId: 'r1', optionId: 'allow' },
      { sessionId: 's1', requestId: 'r2', optionId: null },
    ]);
    expect(sent('session_open_log')).to.deep.equal([{ sessionId: 's1' }]);
    expect(sent('session_restart')).to.deep.equal([{ sessionId: 's1' }]);
    expect($sessionNotices.get().s1).to.deep.include({ kind: 'progress', message: 'Starting agent…' });
    expect($permissionRequests.get().s1 ?? [], 'the answered requests are gone').to.deep.equal([]);
  });

  it("stops one subagent, dropping only its permission requests, which the backend answers", async () => {
    // Arrange
    addPermissionRequest('s1', { requestId: 'r1', toolCallId: null, title: 'Read', options: [], subagentId: 'c1' });
    addPermissionRequest('s1', { requestId: 'r2', toolCallId: null, title: 'Edit', options: [] });
    try {
      // Act
      actions.cancelSubagent('s1', 'c1');
      await tick();
      // Assert
      expect(sent('session_cancel_subagent')).to.deep.equal([{ sessionId: 's1', subagentId: 'c1' }]);
      expect($permissionRequests.get().s1?.map((r) => r.requestId)).to.deep.equal(['r2']);
    } finally {
      clearPermissionRequests('s1');
    }
  });

  it('keeps a subagent\'s permission requests to answer when stopping it fails', async () => {
    // Arrange
    answer = (cmd) => (cmd === 'session_cancel_subagent' ? new Error('the agent is not running') : null);
    addPermissionRequest('s1', { requestId: 'r1', toolCallId: null, title: 'Read', options: [], subagentId: 'c1' });
    try {
      // Act
      actions.cancelSubagent('s1', 'c1');
      await tick();
      // Assert
      expect($permissionRequests.get().s1?.map((r) => r.requestId)).to.deep.equal(['r1']);
      expect($notices.get().map((n) => n.level)).to.include('error');
    } finally {
      clearPermissionRequests('s1');
    }
  });

  it('shows a failed stop as a notice instead of throwing', async () => {
    answer = (cmd) => (cmd === 'session_stop' ? new Error('no such agent') : null);
    actions.stop('s1');
    await tick();
    expect($notices.get().map((n) => n.level)).to.include('error');
  });

  it('renames with the trimmed title, ignoring a blank or unchanged one and a session that is gone', async () => {
    answer = (cmd) => (cmd === 'session_rename' ? session({ title: 'New title' }) : null);
    await actions.rename('s1', '   ');
    await actions.rename('s1', 'Old');
    await actions.rename('gone', 'Anything');
    expect(sent('session_rename'), 'nothing asked').to.deep.equal([]);
    await actions.rename('s1', '  New title ');
    expect(sent('session_rename')).to.deep.equal([{ sessionId: 's1', title: 'New title' }]);
    expect($sessions.get()[0].title, 'the answer replaces the session').to.equal('New title');
    answer = (cmd) => (cmd === 'session_reset_title' ? session({ title: 'Agent’s' }) : null);
    await actions.resetTitle('s1');
    expect($sessions.get()[0].title).to.equal('Agent’s');
  });

  it('sends a config pick to a running agent only, and takes a refused pick back', async () => {
    actions.setConfigOption('s1', 'model', 'opus');
    await tick();
    expect(sent('session_set_config_option')).to.deep.equal([{ sessionId: 's1', configId: 'model', value: 'opus' }]);
    expect(composerOf('s1').chosen.model, 'shown at once').to.equal('opus');

    $sessions.set([session({ status: 'stopped' })]);
    actions.setConfigOption('s1', 'model', 'haiku');
    await tick();
    expect(sent('session_set_config_option'), 'a stopped agent gets it when it starts').to.have.length(1);
    expect(composerOf('s1').chosen.model).to.equal('haiku');

    $sessions.set([session()]);
    applyAgentOptions('s1', [
      { id: 'thought_level', name: 'Thought', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    ]);
    answer = (cmd) => (cmd === 'session_set_config_option' ? new Error('refused') : null);
    actions.setConfigOption('s1', 'thought_level', 'high');
    await tick();
    expect(composerOf('s1').chosen.thought_level, 'taken back').to.equal(undefined);
    expect(composerOf('s1').configOptions.find((o) => o.id === 'thought_level')?.currentValue).to.equal('low');
    expect($notices.get().length).to.be.greaterThan(0);
  });

  it('says what applying a worktree session locally did, and what checking out its branch did', async () => {
    $sessions.set([session({ title: 'Fix tabs', branch: 'brama/fix-1', mode: 'worktree' })]);
    /** @type {[unknown, string, string][]} */
    const cases = [
      [{ outcome: 'applied', conflicts: [] }, 'info', 'Applied "Fix tabs" to the project, unstaged'],
      [{ outcome: 'empty', conflicts: [] }, 'info', '"Fix tabs" has no changes to apply'],
      [{ outcome: 'conflicts', conflicts: ['a.js', 'b.js'] }, 'warn', 'Applied "Fix tabs" with conflicts in a.js, b.js'],
    ];
    for (const [result, level, message] of cases) {
      $notices.set([]);
      answer = (cmd) => (cmd === 'session_apply_locally' ? result : null);
      await actions.applyLocally('s1');
      expect([$notices.get()[0]?.level, $notices.get()[0]?.message], message).to.deep.equal([level, message]);
    }
    $notices.set([]);
    await actions.checkOutBranch('s1');
    expect($notices.get()[0]?.message).to.equal('Checked out brama/fix-1');
    $notices.set([]);
    answer = (cmd) => (cmd === 'session_check_out_branch' ? new Error('dirty worktree') : null);
    await actions.checkOutBranch('s1');
    expect($notices.get()[0]?.level).to.equal('error');
  });
});
