import { expect } from '@esm-bundle/chai';
import { $agentList } from '../../agents/agents.js';
import { $activeView, $agentViews, $sessionViews, forgetSessionView, setAgentView, setSessionView, viewOfSession } from '../session-views.js';
import { $activeSessionId, $sessions } from '../../sessions/sessions.js';

/** @typedef {import('../../../models/types/types.js').Session} Session */
/** @typedef {import('../../../models/types/types.js').AgentSummary} AgentSummary */

/** @param {string} id */
function session(id) {
  return /** @type {Session} */ ({ id, projectId: '/p', title: id, agentId: 'claude', agentName: 'Claude Code', status: 'stopped', lastActivityAt: '' });
}

/** @param {AgentSummary['terminal']} terminal */
function agents(terminal) {
  $agentList.set({ ...$agentList.get(), agents: [/** @type {AgentSummary} */ ({ id: 'claude', name: 'Claude Code', terminal })] });
}

describe('session-views', () => {
  beforeEach(() => {
    $sessions.set([session('a'), session('b')]);
    agents({ resume: true, new: true });
  });

  afterEach(() => {
    for (const id of Object.keys($sessionViews.get())) forgetSessionView(id);
    $agentViews.set({});
    $activeSessionId.set(null);
    $sessions.set([]);
    $agentList.set({ ...$agentList.get(), agents: [] });
  });

  it('keeps each session\'s own view, and forgets one that is its agent\'s', () => {
    setSessionView('a', 'terminal');
    expect($sessionViews.get()).to.deep.equal({ a: 'terminal' });
    expect(viewOfSession('a')).to.equal('terminal');
    expect(viewOfSession('b')).to.equal('chat');

    setSessionView('a', 'chat');
    expect($sessionViews.get()).to.deep.equal({});

    setAgentView('claude', 'terminal');
    expect(viewOfSession('b'), 'its agent\'s').to.equal('terminal');
    setSessionView('b', 'chat');
    expect($sessionViews.get()).to.deep.equal({ b: 'chat' });
  });

  it('keeps only agents whose sessions open in the terminal', () => {
    setAgentView('claude', 'terminal');
    expect($agentViews.get()).to.deep.equal({ claude: 'terminal' });
    setAgentView('claude', 'chat');
    expect($agentViews.get()).to.deep.equal({});
  });

  it('drops a removed session\'s view', () => {
    setSessionView('a', 'terminal');
    forgetSessionView('a');
    expect($sessionViews.get()).to.deep.equal({});
  });

  it('shows the active session\'s view, chat for an agent without a CLI', () => {
    setSessionView('a', 'terminal');
    $activeSessionId.set('a');
    expect($activeView.get()).to.deep.equal({ view: 'terminal', disabled: '' });

    agents(null);
    expect($activeView.get()).to.deep.equal({ view: 'chat', disabled: 'Claude Code has no terminal mode' });
  });
});
