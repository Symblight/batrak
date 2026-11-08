/** @typedef {import('../sessions/types.js').ToolCallView} ToolCallView */
/** @typedef {import('./types.js').ToolGroupSummary} ToolGroupSummary */
/** @typedef {import('./types.js').SummaryClause} SummaryClause */

/**
 * How each kind's clause reads: `file`, the verb before a file chip (`Read <file>`), or a count of
 * files (`Read 3 files`); otherwise one call's words and N calls' (`Ran a command`, `Ran 3 commands`).
 * @type {Record<string, { file?: string, one?: string, many?: (n: number) => string }>}
 */
const CLAUSES = {
  read: { file: 'Read' },
  edit: { file: 'Edited' },
  delete: { file: 'Deleted' },
  move: { file: 'Moved' },
  search: { one: 'Searched', many: (n) => `Searched ${n} times` },
  execute: { one: 'Ran a command', many: (n) => `Ran ${n} commands` },
  fetch: { one: 'Fetched a page', many: (n) => `Fetched ${n} pages` },
  other: { one: 'Used a tool', many: (n) => `Used ${n} tools` },
};

/** @param {string} kind */
const clauseKind = (kind) => (kind in CLAUSES ? kind : 'other');

/**
 * What a group of tool calls did, in one line: a clause per kind in the order the kinds first
 * appear (the first capitalized), the calls that failed, and the lines the edits added and removed.
 * @param {readonly ToolCallView[]} calls
 * @returns {ToolGroupSummary}
 */
export function summaryOf(calls) {
  /** @type {Map<string, ToolCallView[]>} */
  const byKind = new Map();
  for (const call of calls) {
    const kind = clauseKind(call.kind);
    byKind.set(kind, [...(byKind.get(kind) ?? []), call]);
  }
  const clauses = [...byKind].map(([kind, of], i) => {
    const clause = clauseOf(kind, of);
    return i === 0 ? clause : { ...clause, text: clause.text[0].toLowerCase() + clause.text.slice(1) };
  });
  const diffs = calls.flatMap((c) => (c.diff ? [c.diff] : []));
  return {
    clauses,
    failed: calls.filter((c) => c.status === 'failed').length,
    added: diffs.reduce((sum, d) => sum + d.added, 0),
    removed: diffs.reduce((sum, d) => sum + d.removed, 0),
  };
}

/**
 * @param {string} kind
 * @param {ToolCallView[]} calls Of that kind.
 * @returns {SummaryClause}
 */
function clauseOf(kind, calls) {
  const { file, one = '', many = () => '' } = CLAUSES[kind];
  if (!file) return { text: calls.length === 1 ? one : many(calls.length) };
  // A file read twice is one file; a call that names none counts as one.
  const paths = new Set(calls.map((c) => c.locations[0]?.path ?? c.toolCallId));
  const [path] = paths;
  const named = paths.size === 1 && calls[0].locations.length > 0;
  if (named) return { text: calls.some((c) => c.diff?.created) ? 'Created' : file, path };
  return { text: `${file} ${paths.size} ${paths.size === 1 ? 'file' : 'files'}` };
}

/** Verbs a shell call's description starts with (or joins with "and"). */
const VERBS = new Set(
  `add analyze apply build bump check clean clear clone commit compare compile confirm convert copy count create
  delete deploy diff download dump edit ensure examine extract fetch find fix format generate get grep inspect install
  kill launch lint list load locate look make merge move open parse print pull push read rebuild record remove rename
  replace rerun reset restart restore review run scan search see set show sort start stage stop sync tail test try type
  uninstall unzip update upgrade verify view wait watch write`.split(/\s+/),
);

/** Verbs whose last consonant doubles before -ing. */
const DOUBLED = new Set(['commit', 'get', 'rerun', 'run', 'scan', 'set', 'stop', 'unzip']);

/** @param {string} verb Lowercase, from `VERBS`. */
function ingOf(verb) {
  if (DOUBLED.has(verb)) return `${verb}${verb.at(-1)}ing`;
  if (verb.endsWith('e') && !verb.endsWith('ee')) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}

/**
 * A label in the -ing form, for while its call runs: "Check … and try …" → "Checking … and trying …".
 * Only the first word and words after "and" that are known verbs change; a label that doesn't
 * start with one stays as it is.
 * @param {string} label
 */
export function progressive(label) {
  const [first = ''] = label.split(' ', 1);
  if (!VERBS.has(first.toLowerCase())) return label;
  return label.replace(/(^|\band )([A-Za-z]+)/g, (whole, before, word) => {
    const verb = word.toLowerCase();
    if (!VERBS.has(verb)) return whole;
    const ing = ingOf(verb);
    return before + (word[0] === word[0].toUpperCase() ? ing[0].toUpperCase() + ing.slice(1) : ing);
  });
}

/** What a call of each kind is doing, for a call the agent didn't describe. */
const KIND_VERBS = {
  read: 'Reading',
  edit: 'Editing',
  delete: 'Deleting',
  move: 'Moving',
  search: 'Searching',
  execute: 'Running a command',
  fetch: 'Fetching',
};

/**
 * @param {string} kind ACP's tool kind.
 * @param {boolean} created The call makes a new file.
 */
export function kindVerb(kind, created) {
  if (kind === 'edit' && created) return 'Creating';
  return KIND_VERBS[/** @type {keyof typeof KIND_VERBS} */ (kind)] ?? 'Working';
}

/** @typedef {import('../sessions/types.js').WorkStep} WorkStep */

/** Statuses of a call that still runs. */
const RUNNING = new Set(['pending', 'in_progress', 'awaiting-permission']);

/**
 * The work row's line while its reply runs: the call waiting for permission, else the last started
 * of those running (its description in the -ing form, or its kind's verb), else the last call's
 * label as written.
 * @param {readonly WorkStep[]} steps
 * @returns {{ label: string, waiting: boolean, running: boolean }}
 */
export function liveLine(steps) {
  const calls = steps.flatMap((step) => (step.kind === 'tool' ? [step.call] : []));
  const waiting = calls.find((c) => c.status === 'awaiting-permission');
  if (waiting) return { label: `Waiting for permission: ${waiting.label}`, waiting: true, running: true };
  const running = calls.filter((c) => RUNNING.has(c.status)).at(-1);
  if (running) {
    // A worded call (`command` set) has the agent's description as its label.
    const label = running.command ? progressive(running.label) : kindVerb(running.kind, running.diff?.created ?? false);
    return { label, waiting: false, running: true };
  }
  return { label: calls.at(-1)?.label ?? '', waiting: false, running: false };
}
