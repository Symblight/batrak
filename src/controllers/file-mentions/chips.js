import { projects } from '../../hooks/projects/projects.js';
import { chat } from '../../hooks/chat/chat.js';
import { COMMAND_CHIP_TEMPLATE, FILE_CHIP_TEMPLATE } from '../chat-parts/ChatPartsController.js';
import '@symblight/wc-material/icon';
import descriptionIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import chevronIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import { fileIcon } from '../../components/file-icon/file-icon.js';

/** @typedef {import('../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../hooks/chat/types.js').ChatInsert} ChatInsert */

/**
 * The composer's ProseMirror document, as far as code goes in: `line+`, each line text and chips.
 * `chx-textbox` and its editor aren't exported by `@symblight/chat`, so typed here.
 * @typedef {{ content: { size: number }, childCount: number, child: (index: number) => PmNode }} PmNode
 * @typedef {Object} PmSchema
 * @property {{ line: PmNodeType, chip: PmNodeType }} nodes
 * @property {(text: string) => PmNode} text
 * @typedef {{ create: (attrs: object | null, content?: PmNode[]) => PmNode }} PmNodeType
 * @typedef {{ doc: PmNode, insert: (pos: number, nodes: PmNode[]) => PmTransaction,
 *   replaceWith: (from: number, to: number, nodes: PmNode[]) => PmTransaction }} PmTransaction
 * @typedef {{ state: { schema: PmSchema, selection: { from: number, to: number }, tr: PmTransaction },
 *   dispatch: (tr: PmTransaction) => void }} PmView
 * @typedef {HTMLElement & { updateComplete: Promise<boolean>, focus: () => void, focusEnd: () => void,
 *   editor?: { view: PmView } }} ComposerTextbox
 */


/**
 * @param {string} value
 * @param {string} headline
 * @param {string} [supportingText]
 */
export function buildMenuItem(value, headline, supportingText) {
  const item = createMenuItem();
  item.setAttribute('value', value);
  item.append(headline);
  if (supportingText) {
    const supporting = document.createElement('span');
    supporting.slot = 'supporting-text';
    supporting.textContent = supportingText;
    item.append(supporting);
  }
  return item;
}

/**
 * A file chip naming lines of code: `src/app.js:12`, or `src/app.js:12-23` for several. The label is
 * what the agent reads.
 * @param {string} rel
 * @param {string} lines
 */
export function codeChipAttrs(rel, lines) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return {
    templateId: FILE_CHIP_TEMPLATE,
    label: `${rel}:${lines}`,
    icon: fileIcon.svgFor(name),
    data: { path: rel, lines },
  };
}

/**
 * @param {PmSchema} schema
 * @param {ChatInsert} insert
 * @param {string | null} root The project's path; the chip names a file inside it relative to it.
 */
export function codeChip(schema, { path, fromLine, toLine }, root) {
  const lines = fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`;
  return schema.nodes.chip.create(codeChipAttrs(projects.rel(root, path) ?? path, lines));
}

/**
 * A file or folder chip as an `@` pick makes it: its name and icon, the path in `data-path`.
 * @param {string} path Relative to the session's folder, or absolute outside it.
 * @param {boolean} folder
 */
export function fileChipAttrs(path, folder) {
  const name = projects.basename(path);
  /** @type {Record<string, string>} */
  const data = folder ? { path, kind: 'folder' } : { path };
  return {
    templateId: FILE_CHIP_TEMPLATE,
    label: name,
    icon: fileIcon.svgFor(name, folder),
    data,
  };
}

const LEADING_COMMAND = /^\/[\w-]+(?=\s|$)/;

/**
 * A replayed prompt as the composer's document: what `promptOfInput()` wrote, read back. A bare
 * `src/app.js` stays text: a chip sends a mention to the agent, which would change what the prompt says.
 * @param {import('../../hooks/sessions/message-builder.js').ChxMessage} message
 * @returns {{ type: 'doc', content: object[] }}
 */
export function recalledDoc(message) {
  /** @type {{ type: string, text?: string, attrs?: object }[][]} */
  const lines = [[]];
  /** @param {object} attrs */
  const addChip = (attrs) => lines[lines.length - 1].push({ type: 'chip', attrs });
  /** @param {string} text Merged with the text before it: a line's text is one node. */
  const addText = (text) =>
    text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      const line = lines[lines.length - 1];
      const last = line.at(-1);
      if (part && last?.type === 'text') last.text += part;
      else if (part) line.push({ type: 'text', text: part });
    });

  const text = message.parts.map((part) => part.text ?? '').join('');
  const command = LEADING_COMMAND.exec(text)?.[0] ?? '';
  if (command) addChip({ templateId: COMMAND_CHIP_TEMPLATE, label: command, icon: null, data: {} });
  for (const part of chat.splitFencedCode(text.slice(command.length))) {
    if (part.type === 'code') {
      const attrs = { text: part.text, lines: part.text.split('\n').length, data: { kind: 'code', lang: part.lang } };
      lines[lines.length - 1].push({ type: 'paste', attrs });
      continue;
    }
    for (const { text: written, ref } of chat.splitFileRefs(part.text)) {
      if (ref?.fromLine != null) addChip(codeChipAttrs(ref.path, chat.linesOf(ref)));
      else if (ref?.mention) addChip(fileChipAttrs(ref.path, ref.folder));
      else addText(written);
    }
  }
  return { type: 'doc', content: lines.map((content) => (content.length ? { type: 'line', content } : { type: 'line' })) };
}

/**
 * A comment's composer lines: its chip, then the comment; the comment's further lines follow as plain lines.
 * @param {PmSchema} schema
 * @param {ChatInsert} insert
 * @param {string | null} root
 */
export function commentLines(schema, insert, root) {
  const [first, ...rest] = insert.body.split('\n');
  return [
    schema.nodes.line.create(null, [codeChip(schema, insert, root), schema.text(` ${first}`)]),
    ...rest.map((text) => schema.nodes.line.create(null, text ? [schema.text(text)] : [])),
  ];
}

/**
 * Text with matched characters in `<b>`.
 * @param {string} text
 * @param {Set<number>} hits Code point indices to highlight.
 * @param {number} offset Index of `text`'s first code point within the full path.
 */
function highlight(text, hits, offset) {
  const fragment = document.createDocumentFragment();
  Array.from(text).forEach((ch, i) => {
    fragment.append(hits.has(offset + i) ? Object.assign(document.createElement('b'), { textContent: ch }) : ch);
  });
  return fragment;
}

/** A picker's option; its density comes from src/styles/shadow.css, like every menu's. */
function createMenuItem() {
  return document.createElement('md-menu-item');
}

/**
 * @param {string} svg
 * @param {string} slot
 */
function buildIcon(svg, slot) {
  const icon = document.createElement('md-icon');
  icon.slot = slot;
  icon.innerHTML = svg;
  return icon;
}

/** The `@` menu's first step: picking it opens the file and folder search. */
export function buildBrowseItem() {
  const item = createMenuItem();
  item.setAttribute('value', '');
  item.dataset.browse = '';
  item.append(buildIcon(descriptionIcon, 'leading'), 'Files and Folders', buildIcon(chevronIcon, 'trailing'));
  return item;
}

/**
 * `@` option for a file or folder on one line: its icon, the name, and the folder it's in, matches
 * highlighted (as in Quick Open).
 * @param {QuickOpenItem} entry
 */
export function buildEntryItem(entry) {
  const hits = new Set(entry.indices);
  const nameStart = Array.from(entry.path).length - Array.from(entry.name).length;
  const dir = nameStart > 0 ? entry.path.slice(0, entry.path.length - entry.name.length - 1) : '';
  const item = createMenuItem();
  item.setAttribute('value', entry.path);
  item.title = entry.path;
  if (entry.isDir) item.dataset.kind = 'folder';
  const icon = fileIcon.svgFor(entry.name, entry.isDir);
  item.append(buildIcon(icon, 'leading'), highlight(entry.name, hits, nameStart));
  if (dir) {
    const trailing = document.createElement('span');
    trailing.slot = 'trailing';
    trailing.append(highlight(dir, hits, 0));
    item.append(trailing);
  }
  return item;
}
