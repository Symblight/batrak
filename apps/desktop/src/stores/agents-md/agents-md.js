import { computed } from 'nanostores';
import { persistentMapStore } from '../persistent/persistent.js';
import { $projectPath } from '../project/project.js';

/** Projects, by path, that said no to creating AGENTS.md; shared by every window. */
const $dismissed = persistentMapStore('batrak:agents-md:dismissed:', (raw) => (raw === true ? true : null), { listen: true });

/** The shown project said no. By the project's path, so for all its workspaces. */
export const $agentsMdDismissed = computed([$projectPath, $dismissed], (path, dismissed) => Boolean(path && dismissed[path]));

/** @param {string} projectPath */
export function dismissAgentsMd(projectPath) {
  $dismissed.setKey(projectPath, true);
}
