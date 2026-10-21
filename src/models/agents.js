/**
 * One or two letters for an agent's badge.
 * @param {string} name
 */
export function glyphOf(name) {
  const words = name.split(/[\s-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * Splits typed arguments as a shell would: on whitespace, with `'…'`, `"…"` and `\` keeping
 * spaces in one argument. Nothing is expanded.
 * @param {string} text
 * @returns {string[]}
 */
export function splitArgs(text) {
  /** @type {string[]} */
  const args = [];
  /** @type {string | null} The argument being read; `null` between arguments. */
  let arg = null;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else arg += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      arg ??= '';
    } else if (c === '\\' && i + 1 < text.length) {
      arg = (arg ?? '') + text[++i];
    } else if (/\s/.test(c)) {
      if (arg !== null) args.push(arg);
      arg = null;
    } else {
      arg = (arg ?? '') + c;
    }
  }
  if (arg !== null) args.push(arg);
  return args;
}

/** @param {string} arg */
function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * A program and its arguments as one line, quoted so `parseCommandLine()` gives them back.
 * @param {string} command
 * @param {readonly string[]} args
 */
export function commandLine(command, args) {
  return [command, ...args].map(shellQuote).join(' ');
}

/**
 * A typed command line as a program and its arguments (`command` is `''` when nothing was typed).
 * @param {string} line
 */
export function parseCommandLine(line) {
  const [command = '', ...args] = splitArgs(line);
  return { command, args };
}
