import { LitElement, html, nothing } from 'lit';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@symblight/wc-material/button';
import xtermStyles from '@xterm/xterm/css/xterm.css?inline';
import { terminalTheme } from './terminal-theme.js';
import styles from './terminal.css?inline';

/** @typedef {import('../../models/types/types.js').TerminalConnect} TerminalConnect */
/** @typedef {import('../../models/types/types.js').TerminalExit} TerminalExit */
/** @typedef {import('../../models/types/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../models/types/types.js').TerminalLink} TerminalLink */

/** RIS: xterm's full reset, written into the stream so it runs in order with the output. */
const FULL_RESET = '\x1bc';
const MAC = /Mac/.test(navigator.userAgent);
const MONO = 'ui-monospace, Menlo, monospace';

/**
 * @tag acp-terminal
 * @summary A terminal tab: xterm.js streaming its shell through `connect`, sized to the tab.
 * @fires acp-terminal-copy `{ text }`
 * @fires acp-terminal-restart `{ terminalId }`
 * @fires acp-terminal-chat `{ terminalId }` Continue in chat, for a session's CLI that ended.
 * @fires acp-terminal-title `{ terminalId, title }` A title the shell set.
 * @fires acp-link-open `{ url }` A link ⌘-clicked (Ctrl-clicked elsewhere).
 */
export class AcpTerminal extends LitElement {
  static properties = {
    terminalId: { attribute: 'terminal-id' },
    connect: { attribute: false },
    info: { attribute: false },
    fontFamily: { attribute: false },
    fontSize: { attribute: false },
    gpu: { attribute: false },
    chatFallback: { type: Boolean, attribute: 'chat-fallback' },
    dropping: { type: Boolean, reflect: true },
    waiting: { type: Number },
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
  #visible = false;
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
    /** @type {string | null} The code editor's font family; `null` for the monospace stack. */
    this.fontFamily = null;
    /** @type {number} px */
    this.fontSize = 13;
    /** @type {boolean} Draw with WebGL where it's available; else (and once its context is lost) the DOM. */
    this.gpu = true;
    /** @type {boolean} A session's CLI: once ended it offers Continue in chat next to Restart. */
    this.chatFallback = false;
    /** @type {boolean} Files dragged from the OS are over it: dropped, their paths are typed in. */
    this.dropping = false;
    /** @type {number} A session's ended CLI: how many inputs (code, drops) wait for Restart or Continue in chat. */
    this.waiting = 0;
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
    return terminalTheme(tokens, document.documentElement.dataset.theme === 'dark');
  }

  #font() {
    return this.fontFamily ? `"${this.fontFamily}", ${MONO}` : MONO;
  }

  firstUpdated() {
    this.#setUp();
  }

  connectedCallback() {
    super.connectedCallback();
    // Moved (a tab reorder moves its panel): disconnecting disposed the screen.
    if (this.hasUpdated && !this.#term) this.#setUp();
  }

  #setUp() {
    const screen = /** @type {HTMLElement} */ (this.renderRoot.querySelector('.acp-terminal__screen'));
    screen.replaceChildren();
    const term = new Terminal({
      fontFamily: this.#font(),
      fontSize: this.fontSize,
      scrollback: 10000,
      macOptionIsMeta: false,
      theme: this.#theme(),
    });
    this.#term = term;
    this.#fit = new FitAddon();
    term.loadAddon(this.#fit);
    term.loadAddon(
      new WebLinksAddon((event, url) => {
        if (MAC ? event.metaKey : event.ctrlKey) this.#emit('acp-link-open', { url });
      }),
    );
    term.attachCustomKeyEventHandler(this.#onKey);
    term.onData((data) => this.#link?.write(data));
    // Bytes in a string (mouse reports past column 95), not text.
    term.onBinary((data) => this.#link?.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
    term.onTitleChange((title) => this.#emit('acp-terminal-title', { terminalId: this.terminalId, title }));
    term.open(screen);
    if (this.gpu) this.#loadWebgl(term);
    this.#resizes = new ResizeObserver(() => this.#scheduleFit());
    this.#resizes.observe(this);
    this.#themes = new MutationObserver(() => {
      if (this.#term) this.#term.options.theme = this.#theme();
    });
    this.#themes.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
  }

  /** @param {Terminal} term */
  #loadWebgl(term) {
    try {
      const webgl = new WebglAddon();
      // Too many contexts, or the GPU reset: back to the DOM renderer.
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL2: the DOM renderer stays.
    }
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
      this.#scheduleFit();
    }
    if (changed.has('fontFamily') || changed.has('fontSize')) {
      term.options.fontFamily = this.#font();
      term.options.fontSize = this.fontSize;
      this.#scheduleFit();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#frame);
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
      this.#visible = visible;
      if (!visible) return;
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
        this.#link?.resize(term.cols, term.rows);
      }
      if (shown) term.focus();
    }, 16);
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
    term?.focus();
  }

  /**
   * A program that didn't turn on bracketed paste would take a line break as Enter: it gets spaces.
   * @param {Terminal} term
   * @param {string} text
   */
  #paste(term, text) {
    term.paste(term.modes.bracketedPasteMode ? text : text.replace(/\r?\n/g, ' '));
  }

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
    if (e.ctrlKey && !e.metaKey && e.key === '`') return false;
    if (MAC) {
      if (!e.metaKey) return true;
      if (down && key === 'c' && term.hasSelection()) this.#emit('acp-terminal-copy', { text: term.getSelection() });
      else if (down && key === 'k') term.clear();
      else if (down && key === 'a') term.selectAll();
      if (down && (key === 'k' || key === 'a')) e.preventDefault();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && key === 'c') {
      if (down && term.hasSelection()) this.#emit('acp-terminal-copy', { text: term.getSelection() });
      return false;
    }
    if (e.ctrlKey && e.shiftKey && (key === 'v' || key === 'f' || key === 't')) return false;
    if (e.ctrlKey && !e.shiftKey && key === 'p') return false;
    return true;
  };

  render() {
    const info = this.info;
    const ended = (info?.status === 'exited' || info?.status === 'failed') && !info.login;
    return html`${info?.status === 'failed'
        ? html`<div class="acp-terminal__error" role="alert">${info.error}</div>`
        : nothing}
      <div class="acp-terminal__screen"></div>
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
