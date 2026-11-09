/** @typedef {import('../sessions/types.js').ToolCallView} ToolCallView */
/** @typedef {import('./types.js').ToolGroupSummary} ToolGroupSummary */
/** @typedef {import('./types.js').SummaryClause} SummaryClause */

/**
 * How each kind reads. `doing`: while a call of it runs, for a call the agent didn't describe. A file
 * kind: `file`, the verb before a file chip (`Read <file>`) or a count of files (`Read 3 files`), and
 * `asked`, for a call that didn't do it. Any other: one call's words and N calls' (`Ran a command`,
 * `Ran 3 commands`).
 * @type {Record<string, { doing: string } & ({ file: string, asked: string } | { one: string, many: (n: number) => string })>}
 */
const KINDS = {
  read: { doing: 'Reading', file: 'Read', asked: 'Read' },
  edit: { doing: 'Editing', file: 'Edited', asked: 'Edit' },
  delete: { doing: 'Deleting', file: 'Deleted', asked: 'Delete' },
  move: { doing: 'Moving', file: 'Moved', asked: 'Move' },
  search: { doing: 'Searching', one: 'Searched', many: (n) => `Searched ${n} times` },
  execute: { doing: 'Running a command', one: 'Ran a command', many: (n) => `Ran ${n} commands` },
  fetch: { doing: 'Fetching', one: 'Fetched a page', many: (n) => `Fetched ${n} pages` },
  other: { doing: 'Working', one: 'Used a tool', many: (n) => `Used ${n} tools` },
};

/** @param {string} kind */
const clauseKind = (kind) => (kind in KINDS ? kind : 'other');

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
  const words = KINDS[kind];
  if (!('file' in words)) return { text: calls.length === 1 ? words.one : words.many(calls.length) };
  const { file } = words;
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

/** Verbs whose last consonant doubles before -ing and -ed. */
const DOUBLED = new Set(['commit', 'format', 'get', 'grep', 'rerun', 'run', 'scan', 'set', 'stop', 'unzip']);

/** Past forms that don't take -ed. */
const IRREGULAR = new Map(
  Object.entries({
    build: 'built',
    find: 'found',
    get: 'got',
    make: 'made',
    read: 'read',
    rebuild: 'rebuilt',
    rerun: 'reran',
    reset: 'reset',
    run: 'ran',
    see: 'saw',
    set: 'set',
    write: 'wrote',
  }),
);

/** @param {string} verb Lowercase, from `VERBS`. */
function ingOf(verb) {
  if (DOUBLED.has(verb)) return `${verb}${verb.at(-1)}ing`;
  if (verb.endsWith('e') && !verb.endsWith('ee')) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}

/** @param {string} verb Lowercase, from `VERBS`. */
function pastOf(verb) {
  const irregular = IRREGULAR.get(verb);
  if (irregular) return irregular;
  if (DOUBLED.has(verb)) return `${verb}${verb.at(-1)}ed`;
  if (verb.endsWith('e')) return `${verb}d`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ied`;
  return `${verb}ed`;
}

/**
 * A label with its verbs in another form: only the first word and words after "and" that are known
 * verbs change; a label that doesn't start with one stays as it is.
 * @param {string} label
 * @param {(verb: string) => string} form
 */
function inflect(label, form) {
  const [first = ''] = label.split(' ', 1);
  if (!VERBS.has(first.toLowerCase())) return label;
  return label.replace(/(^|\band )([A-Za-z]+)/g, (whole, before, word) => {
    const verb = word.toLowerCase();
    if (!VERBS.has(verb)) return whole;
    const formed = form(verb);
    return before + (word[0] === word[0].toUpperCase() ? formed[0].toUpperCase() + formed.slice(1) : formed);
  });
}

/**
 * A label in the -ing form, for while its call runs: "Check … and try …" → "Checking … and trying …".
 * @param {string} label
 */
export const progressive = (label) => inflect(label, ingOf);

/**
 * A label in the past tense, for a call that ran: "Check … and try …" → "Checked … and tried …".
 * @param {string} label
 */
export const past = (label) => inflect(label, pastOf);

/**
 * What a call of a kind is doing, for a call the agent didn't describe.
 * @param {string} kind ACP's tool kind.
 * @param {boolean} created The call makes a new file.
 */
export function kindVerb(kind, created) {
  if (kind === 'edit' && created) return 'Creating';
  return KINDS[clauseKind(kind)].doing;
}

/** Statuses of a call that still runs. */
const RUNNING = new Set(['pending', 'in_progress', 'awaiting-permission']);

/**
 * A call's row in the expanded work row: a file it names by its kind's verb (`Created` + the file),
 * a described call by its description in the past tense (the -ing form while it runs), else its
 * label as the agent sent it. A call that failed or was cancelled didn't do it: it reads as asked
 * (`Run the tests`, `Edit` + the file).
 * @param {ToolCallView} call
 * @returns {{ text: string, path?: string }}
 */
export function rowOf(call) {
  const running = RUNNING.has(call.status);
  const done = call.status === 'completed';
  const created = call.diff?.created ?? false;
  const path = call.locations[0]?.path;
  const words = KINDS[clauseKind(call.kind)];
  if ('file' in words && path !== undefined) {
    if (running) return { text: kindVerb(call.kind, created), path };
    if (done) return { text: created ? 'Created' : words.file, path };
    return { text: created ? 'Create' : words.asked, path };
  }
  // A worded call (`command` set) has the agent's description as its label.
  if (call.command) return { text: running ? progressive(call.label) : done ? past(call.label) : call.label };
  return { text: call.label };
}

/**
 * The work row's line while a call runs: the call waiting for permission, else the last started of
 * those running (its description in the -ing form, or its kind's verb); `null` when none runs.
 * @param {readonly ToolCallView[]} calls
 * @returns {string | null}
 */
export function liveLine(calls) {
  const waiting = calls.find((c) => c.status === 'awaiting-permission');
  if (waiting) return `Waiting for permission: ${waiting.label}`;
  const running = calls.filter((c) => RUNNING.has(c.status)).at(-1);
  if (!running) return null;
  // A worded call (`command` set) has the agent's description as its label.
  return running.command ? progressive(running.label) : kindVerb(running.kind, running.diff?.created ?? false);
}
