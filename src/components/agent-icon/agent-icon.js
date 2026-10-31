import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import genericIcon from '@material-design-icons/svg/outlined/smart_toy.svg?raw';
import antigravityIcon from '../../assets/agent-icons/antigravity.svg?raw';
import claudeIcon from '../../assets/agent-icons/claude.svg?raw';
import codexIcon from '../../assets/agent-icons/codex.svg?raw';
import copilotIcon from '../../assets/agent-icons/copilot.svg?raw';
import { agents } from '../../hooks/agents/agents.js';

/** @type {Record<import('../../hooks/agents/rules.js').AgentBrand, string>} */
const ICONS = { claude: claudeIcon, codex: codexIcon, copilot: copilotIcon, antigravity: antigravityIcon };

/**
 * @tag acp-agent-icon
 * @summary An agent's logo; a generic icon for an agent that is none of the supported brands. Light DOM, sized by `font-size`.
 */
export class AcpAgentIcon extends LitElement {
  static properties = {
    agent: { attribute: false },
    brand: { type: String, reflect: true },
  };

  constructor() {
    super();
    /** @type {{ id: string, name?: string | null }} */
    this.agent = { id: '' };
    /** @type {import('../../hooks/agents/rules.js').AgentBrand | null} Derived from `agent`. */
    this.brand = null;
  }

  /** Light DOM: an inline-flex box in its parent's tree, sized by the parent's `font-size`. */
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    this.style.display = 'inline-flex';
    super.connectedCallback();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('agent')) this.brand = agents.agentBrandOf(this.agent.id, this.agent.name);
  }

  render() {
    return html`<md-icon>${unsafeSVG(this.brand ? ICONS[this.brand] : genericIcon)}</md-icon>`;
  }
}

customElements.define('acp-agent-icon', AcpAgentIcon);
