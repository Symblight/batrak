import { projects } from '../../hooks/projects/projects.js';
import { buildChipElement } from '@symblight/chat';
import { fileIcon } from '../../components/file-icon/file-icon.js';
import { chat } from '../../hooks/chat/chat.js';
import { $activeSessionId, folderOf } from '../../stores/sessions/sessions.js';
import { $workspaces } from '../../stores/workspaces/workspaces.js';
import { AcpMarkdown } from '../../components/markdown/markdown.js';
import { AcpCollapsibleText } from '../../components/collapsible-text/collapsible-text.js';
import { AcpPartThinking } from '../../components/part-thinking/part-thinking.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').LitElement} LitElement */
/** @typedef {import('@symblight/chat').ChxChat} ChxChat */
/** @typedef {import('@symblight/chat/composer').ChxAttachments} ChxAttachments */
/** @typedef {import('@symblight/chat/composer').ChxCodeBlock} ChxCodeBlock */
/** @typedef {import('@symblight/chat/agent').ChxPlan} ChxPlan */
/** @typedef {import('@symblight/chat/agent').ChxToolCall} ChxToolCall */
/** @typedef {NonNullable<ChxChat['partElements']>} PartElements */
/** @typedef {import('../../hooks/chat/chat.js').FileRef} FileRef */

/**
 * @typedef {Object} ChatPartsConfig
 * @property {() => ChxAttachments} attachments The composer's attachments, which draw a sent file's card.
 */

/** One value for a part with none, so that re-rendering its message doesn't update its element. */
const NONE = /** @type {never[]} */ ([]);

/** Chip template ids: file chips carry the path in `data-path`, folder chips also `data-kind="folder"`. */
export const FILE_CHIP_TEMPLATE = 'acp-chat-file-chip';
/** Template id of a slash command's chip. */
export const COMMAND_CHIP_TEMPLATE = 'acp-chat-command-chip';

/**
 * Adds the chip templates to `document` once. The composer draws every chip with `buildChipElement`,
 * which finds its template by `document.getElementById`: one inside a shadow root (like the pickers'
 * own) is never found, and the chip falls back to a bare span that sends as plain text.
 */
function ensureChipTemplates() {
  if (document.getElementById(FILE_CHIP_TEMPLATE)) return;
  const file = document.createElement('template');
  file.id = FILE_CHIP_TEMPLATE;
  file.innerHTML = `<chx-chip data-template-id="${FILE_CHIP_TEMPLATE}"><md-icon slot="icon"></md-icon></chx-chip>`;
  const command = document.createElement('template');
  command.id = COMMAND_CHIP_TEMPLATE;
  command.innerHTML = `<chx-chip data-template-id="${COMMAND_CHIP_TEMPLATE}"></chx-chip>`;
  document.body.append(file, command);
}

/**
 * A file chip for a ref: the file's (or folder's) name and lines, the path as written in `data-path`.
 * Made in the document of the nodes it goes into (the markdown fragment's inert one), not through
 * `buildChipElement`: that upgrades the chip in the page, and a shadow root that is moved to another
 * document loses its adopted stylesheets, which left the chip unstyled.
 * @param {FileRef} ref
 * @param {Document} doc
 */
function refChip(ref, doc) {
  const name = ref.path.slice(ref.path.lastIndexOf('/') + 1);
  const lines = chat.linesOf(ref);
  const chip = doc.createElement('chx-chip');
  chip.dataset.templateId = FILE_CHIP_TEMPLATE;
  chip.dataset.path = ref.path;
  if (ref.folder) chip.dataset.kind = 'folder';
  else if (lines) chip.dataset.lines = lines;
  chip.title = lines ? `${ref.path}:${lines}` : ref.path;
  const icon = doc.createElement('md-icon');
  icon.slot = 'icon';
  icon.innerHTML = fileIcon.svgFor(name, ref.folder);
  chip.append(icon, lines ? `${name}:${lines}` : name);
  return chip;
}

/**
 * A tool call's location (`ChxToolCall.buildLocation`): the library's chip with the file type's icon.
 * Module-level, so the tool call never sees a new builder and rebuilds the chip.
 * @param {Parameters<ChxToolCall['buildLocation']>[0]} location
 */
export function locationChip({ path, line }) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const chip = document.createElement('chx-chip');
  chip.title = line === undefined ? path : `${path}:${line}`;
  chip.dataset.path = path;
  if (line !== undefined) chip.dataset.line = String(line);
  const icon = document.createElement('md-icon');
  icon.slot = 'icon';
  icon.innerHTML = fileIcon.svgFor(name);
  chip.append(icon, name);
  return chip;
}

/**
 * A link that opens the ref's file; the `href` keeps it focusable, `<acp-markdown>` never follows it.
 * @param {FileRef} ref
 * @param {string} text
 */
function refLink(ref, text) {
  const link = document.createElement('a');
  link.href = ref.path;
  link.textContent = text;
  markLink(link, ref);
  return link;
}

/**
 * @param {HTMLElement} element
 * @param {FileRef} ref
 */
function markLink(element, ref) {
  element.dataset.path = ref.path;
  if (ref.folder) element.dataset.kind = 'folder';
  const lines = chat.linesOf(ref);
  if (lines) element.dataset.lines = lines;
}

/**
 * A link's target as written, `%20` and the like decoded.
 * @param {HTMLAnchorElement} link
 */
function decodedHref(link) {
  const href = link.getAttribute('href') ?? '';
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/**
 * Turns the file refs in rendered text into chips and links: inline code that is a path, `@path`
 * and `path:12` become chips, a bare `src/app.js` a link, a link to a file opens it.
 * @param {ParentNode} root
 * @param {{ links: boolean }} options `false`: every ref in the text becomes a chip.
 */
export function formatFileRefs(root, { links }) {
  for (const link of root.querySelectorAll('a')) {
    const ref = chat.parseFileRef(decodedHref(link));
    if (ref) markLink(link, ref);
  }
  for (const code of root.querySelectorAll('code')) {
    const ref = code.closest('a') ? null : chat.parseFileRef(code.textContent ?? '');
    if (ref) code.replaceWith(refChip(ref, code.ownerDocument));
  }
  // A chip's label is a text node too (`app.js:12`), which would read as a ref of its own.
  const skip = 'a, code, chx-code-block, [data-template-id]';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  /** @type {Text[]} */
  const texts = [];
  while (walker.nextNode()) texts.push(/** @type {Text} */ (walker.currentNode));
  for (const node of texts) {
    const segments = chat.splitFileRefs(node.data);
    if (!segments.some((s) => s.ref)) continue;
    node.replaceWith(
      ...segments.map(({ text, ref }) => {
        if (!ref) return text;
        return !links || ref.mention || ref.fromLine !== null ? refChip(ref, node.ownerDocument) : refLink(ref, text);
      }),
    );
  }
}

/**
 * Whether a path in the open project is a folder, from its parent's listing; `false` outside it.
 * @param {string} absolute
 */
async function isFolder(absolute) {
  const rel = projects.relPath(absolute);
  const rootId = projects.rootId();
  if (rel === null || rootId === null) return false;
  const slash = rel.lastIndexOf('/');
  try {
    const entries = await projects.listDir(rootId, slash === -1 ? '' : rel.slice(0, slash));
    return entries.some((entry) => entry.path === rel && entry.isDir);
  } catch {
    return false;
  }
}

/**
 * Renders the chat's message parts (the agent's Markdown, your text, chips, pastes, thoughts, plans,
 * tool calls, attachments) with file refs as chips and links, and opens a clicked one from the host:
 * a file chip or link in a message, or a tool call's location, fires `acp-file-open`; a folder's,
 * `acp-file-reveal`; a subagent's card opens its chat (`acp-subagent-open`).
 * @fires acp-file-open {{ path: string, line?: number }}
 * @fires acp-subagent-open {{ sessionId: string, subagentId: string }}
 * @fires acp-file-reveal {{ path: string }}
 * @implements {ReactiveController}
 */
export class ChatPartsController {
  /** @type {LitElement} */
  #host;
  /** @type {ChatPartsConfig} */
  #config;

  /**
   * @param {LitElement} host
   * @param {ChatPartsConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  hostConnected() {
    ensureChipTemplates();
    this.#host.addEventListener('click', this.#onClick);
    this.#host.addEventListener('chx-tool-call-location-click', this.#onLocationClick);
  }

  hostDisconnected() {
    this.#host.removeEventListener('click', this.#onClick);
    this.#host.removeEventListener('chx-tool-call-location-click', this.#onLocationClick);
  }

  /** @type {PartElements} */
  partElements = {
    chip: (part) => buildChipElement(/** @type {Parameters<typeof buildChipElement>[0]} */ (part)),
    code: (part, previous) => {
      const block = /** @type {ChxCodeBlock} */ (previous ?? document.createElement('chx-code-block'));
      block.code = part.text ?? '';
      block.lang = /** @type {{ lang?: string }} */ (part).lang ?? '';
      block.copyable = true;
      return block;
    },
    longText: (part, previous) => {
      const details = previous ?? document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${/** @type {{ lines?: number }} */ (part).lines ?? 0} lines`;
      const pre = document.createElement('pre');
      pre.textContent = part.text ?? '';
      details.replaceChildren(summary, pre);
      return details;
    },
    // The agent's text is Markdown; your own stays as typed, its file refs as chips (a restored
    // message has them only as text).
    text: (part, previous, message) => {
      if (message.own) {
        // folded to its last lines while it's long: a pasted prompt would fill the chat
        const folded = previous instanceof AcpCollapsibleText ? previous : new AcpCollapsibleText();
        const span = folded.querySelector('span') ?? folded.appendChild(document.createElement('span'));
        if (part.html) span.innerHTML = part.html;
        else {
          const lines = (part.text ?? '').split('\n');
          span.replaceChildren(...lines.flatMap((line, i) => (i ? [document.createElement('br'), line] : [line])));
        }
        formatFileRefs(span, { links: false });
        return folded;
      }
      const markdown = previous instanceof AcpMarkdown ? previous : new AcpMarkdown();
      markdown.decorate = (body) => formatFileRefs(body, { links: true });
      markdown.text = part.text ?? '';
      markdown.streaming = part.state === 'streaming';
      return markdown;
    },
    // A thought the turn was stopped in is the reply's last part (any other part ends it).
    thought: (part, previous, message) => {
      const thinking = previous instanceof AcpPartThinking ? previous : new AcpPartThinking();
      const { startedAt, endedAt } = part.data ?? {};
      thinking.text = part.text ?? '';
      thinking.startedAt = typeof startedAt === 'number' ? startedAt : null;
      thinking.endedAt = typeof endedAt === 'number' ? endedAt : null;
      thinking.status =
        part.state === 'streaming'
          ? 'streaming'
          : message.status === 'cancelled' && message.parts.at(-1)?.id === part.id
            ? 'stopped'
            : 'done';
      return thinking;
    },
    plan: (part, previous) => {
      const plan = /** @type {ChxPlan} */ (previous ?? document.createElement('chx-plan'));
      plan.entries = part.entries ?? NONE;
      return plan;
    },
    tool_call: (part, previous) => {
      const call = /** @type {ChxToolCall} */ (previous ?? document.createElement('chx-tool-call'));
      call.buildLocation = locationChip;
      call.toolCallId = String(part.data?.toolCallId ?? '');
      call.label = part.label ?? '';
      call.kind = part.kind ?? 'other';
      call.status = part.status ?? 'pending';
      call.locations = part.locations ?? NONE;
      call.error = part.error ?? '';
      // A subagent's card (`subagentCardData()`): a click opens its chat.
      const subagentId = part.data?.subagentId;
      if (typeof subagentId === 'string') call.dataset.subagentId = subagentId;
      else delete call.dataset.subagentId;
      return call;
    },
    attachment: (part, previous) => {
      const file = /** @type {File} */ (part.attachment);
      if (previous && /** @type {HTMLElement & { file?: File }} */ (previous).file === file) return previous;
      const card = this.#config.attachments().buildAttachment(file, 'message');
      // An empty `actions` slot drops the remove button: a sent card is immutable.
      card.append(Object.assign(document.createElement('span'), { slot: 'actions' }));
      return card;
    },
  };

  /** A file chip or link in a sent message; the composer's chips stay for editing. */
  #onClick = (/** @type {Event} */ e) => {
    const path = e.composedPath();
    if (!path.some((n) => n instanceof HTMLElement && n.localName === 'chx-message-list')) return;
    const card = path.find((n) => n instanceof HTMLElement && n.localName === 'chx-tool-call');
    const subagentId = card instanceof HTMLElement ? card.dataset.subagentId : undefined;
    const sessionId = $activeSessionId.get();
    if (subagentId !== undefined && sessionId !== null) {
      this.#host.dispatchEvent(new CustomEvent('acp-subagent-open', { detail: { sessionId, subagentId }, bubbles: true, composed: true }));
      return;
    }
    const target = path.find(
      (n) =>
        n instanceof HTMLElement &&
        n.dataset.path !== undefined &&
        (n.localName === 'a' || n.dataset.templateId === FILE_CHIP_TEMPLATE),
    );
    if (!(target instanceof HTMLElement)) return;
    e.preventDefault();
    const from = Number(/^\d+/.exec(target.dataset.lines ?? '')?.[0]);
    this.#open(target.dataset.path ?? '', from || null, target.dataset.kind === 'folder');
  };

  #onLocationClick = (/** @type {Event} */ e) => {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.#open(path, line ?? null, false);
  };

  /**
   * A file opens (`acp-file-open`), a folder is revealed (`acp-file-reveal`). Text can't tell a
   * folder from a file (`@.bt`), so the project's listing decides. A worktree session's file opens
   * from its worktree; its folder is revealed as the project's, which the tree shows.
   * @param {string} path As the message names it: relative to the session's folder, or absolute.
   * @param {number | null} line
   * @param {boolean} folder Known to be a folder (a folder chip, `@path/`).
   */
  async #open(path, line, folder) {
    const root = folderOf($activeSessionId.get() ?? '') ?? projects.path();
    const absolute = chat.absoluteRefPath(path, root);
    if (!absolute) return;
    const inProject = projects.projectPathOf($workspaces.get(), absolute);
    const isDir = folder || (await isFolder(inProject));
    const detail = isDir ? { path: inProject } : { path: absolute, line };
    this.#host.dispatchEvent(
      new CustomEvent(isDir ? 'acp-file-reveal' : 'acp-file-open', { detail, bubbles: true, composed: true }),
    );
  }
}
