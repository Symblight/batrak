import { computed } from 'nanostores';
import { isRecord, persistentMapStore, persistentStore } from '../persistent/persistent.js';
import { $agentList } from '../agents/agents.js';
import { $composer, composerOf } from '../composer/composer.js';
import { $cliStarting, $sessionTerminals } from '../terminals/terminals.js';
import { $activeSession, $activeSessionId, $sessions } from '../sessions/sessions.js';

/** @typedef {import('../../hooks/agents/types.js').AgentTerminal} AgentTerminal */
/** @typedef {import('../../hooks/sessions/types.js').SessionView} SessionView */

/**
 * Whether a session can be shown in its agent's CLI.
 * @param {AgentTerminal | null | undefined} terminal Its agent's (`AgentSummary.terminal`).
 * @param {boolean} draft No message yet: the CLI must start it under an id Batrak chooses.
 */
export function canUseTerminal(terminal, draft) {
  return terminal != null && (draft ? terminal.new : terminal.resume);
}

/**
 * How a session is shown: its own view, else its agent's; always `chat` when its agent's CLI can't
 * show it.
 * @param {SessionView | undefined} own The session's own (`$sessionViews`).
 * @param {SessionView} preferred Its agent's (`$agentViews`).
 * @param {AgentTerminal | null | undefined} terminal Its agent's.
 * @param {boolean} draft
 * @returns {SessionView}
 */
export function viewOf(own, preferred, terminal, draft) {
  return canUseTerminal(terminal, draft) ? (own ?? preferred) : 'chat';
}

/**
 * The session's own view to keep for a choice: none when it's its agent's, so a later change of
 * the agent's applies to it again.
 * @param {SessionView} view
 * @param {SessionView} preferred
 * @returns {SessionView | undefined}
 */
export function ownView(view, preferred) {
  return view === preferred ? undefined : view;
}

/**
 * Why the header's Chat / Terminal button is disabled for a session; `''` when it isn't.
 * @param {AgentTerminal | null | undefined} terminal
 * @param {boolean} draft
 * @param {string} agentName
 */
export function viewDisabledReason(terminal, draft, agentName) {
  if (terminal == null) return `${agentName} has no terminal mode`;
  if (!canUseTerminal(terminal, draft)) return draft ? 'Send a first message, then continue in the terminal' : `${agentName} can't continue this session in its terminal`;
  return '';
}

/**
 * @param {unknown} raw
 * @returns {SessionView | null}
 */
function parseView(raw) {
  return raw === 'chat' || raw === 'terminal' ? raw : null;
}

/**
 * Each session's own view, by session id; a session without one is shown as its agent's
 * (`$agentViews`).
 */
export const $sessionViews = persistentMapStore('batrak:sessions:view:', parseView);

/**
 * The agents whose sessions open in the terminal (the Agents tab's toggle), by agent id; the rest
 * open as Chat.
 * @type {import('nanostores').WritableAtom<Record<string, 'terminal'>>}
 */
export const $agentViews = persistentStore('batrak:agents:session-view', {}, {
  parse: (raw) =>
    isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter((entry) => entry[1] === 'terminal').map(([id]) => [id, 'terminal'])) : null,
});

/**
 * @param {string | null} agentId
 * @returns {SessionView}
 */
function agentView(agentId) {
  return (agentId !== null && $agentViews.get()[agentId]) || 'chat';
}

/**
 * Whether new and not yet switched sessions of an agent open in the terminal.
 * @param {string} agentId
 * @param {SessionView} view
 */
export function setAgentView(agentId, view) {
  const { [agentId]: _, ...rest } = $agentViews.get();
  $agentViews.set(view === 'terminal' ? { ...rest, [agentId]: 'terminal' } : rest);
}

/**
 * What an agent's CLI can do.
 * @param {string | null} agentId
 * @returns {AgentTerminal | null}
 */
function terminalOf(agentId) {
  return $agentList.get().agents.find((a) => a.id === agentId)?.terminal ?? null;
}

/**
 * How a session is to be shown (a draft too): its own view, else its agent's, if its agent's CLI can
 * show it.
 * @param {string} id
 * @returns {SessionView}
 */
export function viewOfSession(id) {
  const session = $sessions.get().find((s) => s.id === id);
  const agentId = session ? session.agentId : composerOf(id).agentId;
  return viewOf($sessionViews.get()[id], agentView(agentId), terminalOf(agentId), session === undefined);
}

/**
 * Keeps a session's own view; none when it's its agent's.
 * @param {string} id
 * @param {SessionView} view
 */
export function setSessionView(id, view) {
  const agentId = $sessions.get().find((s) => s.id === id)?.agentId ?? composerOf(id).agentId;
  $sessionViews.setKey(id, ownView(view, agentView(agentId)));
}

/** @param {string} id A removed session's. */
export function forgetSessionView(id) {
  $sessionViews.setKey(id, undefined);
}

/**
 * How the active session is shown now: in the terminal while its CLI runs, has ended (Restart is
 * there) or starts, else as Chat, whatever its view asks for (the `sessions` hook reconciles the two).
 * @type {import('nanostores').ReadableAtom<SessionView>}
 */
export const $activeShownView = computed([$activeSessionId, $sessionTerminals, $cliStarting], (id, terminals, starting) =>
  id !== null && (id in terminals || starting.includes(id)) ? 'terminal' : 'chat',
);

/**
 * The active session's view, and why the header can't switch it (`''` when it can).
 * @type {import('nanostores').ReadableAtom<{ view: SessionView, disabled: string }>}
 */
export const $activeView = computed(
  [$sessionViews, $agentViews, $activeSessionId, $activeSession, $agentList, $composer],
  (views, agentViews, id, session, agents, composer) => {
    /** @type {SessionView} */
    const chat = 'chat';
    if (id === null) return { view: chat, disabled: '' };
    const draft = session === null;
    const agentId = session?.agentId ?? composer.agentId;
    const terminal = terminalOf(agentId);
    const name = session?.agentName ?? agents.agents.find((a) => a.id === agentId)?.name ?? 'This agent';
    return {
      view: viewOf(views[id], (agentId !== null && agentViews[agentId]) || 'chat', terminal, draft),
      disabled: viewDisabledReason(terminal, draft, name),
    };
  },
);
