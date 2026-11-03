import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $agentList, $agentsView } from '../../../stores/agents/agents.js';
import { $notices, dismissNotice, runNoticeAction } from '../../../stores/notices/notices.js';
import { $awaitingTrust, $trustPrompt } from '../../../stores/trust/trust.js';
import { $draftSessions } from '../../../stores/sessions/sessions.js';
import { $project } from '../../../stores/project/project.js';

/** @typedef {import('../types.js').UntrustedAgent} UntrustedAgent */

/** @type {{ cmd: string, args: Record<string, unknown> }[]} */
let calls;
/** @type {Record<string, (args: Record<string, unknown>) => unknown>} Answers by command, over an empty project's; others get `null`. */
let answers;
let counter = 0;
/** @type {(() => void) | null} */
let stop = null;

/**
 * A fresh copy of the hook (its state is module-level), started.
 * @returns {Promise<typeof import('../agents.js').agents>}
 */
async function started() {
  const { agents } = await import(`../agents.js?fresh=${++counter}`);
  stop = agents.start();
  return agents;
}

const sent = (/** @type {string} */ cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** @param {string} path */
const open = (path) => $project.set({ path, name: path.split('/').pop() ?? path, rootId: `root:${path}` });

/** @param {string} id An agent id unique to the test: an agent's options are cached across tests. */
const unique = (id) => `${id}-${counter}`;

describe('agents', () => {
  beforeEach(() => {
    calls = [];
    answers = {
      agents_list: () => ({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] }),
      agents_view: () => ({ installed: [] }),
      agents_untrusted: () => [],
    };
    $project.set(null);
    $trustPrompt.set(null);
    $awaitingTrust.set([]);
    mockIPC(
      (cmd, args) => {
        const a = /** @type {Record<string, unknown>} */ (args ?? {});
        calls.push({ cmd, args: a });
        return answers[cmd]?.(a) ?? null;
      },
      { shouldMockEvents: true },
    );
  });
  afterEach(() => {
    stop?.();
    stop = null;
    clearMocks();
    $project.set(null);
    for (const notice of $notices.get()) dismissNotice(notice.id);
  });

  it("follows the open project: its agents and the Agents tab, again when its or the user's agents.json changes", async () => {
    // Arrange
    answers.agents_list = ({ projectPath }) => ({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [], projectPath });
    answers.agents_view = ({ projectPath }) => ({ projectPath, installed: [] });
    await started();
    // Act
    open('/work/a');
    await until(() => sent('agents_view').length === 2);
    await emit('agents://changed', { projectPath: '/work/other' });
    await emit('agents://changed', { projectPath: null });
    await emit('agents://changed', { projectPath: '/work/a' });
    await until(() => sent('agents_view').length === 4);
    // Assert
    expect(sent('agents_list').map((a) => a.projectPath), 'no project, the project, then each change of its own').to.deep.equal([
      null,
      '/work/a',
      '/work/a',
      '/work/a',
    ]);
    expect(/** @type {{ projectPath?: string }} */ ($agentList.get()).projectPath).to.equal('/work/a');
    expect(/** @type {{ projectPath?: string } | null} */ ($agentsView.get())?.projectPath).to.equal('/work/a');
  });

  it('asks each agent with no known options for them once, one at a time; a pick joins its probe', async () => {
    // Arrange
    const [a, b] = [unique('a'), unique('b')];
    /** @type {Map<string, (options: unknown) => void>} */
    const held = new Map();
    answers.agents_list = () => ({ agents: [{ id: a, name: 'A' }, { id: b, name: 'B' }], defaultAgent: null, known: [], userAgents: [], errors: [] });
    answers.agents_probe_options = ({ agentId }) => new Promise((resolve) => held.set(/** @type {string} */ (agentId), resolve));
    const agents = await started();
    // Act
    await until(() => held.size > 0);
    const waiting = held.size;
    const picked = agents.loadOptions(a);
    /** @type {(options: unknown) => void} */ (held.get(a))([]);
    await until(() => held.size === 2);
    /** @type {(options: unknown) => void} */ (held.get(b))(null);
    // Assert
    expect(waiting, 'b waits for a').to.equal(1);
    expect(await picked, "the pick gets the running probe's answer").to.deep.equal([]);
    await until(() => sent('agents_list').length >= 2);
    expect(sent('agents_probe_options').map((p) => p.agentId), 'each once, b after a').to.deep.equal([a, b]);
  });

  it('removes an agent at once, with Undo on the notice that says so', async () => {
    // Arrange
    const codex = unique('codex');
    answers.agents_list = () => ({ agents: [{ id: codex, name: 'Codex' }], defaultAgent: null, known: [], userAgents: [], errors: [] });
    answers.agents_probe_options = () => [];
    answers.agents_remove = () => ({ token: 7 });
    const agents = await started();
    open('/work/a');
    await until(() => $agentList.get().agents.length === 1);
    // Act
    await agents.remove(codex);
    await until(() => sent('agents_list').length >= 3); // the probe's reload
    const notice = $notices.get().find((n) => n.message === 'Codex removed');
    runNoticeAction(/** @type {number} */ (notice?.id));
    // Assert
    expect(sent('agents_remove')).to.deep.equal([{ projectPath: '/work/a', agentId: codex }]);
    expect(notice?.action?.label).to.equal('Undo');
    await until(() => sent('agents_restore').length === 1);
    expect(sent('agents_restore')).to.deep.equal([{ token: 7 }]);
  });

  it('says an agent was added, offering its sign-in when its probe asks for one', async () => {
    // Arrange
    const id = unique('claude');
    const browser = { id: 'browser', name: 'Browser', description: null, kind: 'agent', label: null, apiKey: null };
    answers.agents_add = () => id;
    answers.agents_probe_options = () => ({ signIn: [browser] });
    const agents = await started();
    open('/work/a');
    // Act
    const added = await agents.add({ name: 'Claude', known: 'claude-acp' });
    await until(() => $notices.get().some((n) => n.message.startsWith(id)));
    const notice = $notices.get().find((n) => n.message.startsWith(id));
    runNoticeAction(/** @type {number} */ (notice?.id));
    // Assert
    expect(added).to.equal(id);
    expect(notice?.message).to.equal(`${id} added · Sign in to use it`);
    await until(() => sent('agents_sign_in').length === 1);
    expect(sent('agents_sign_in')).to.deep.equal([{ projectPath: '/work/a', agentId: id, methodId: 'browser' }]);
  });

  it('tells how a sign-in went, and reloads the agents when it was this project’s', async () => {
    // Arrange
    await started();
    open('/work/a');
    await until(() => sent('agents_list').length === 2);
    // Act
    await emit('agents://sign-in', { projectPath: '/work/other', agentId: 'x', state: 'done', message: 'Signed in to X', terminal: null });
    await emit('agents://sign-in', { projectPath: '/work/a', agentId: 'x', state: 'done', message: null, terminal: null });
    // Assert
    expect($notices.get().some((n) => n.message === 'Signed in to X')).to.equal(true);
    await until(() => sent('agents_list').length === 3);
    expect(sent('agents_list').length, "only this project's sign-in reloads").to.equal(3);
  });

  describe('trust', () => {
    /** @param {string} command @returns {UntrustedAgent} */
    const runs = (command) => ({ name: 'Repo', launch: { agentId: 'repo', command, args: [], env: {}, mcpServers: [] } });

    it('asks when a project runs what its agents.json chose; Not now holds until that changes or a start is refused', async () => {
      // Arrange
      let command = './run';
      answers.agents_untrusted = () => [runs(command)];
      const agents = await started();
      $draftSessions.set({ s1: '/work/a' });
      // Act
      open('/work/a');
      await until(() => $trustPrompt.get() !== null);
      const asked = $trustPrompt.get();
      agents.dismissTrust();
      await emit('agents://changed', { projectPath: '/work/a' });
      await until(() => sent('agents_untrusted').length === 2);
      await new Promise((r) => setTimeout(r)); // its answer lands
      const afterNotNow = $trustPrompt.get();
      $awaitingTrust.set(['s1']);
      await until(() => $trustPrompt.get() !== null);
      agents.dismissTrust();
      command = './other';
      await emit('agents://changed', { projectPath: '/work/a' });
      // Assert
      expect(asked).to.deep.equal({ projectPath: '/work/a', agents: [runs('./run')] });
      expect(afterNotNow, 'the same launch: not asked again').to.equal(null);
      await until(() => $trustPrompt.get() !== null);
      expect($trustPrompt.get()?.agents, 'a changed launch asks again').to.deep.equal([runs('./other')]);
    });

    it('trusts what it asked about and hands back the sessions it held; a failure asks again', async () => {
      // Arrange
      answers.agents_untrusted = () => [runs('./run')];
      const agents = await started();
      $draftSessions.set({ s1: '/work/a', s2: '/work/b' });
      open('/work/a');
      await until(() => $trustPrompt.get() !== null);
      $awaitingTrust.set(['s2', 's1']);
      // Act
      const restart = await agents.trust();
      await until(() => $trustPrompt.get()?.projectPath === '/work/b');
      answers.agents_trust = () => {
        throw new Error('agents.json changed');
      };
      const none = await agents.trust();
      // Assert
      expect(sent('agents_trust')[0]).to.deep.equal({ projectPath: '/work/a', launches: [runs('./run').launch] });
      expect(restart, "the project's held sessions only").to.deep.equal(['s1']);
      expect(none).to.deep.equal([]);
      await until(() => $trustPrompt.get()?.projectPath === '/work/b');
      expect($awaitingTrust.get(), 'still held').to.deep.equal(['s2']);
    });
  });
});
