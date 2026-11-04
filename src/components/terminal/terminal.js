import { LitElement, html, nothing } from 'lit';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@symblight/wc-material/button';
import xtermStyles from '@xterm/xterm/css/xterm.css?inline';
import { app } from '../../hooks/app/app.js';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import { fileLinks, fontStack, oneLine, resolveFile, runsLines, safePaste, validFind } from '../../hooks/terminals/rules.js';
import '../terminal-find/terminal-find.js';
import { FIND_DECORATIONS, terminalTheme } from './terminal-theme.js';
import styles from './terminal.css?inline';

/** @typedef {import('../../hooks/terminals/types.js').TerminalConnect} TerminalConnect */
/** @typedef {import('../../hooks/terminals/types.js').TerminalExit} TerminalExit */
/** @typedef {import('../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../hooks/terminals/types.js').TerminalLink} TerminalLink */

/** How long after a resize settles the shell is told, in ms: each size makes a full-screen program redraw. */
const PTY_RESIZE_DELAY = 100;
/** RIS: xterm's full reset, written into the stream so it runs in order with the output. */
const FULL_RESET = '\x1bc';
/**
 * Ctrl shortcuts the terminal leaves to the app on Windows and Linux; every other Ctrl key is the shell's.
 * @type {import('../../hooks/shortcuts/shortcuts.js').ShortcutId[]}
 */
const APP_KEYS = [
  'quickOpen',
  'searchInFiles',
  'toggleSessionView',
  'openWorkspaces',
  'nextWaitingWorkspace',
  'newChat',
  'workspace1',
  'workspace2',
  'workspace3',
  'workspace4',
  'workspace5',
  'workspace6',
  'workspace7',
  'workspace8',
  'workspace9',
];

/**
 * @tag acp-terminal
 * @summary A terminal tab: xterm.js streaming its shell through `connect`, sized to the tab.
 * @fires acp-terminal-copy `{ text }`
 * @fires acp-terminal-restart `{ terminalId }`
 * @fires acp-terminal-chat `{ terminalId }` Continue in chat, for a session's CLI that ended.
 * @fires acp-terminal-title `{ terminalId, title }` A title the shell set.
 * @fires acp-terminal-paste-lines `{ text }` The user pasted lines that would each run: `pasteLines()` if they agree.
 * @fires acp-link-open `{ url }` A link ⌘-clicked (Ctrl-clicked elsewhere).
 * @fires acp-file-open `{ path, line }` A file named in the output ⌘-clicked (Ctrl-clicked elsewhere).
 */
export class AcpTerminal extends LitElement {
  static properties = {
    terminalId: { attribute: 'terminal-id' },
    connect: { attribute: false },
    info: { attribute: false },
    fontFamily: { attribute: false },
    fontSize: { attribute: false },
    colors: { attribute: false },
    windowsBuild: { attribute: false },
    gpu: { attribute: false },
    platform: { attribute: false },
    chatFallback: { type: Boolean, attribute: 'chat-fallback' },
    dropping: { type: Boolean, reflect: true },
    waiting: { type: Number },
    findOpen: { state: true },
    findQuery: { state: true },
    findOptions: { state: true },
    findResult: { state: true },
  };

  static styles = [xtermStyles, styles];

  /** @type {Terminal | null} */
  #term = null;
  /** @type {FitAddon | null} */
  #fit = null;
  /** @type {TerminalLink | null} */
  #link = null;
  /** @type {ResizeObserver | null} */
  #resizes = null;
  /** @type {MutationObserver | null} */
  #themes = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #frame;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #ptyResize;
  /** @type {SearchAddon | null} */
  #search = null;
  /** @type {WebglAddon | null} Only while shown: a page's WebGL contexts are few. */
  #webgl = null;
  #visible = false;
  /** Asked to take the keyboard while not shown: it does once shown. */
  #focusWhenShown = false;
  /** Pasted before the shell was connected: sent once it is. */
  #pending = '';
  /** @type {string} The terminal `#link` is to (`terminalId` may already name the next). */
  #linkId = '';
  /** @type {string} The terminal `#pending`'s text is for. */
  #pendingId = '';

  constructor() {
    super();
    /** @type {string} */
    this.terminalId = '';
    /** @type {TerminalConnect | null} */
    this.connect = null;
    /** @type {TerminalInfo | null} */
    this.info = null;
    /** @type {string | null} The font family picked; `null` for the app's monospace stack, as the code editor. */
    this.fontFamily = null;
    /** @type {number} px */
    this.fontSize = 13;
    /** @type {import('../../hooks/settings/types.js').TerminalColors | null} Its own colors; `null` for the app's. */
    this.colors = null;
    /** @type {number | null} The Windows build its ConPTY comes with: how xterm must read line wrapping; `null` elsewhere. */
    this.windowsBuild = null;
    /** @type {boolean} Draw with WebGL where it's available; else (and once its context is lost) the DOM. */
    this.gpu = true;
    /** @type {import('../../hooks/app/types.js').Platform} Which keys are the app's and the shell's. */
    this.platform = app.platform;
    /** @type {boolean} A session's CLI: once ended it offers Continue in chat next to Restart. */
    this.chatFallback = false;
    /** @type {boolean} Files dragged from the OS are over it: dropped, their paths are typed in. */
    this.dropping = false;
    /** @type {number} A session's ended CLI: how many inputs (code, drops) wait for Restart or Continue in chat. */
    this.waiting = 0;
    /** @type {boolean} Its find bar is shown. */
    this.findOpen = false;
    /** @type {string} */
    this.findQuery = '';
    /** @type {{ caseSensitive: boolean, wholeWord: boolean, regex: boolean }} */
    this.findOptions = { caseSensitive: false, wholeWord: false, regex: false };
    /** @type {{ index: number, total: number } | null} */
    this.findResult = null;
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #theme() {
    const style = getComputedStyle(this);
    const token = (/** @type {string} */ name) => style.getPropertyValue(name).trim();
    const tokens = { background: token('--acp-color-surface'), foreground: token('--acp-color-on-surface'), primary: token('--acp-color-primary') };
    const dark = document.documentElement.dataset.theme === 'dark';
    return terminalTheme(tokens, dark, dark ? this.colors?.dark : this.colors?.light);
  }

  /** @param {Terminal} term */
  #applyWindowsPty(term) {
    term.options.windowsPty = this.windowsBuild === null ? {} : { backend: 'conpty', buildNumber: this.windowsBuild };
  }

  /** @param {Terminal} term */
  #applyTheme(term) {
    const theme = this.#theme();
    term.options.theme = theme;
    // The padding around xterm's screen is the host's.
    this.style.setProperty('--acp-terminal-background', theme.background ?? null);
  }

  #font() {
    return fontStack(this.fontFamily, getComputedStyle(this).getPropertyValue('--acp-font-family-mono').trim());
  }

  /**
   * A link in the output, written out or as OSC 8: only the platform's modifier opens it.
   * @param {MouseEvent} event
   * @param {string} url
   */
  #openLink = (event, url) => {
    if (this.#isOpenClick(event)) this.#emit('acp-link-open', { url });
  };

  /** @param {MouseEvent} event */
  #isOpenClick(event) {
    return this.platform === 'mac' ? event.metaKey : event.ctrlKey;
  }

  /**
   * The files named on a buffer line, a wrapped line taken whole, relative ones from the folder the shell started in.
   * @param {Terminal} term
   * @param {number} y 1-based.
   * @returns {import('@xterm/xterm').ILink[]}
   */
  #fileLinksAt(term, y) {
    const buffer = term.buffer.active;
    let first = y - 1;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
    let last = first;
    while (buffer.getLine(last + 1)?.isWrapped) last++;
    let text = '';
    for (let row = first; row <= last; row++) text += buffer.getLine(row)?.translateToString(row === last) ?? '';
    return fileLinks(text, term.cols, this.platform)
      .filter(({ start, end }) => first + start.y <= y && y <= first + end.y)
      .flatMap(({ path, line, start, end }) => {
        const absolute = resolveFile(path, this.info?.cwd, this.platform);
        if (absolute === null) return [];
        return [
          {
            text: path,
            range: { start: { x: start.x, y: first + start.y }, end: { x: end.x, y: first + end.y } },
            activate: (/** @type {MouseEvent} */ event) => {
              if (this.#isOpenClick(event)) this.#emit('acp-file-open', { path: absolute, line });
            },
          },
        ];
      });
  }

  firstUpdated() {
    this.#setUp();
  }

  connectedCallback() {
    super.connectedCallback();
    // Removed for a while, then put back.
    if (this.hasUpdated && !this.#term) this.#setUp();
  }

  #setUp() {
    const screen = /** @type {HTMLElement} */ (this.renderRoot.querySelector('.acp-terminal__screen'));
    screen.replaceChildren();
    // Captured, or xterm's own listener would paste it as it is.
    screen.addEventListener('paste', this.#onPaste, { capture: true });
    const term = new Terminal({
      fontFamily: this.#font(),
      fontSize: this.fontSize,
      scrollback: 10000,
      macOptionIsMeta: false,
      // A program's colors may assume another background than the theme's: text stays readable.
      minimumContrastRatio: 4.5,
      linkHandler: { activate: this.#openLink },
      // The Unicode addon registers through xterm's proposed API.
      allowProposedApi: true,
    });
    this.#term = term;
    this.#applyTheme(term);
    this.#applyWindowsPty(term);
    this.#fit = new FitAddon();
    term.loadAddon(this.#fit);
    term.loadAddon(new WebLinksAddon(this.#openLink));
    term.registerLinkProvider({ provideLinks: (y, done) => done(this.#fileLinksAt(term, y)) });
    term.loadAddon(new Unicode11Addon());
    this.#search = new SearchAddon();
    this.#search.onDidChangeResults(({ resultIndex, resultCount }) => (this.findResult = { index: resultIndex, total: resultCount }));
    term.loadAddon(this.#search);
    term.unicode.activeVersion = '11';
    term.attachCustomKeyEventHandler(this.#onKey);
    term.onData((data) => this.#link?.write(data));
    // Bytes in a string (mouse reports past column 95), not text.
    term.onBinary((data) => this.#link?.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
    term.onTitleChange((title) => this.#emit('acp-terminal-title', { terminalId: this.terminalId, title }));
    term.open(screen);
    this.#resizes = new ResizeObserver(() => this.#scheduleFit());
    this.#resizes.observe(this);
    this.#themes = new MutationObserver(() => {
      if (this.#term) this.#applyTheme(this.#term);
    });
    this.#themes.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
  }

  /** @param {Terminal} term */
  #loadWebgl(term) {
    if (!this.gpu || this.#webgl) return;
    try {
      const webgl = new WebglAddon();
      // The GPU reset: back to the DOM renderer, until it is next shown.
      webgl.onContextLoss(() => this.#unloadWebgl());
      term.loadAddon(webgl);
      this.#webgl = webgl;
    } catch {
      // No WebGL2: the DOM renderer stays.
    }
  }

  #unloadWebgl() {
    this.#webgl?.dispose();
    this.#webgl = null;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  updated(changed) {
    const term = this.#term;
    if (!term) return;
    if (changed.get('terminalId')) {
      // Another terminal shown in this element (the agent column's next session): its own screen and
      // link, never the last one's. Connecting again replays its kept output.
      this.#link?.dispose();
      this.#link = null;
      if (this.#pendingId !== this.terminalId) this.#pending = '';
      // Behind what xterm still has to draw of the last terminal, so none of it lands on this one.
      term.write(FULL_RESET);
      this.#visible = false;
      this.findOpen = false;
      this.#scheduleFit();
    }
    if (changed.get('colors') !== undefined) this.#applyTheme(term);
    if (changed.has('windowsBuild')) this.#applyWindowsPty(term);
    if (changed.has('fontFamily') || changed.has('fontSize')) {
      term.options.fontFamily = this.#font();
      term.options.fontSize = this.fontSize;
      this.#scheduleFit();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // A move (a tab reorder moves its panel) is back by then, with its screen and scrollback.
    queueMicrotask(() => {
      if (!this.isConnected) this.#tearDown();
    });
  }

  #tearDown() {
    clearTimeout(this.#frame);
    clearTimeout(this.#ptyResize);
    this.#webgl = null;
    this.#search = null;
    this.findOpen = false;
    this.#resizes?.disconnect();
    this.#themes?.disconnect();
    this.#link?.dispose();
    this.#link = null;
    this.#term?.dispose();
    this.#term = null;
    this.#fit = null;
    this.#visible = false;
  }

  /**
   * One fit per frame; none while the tab is hidden (0 × 0). A timer, not `requestAnimationFrame`,
   * which a page in the background never runs: its terminal would never connect.
   */
  #scheduleFit() {
    clearTimeout(this.#frame);
    this.#frame = setTimeout(() => {
      const term = this.#term;
      const fit = this.#fit;
      if (!term || !fit) return;
      const visible = this.offsetWidth > 0 && this.offsetHeight > 0;
      const shown = visible && !this.#visible;
      if (this.#visible && !visible) this.#unloadWebgl();
      this.#visible = visible;
      if (!visible) return;
      if (shown) this.#loadWebgl(term);
      const { cols, rows } = term;
      fit.fit();
      if (!this.#link && this.connect) {
        this.#linkId = this.terminalId;
        this.#link = this.connect(this.terminalId, { cols: term.cols, rows: term.rows }, {
          output: (bytes, done) => term.write(bytes, done),
          // Queued like output: drawn after what came before it.
          reset: () => term.write(FULL_RESET),
          exit: (exit) => term.write(`\r\n\x1b[2m[Process exited with ${exitText(exit)}]\x1b[0m\r\n`),
        });
        const pending = this.#pending;
        this.#pending = '';
        if (pending) this.#paste(term, pending);
      } else if (term.cols !== cols || term.rows !== rows) {
        clearTimeout(this.#ptyResize);
        this.#ptyResize = setTimeout(() => this.#link?.resize(term.cols, term.rows), PTY_RESIZE_DELAY);
      }
      if (shown && this.#focusWhenShown) this.focus();
    }, 16);
  }

  async #openFind() {
    this.findOpen = true;
    await this.updateComplete;
    await this.renderRoot.querySelector('acp-terminal-find')?.focusInput();
  }

  #closeFind = () => {
    this.findOpen = false;
    this.#search?.clearDecorations();
    this.focus();
  };

  /**
   * @param {boolean} [previous] Moves back; else on from the match shown.
   * @param {boolean} [incremental] Stays on the match shown while it still matches: the query or an option changed.
   */
  #find(previous = false, incremental = false) {
    const options = { ...this.findOptions, incremental, decorations: FIND_DECORATIONS };
    if (!this.findQuery || !validFind(this.findQuery, this.findOptions.regex)) {
      this.#search?.clearDecorations();
      this.findResult = null;
    } else if (previous) this.#search?.findPrevious(this.findQuery, options);
    else this.#search?.findNext(this.findQuery, options);
  }

  #onFindInput = (/** @type {Event} */ e) => {
    this.findQuery = /** @type {CustomEvent<{ value: string }>} */ (e).detail.value;
    this.#find(false, true);
  };

  #onFindClear = () => {
    this.findQuery = '';
    this.#find();
  };

  #onFindOption = (/** @type {Event} */ e) => {
    const { option } = /** @type {CustomEvent<{ option: 'caseSensitive' | 'wholeWord' | 'regex' }>} */ (e).detail;
    this.findOptions = { ...this.findOptions, [option]: !this.findOptions[option] };
    // The addon compares the options with themselves, so it counts again only for a new query.
    this.#search?.clearDecorations();
    this.#find(false, true);
  };

  #onFindStep = (/** @type {Event} */ e) => {
    this.#find(/** @type {CustomEvent<{ direction: 'next' | 'previous' }>} */ (e).detail.direction === 'previous');
  };

  /** Puts the keyboard in the terminal. */
  focus() {
    this.#focusWhenShown = !this.#visible;
    if (this.#visible) this.#term?.focus();
  }

  /**
   * Pastes text into the shell, as if pasted by the user, and focuses the terminal; kept until the
   * shell is connected.
   * @param {string} text
   */
  paste(text) {
    const term = this.#term;
    // Only through a link to the terminal shown now (`updated()` relinks after `terminalId` changes).
    if (term && this.#link && this.#linkId === this.terminalId) {
      this.#paste(term, text);
    } else {
      if (this.#pendingId !== this.terminalId) this.#pending = '';
      this.#pending += text;
      this.#pendingId = this.terminalId;
    }
    this.focus();
  }

  /**
   * Pastes lines the user agreed to run, and focuses the terminal.
   * @param {string} text
   */
  pasteLines(text) {
    this.#term?.paste(safePaste(text));
    this.focus();
  }

  /**
   * A program that didn't turn on bracketed paste would take a line break as Enter: it gets spaces.
   * @param {Terminal} term
   * @param {string} text
   */
  #paste(term, text) {
    term.paste(safePaste(term.modes.bracketedPasteMode ? text : oneLine(text)));
  }

  /** What the user pastes (⌘V, the Edit menu): sent, unless its lines would each run. */
  #onPaste = (/** @type {ClipboardEvent} */ e) => {
    e.preventDefault();
    e.stopPropagation();
    const term = this.#term;
    const text = e.clipboardData?.getData('text/plain');
    if (!term || !text) return;
    if (runsLines(text, term.modes.bracketedPasteMode)) this.#emit('acp-terminal-paste-lines', { text });
    else term.paste(safePaste(text));
  };

  /**
   * Keys for the shell, except the app's shortcuts (they bubble on) and copy, paste, clear, select all.
   * @param {KeyboardEvent} e
   * @returns {boolean} xterm handles it.
   */
  #onKey = (e) => {
    const term = this.#term;
    if (!term) return false;
    const key = e.key.toLowerCase();
    const down = e.type === 'keydown';
    if (shortcuts.matches('newTerminal', e, this.platform)) return false;
    if (shortcuts.matches('find', e, this.platform)) {
      if (down) {
        e.preventDefault();
        this.#openFind();
      }
      return false;
    }
    if (this.platform === 'mac') {
      if (!e.metaKey) return true;
      if (down && key === 'c' && term.hasSelection()) this.#emit('acp-terminal-copy', { text: term.getSelection() });
      else if (down && key === 'k') {
        term.clear();
        this.#link?.clear();
      }
      else if (down && key === 'a') term.selectAll();
      if (down && (key === 'k' || key === 'a')) e.preventDefault();
      return false;
    }
    // As Windows' own terminals: Ctrl+V reaches the webview as a paste, Ctrl+C interrupts unless text is selected.
    if (this.platform === 'windows' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (key === 'v') return false;
      if (key === 'c' && term.hasSelection()) {
        if (down) {
          this.#emit('acp-terminal-copy', { text: term.getSelection() });
          term.clearSelection();
        }
        return false;
      }
    }
    if (e.ctrlKey && e.shiftKey && key === 'c') {
      if (down && term.hasSelection()) this.#emit('acp-terminal-copy', { text: term.getSelection() });
      return false;
    }
    if (e.ctrlKey && e.shiftKey && key === 'v') return false;
    return !APP_KEYS.some((id) => shortcuts.matches(id, e, this.platform));
  };

  render() {
    const info = this.info;
    const ended = (info?.status === 'exited' || info?.status === 'failed') && !info.login;
    return html`${info?.status === 'failed'
        ? html`<div class="acp-terminal__error" role="alert">${info.error}</div>`
        : nothing}
      <div class="acp-terminal__screen"></div>
      ${this.findOpen
        ? html`<acp-terminal-find
            class="acp-terminal__find"
            .query=${this.findQuery}
            .invalid=${!validFind(this.findQuery, this.findOptions.regex)}
            .caseSensitive=${this.findOptions.caseSensitive}
            .wholeWord=${this.findOptions.wholeWord}
            .regex=${this.findOptions.regex}
            .result=${this.findResult}
            @acp-search-bar-input=${this.#onFindInput}
            @acp-search-bar-clear=${this.#onFindClear}
            @acp-search-option-toggle=${this.#onFindOption}
            @acp-terminal-find-step=${this.#onFindStep}
            @acp-terminal-find-close=${this.#closeFind}
          ></acp-terminal-find>`
        : nothing}
      ${ended
        ? html`<div class="acp-terminal__actions">
            ${this.waiting > 0 ? html`<span class="acp-terminal__waiting">${this.waiting} waiting to be sent</span>` : nothing}
            ${this.chatFallback
              ? html`<md-button
                  class="acp-terminal__chat"
                  variant="text"
                  @click=${() => this.#emit('acp-terminal-chat', { terminalId: this.terminalId })}
                  >Continue in chat</md-button
                >`
              : nothing}
            <md-button
              class="acp-terminal__restart"
              variant="tonal"
              @click=${() => this.#emit('acp-terminal-restart', { terminalId: this.terminalId })}
              >Restart</md-button
            >
          </div>`
        : nothing}`;
  }
}

/** @param {TerminalExit} exit */
function exitText({ code, signal }) {
  return signal ?? `code ${code ?? '?'}`;
}

customElements.define('acp-terminal', AcpTerminal);
