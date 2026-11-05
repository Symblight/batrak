import { html } from 'lit';
import { agents } from '../../hooks/agents/agents.js';
import { $agentList, $agentsPending, $agentsQuery, $agentsView, $signIns, signInsOf } from '../../stores/agents/agents.js';
import { $agentsReveal, $activePath, AGENTS_TAB_ID, agentsRevealed } from '../../stores/editor/editor.js';
import { $agentViews, setAgentView } from '../../stores/session-views/session-views.js';
import { $project } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/agents-view/agents-view.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/agents/types.js').NewAgent} NewAgent */
/** @typedef {import('../../hooks/agents/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../hooks/agents/types.js').AgentsReveal} AgentsReveal */
/** @typedef {import('../../hooks/sessions/types.js').SessionView} SessionView */
/** @typedef {{ agentId: string }} AgentId */

/**
 * @tag acp-agents-tab
 * @summary The Agents tab wired to its data: the backend's answer for the search, the registry, pending updates, sign-ins, and the agent actions.
 */
export class AcpAgentsTab extends ViewElement {
  #view = new StoreController(this, { store: $agentsView });
  #query = new StoreController(this, { store: $agentsQuery });
  #list = new StoreController(this, { store: $agentList });
  #pending = new StoreController(this, { store: $agentsPending });
  #reveal = new StoreController(this, { store: $agentsReveal });
  #signIns = new StoreController(this, { store: $signIns });
  #agentViews = new StoreController(this, { store: $agentViews });
  #project = new StoreController(this, { store: $project });
  /** The tab asks again whenever it is shown. */
  #activePath = new StoreController(this, {
    store: $activePath,
    onChange: (path) => {
      if (path === AGENTS_TAB_ID) agents.search();
    },
  });

  /**
   * A listener for an event handled here: it goes no further, and `handler` gets its detail.
   * @template D
   * @param {(detail: D) => unknown} handler
   * @returns {(e: Event) => void}
   */
  static #on(handler) {
    return (e) => {
      e.stopPropagation();
      handler(/** @type {CustomEvent<D>} */ (e).detail);
    };
  }

  /** @param {Event} e An `acp-agent-add` or `acp-agent-update`. */
  async #onSave(e) {
    e.stopPropagation();
    const { agentId, agent } = /** @type {CustomEvent<{ agentId?: string, agent: NewAgent }>} */ (e).detail;
    // The form (or the registry row) that asked is where the event began.
    const form = /** @type {{ saveFinished(error: string | null): void }} */ (/** @type {unknown} */ (e.composedPath()[0]));
    try {
      await (agentId ? agents.update(agentId, agent) : agents.add(agent));
      form.saveFinished(null);
    } catch (err) {
      form.saveFinished(err instanceof Error ? err.message : String(err));
    }
  }

  render() {
    const on = AcpAgentsTab.#on;
    return html`<acp-agents-view
      .view=${this.#view.value}
      .query=${this.#query.value}
      .known=${this.#list.value.known}
      .pending=${this.#pending.value}
      .signIns=${signInsOf(this.#signIns.value, this.#project.value?.path ?? null)}
      .terminalAgents=${Object.keys(this.#agentViews.value)}
      .reveal=${this.#reveal.value}
      @acp-agents-file-open=${on(() => agents.openFile())}
      @acp-agents-import=${on((/** @type {{ agentIds?: string[] } | null} */ d) => agents.importUserAgents(d?.agentIds ?? null))}
      @acp-agents-query=${on((/** @type {AgentsQuery} */ d) => agents.search(d))}
      @acp-agent-version-update=${on((/** @type {AgentId} */ d) => agents.updateVersion(d.agentId))}
      @acp-agents-update-all=${on(() => agents.updateAll())}
      @acp-agents-registry-check=${on(() => agents.checkRegistry())}
      @acp-agents-revealed=${on((/** @type {{ reveal: AgentsReveal }} */ d) => agentsRevealed(d.reveal))}
      @acp-agent-add=${this.#onSave}
      @acp-agent-update=${this.#onSave}
      @acp-agent-enable=${on((/** @type {{ agentId: string, enabled: boolean }} */ d) => agents.setEnabled(d.agentId, d.enabled))}
      @acp-agent-session-view=${on((/** @type {{ agentId: string, view: SessionView }} */ d) => setAgentView(d.agentId, d.view))}
      @acp-agent-default=${on((/** @type {AgentId} */ d) => agents.setDefault(d.agentId))}
      @acp-agent-remove=${on((/** @type {AgentId} */ d) => agents.remove(d.agentId))}
      @acp-agent-sign-in=${on((/** @type {{ agentId: string, methodId: string | null }} */ d) => agents.signIn(d.agentId, d.methodId))}
    ></acp-agents-view>`;
  }
}

customElements.define('acp-agents-tab', AcpAgentsTab);
