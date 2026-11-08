import { ipc } from '../ipc/ipc.js';

/** What the offer's button sends. Its first line is the session's title. */
const PROMPT = `Create AGENTS.md for this project

Write AGENTS.md at the project root: the instructions every coding agent follows here, in the agents.md format (plain Markdown, no required fields). If it already exists, update it instead of replacing it.

1. Read the project first: manifests, CI, README, and any agent instruction files, at the root and in subfolders, such as CLAUDE.md, .claude/CLAUDE.md, GEMINI.md, .github/copilot-instructions.md, .github/instructions/, .cursorrules, .cursor/rules/, .windsurfrules, .clinerules and CONVENTIONS.md.
2. Write what the project is, the exact commands to build, test and lint, the code style, testing and commit rules, and the gotchas. Include only what you verified and what an agent couldn't work out from the code. Keep it under 32 KiB.
3. Make AGENTS.md the single source. Move what applies to every agent out of the existing files, and leave in them only what is specific to one tool.
4. In each existing CLAUDE.md or GEMINI.md, make the first line an import of AGENTS.md: @AGENTS.md, the path relative to that file. Some agents ignore AGENTS.md without it.
5. Give a nested instruction file an AGENTS.md beside it, in the same way.
6. Create no files for tools this project doesn't use. The one exception: if you yourself don't read AGENTS.md on your own, add your own instruction file with that import.
7. Use no symlinks and don't commit. End by listing the files you changed and what moved where.`;

/** What the banner says. */
const LABEL = 'This project has no AGENTS.md, the instructions file coding agents share.';

/** The offer to create `AGENTS.md` on a new session (spec: `docs/specs/agents-md.md`). */
export const agentsMd = Object.freeze({
  PROMPT,
  LABEL,

  /**
   * Whether the root's folder lacks `AGENTS.md`.
   * @param {string} rootId
   * @returns {Promise<boolean>}
   */
  needed(rootId) {
    return ipc.invoke('needs_agents_md', { rootId });
  },
});
