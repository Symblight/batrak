/** @typedef {'starting' | 'running' | 'exited' | 'failed'} TerminalStatus */

/**
 * How a terminal's shell ended; mirrors `terminal::TerminalEvent::Exit`.
 * @typedef {Object} TerminalExit
 * @property {number | null} code
 * @property {string | null} signal Its name (`SIGKILL`) when a signal ended it.
 */

/**
 * A terminal tab's shell (`$terminals`).
 * @typedef {Object} TerminalInfo
 * @property {string} cwd Where it starts; once started, where it did.
 * @property {string | null} fallback Where it starts when `cwd` doesn't exist.
 * @property {string} label The tab's title: the folder's name, then `zsh — my-app`.
 * @property {string | null} title A title the shell set (OSC 0 / 2), shown instead of `label`.
 * @property {string | null} folder The folder whose tabs hold it (`$shownFolder` when it opened); `null` for none's.
 * @property {string | null} projectPath The project shown when it opened: removing it closes the terminal.
 * @property {TerminalStatus} status
 * @property {TerminalExit | null} exit Set once `exited`.
 * @property {string | null} error Why it didn't start, once `failed`.
 * @property {string | null} login A sign-in's login (what it runs, the tab's tooltip): the backend
 *   started it, and the sign-in, not Restart, runs it again.
 * @property {string | null} [sessionId] A session's CLI (its Terminal view): never a tab; the backend
 *   started it, and Restart starts the CLI again.
 */

/**
 * What the backend started; mirrors `terminal::Opened`.
 * @typedef {Object} TerminalOpened
 * @property {string} shell The shell's file name (`zsh`).
 * @property {string} cwd The folder it started in.
 */

/**
 * A terminal running something other than its shell; mirrors `terminal::Busy`.
 * @typedef {Object} TerminalBusy
 * @property {string} id
 * @property {string} process The foreground program's name.
 */

/**
 * The stream between a terminal view and its shell (`terminals.connect()`, `hooks/terminals/`).
 * @typedef {Object} TerminalLink
 * @property {(data: string | Uint8Array) => void} write Input for the shell: typed text, or raw bytes.
 * @property {(cols: number, rows: number) => void} resize
 * @property {() => void} dispose The view is gone; the shell keeps running.
 */

/**
 * Where a terminal view's output goes.
 * @typedef {Object} TerminalSink
 * @property {(bytes: Uint8Array, done: () => void) => void} output `done` once drawn.
 * @property {() => void} reset Clear the screen: a fresh shell starts.
 * @property {(exit: TerminalExit) => void} exit The shell ended (after its output).
 */

/**
 * Starts (or reattaches to) a terminal's shell at a size and streams it into `sink`.
 * @typedef {(id: string, size: { cols: number, rows: number }, sink: TerminalSink) => TerminalLink} TerminalConnect
 */

/**
 * The terminals among `ids` that run a program other than their shell.
 * @typedef {(ids: string[]) => Promise<TerminalBusy[]>} TerminalBusyQuery
 */

export {};
