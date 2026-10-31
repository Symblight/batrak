import agentIcon from '@material-design-icons/svg/outlined/smart_toy.svg?raw';
import antigravityIcon from '../../assets/agent-icons/antigravity.svg?raw';
import claudeIcon from '../../assets/agent-icons/claude.svg?raw';
import codexIcon from '../../assets/agent-icons/codex.svg?raw';
import copilotIcon from '../../assets/agent-icons/copilot.svg?raw';
import { agentBrandOf } from '../agents/agents.js';

/** @type {Record<import('../agents/agents.js').AgentBrand, string>} */
const ICONS = { claude: claudeIcon, codex: codexIcon, copilot: copilotIcon, antigravity: antigravityIcon };

/**
 * An agent's logo SVG for an `md-icon`, and its brand; a generic icon and `null` for an agent of
 * no known brand.
 * @param {string} agentId
 * @param {string | null | undefined} name
 * @returns {{ brand: import('../agents/agents.js').AgentBrand | null, svg: string }}
 */
export function agentIconOf(agentId, name) {
  const brand = agentBrandOf(agentId, name);
  return { brand, svg: brand ? ICONS[brand] : agentIcon };
}
