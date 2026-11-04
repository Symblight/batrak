import { html, nothing } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { app } from '../../hooks/app/app.js';
import { fileDrop } from '../../hooks/file-drop/file-drop.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { $pendingInput } from '../../stores/chat/chat.js';
import { $fileDropTarget } from '../../stores/file-drop/file-drop.js';
import { $settings } from '../../stores/settings/settings.js';
import { $terminals, setTerminalTitle } from '../../stores/terminals/terminals.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/terminal/terminal.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/file-drop/types.js').FileDrop} FileDrop */

/**
 * @tag acp-terminal-view
 * @summary A terminal wired to its data: the shell's state, the editor's font, copy, links, restart, and, for a terminal tab, the title the shell sets and files dropped from the OS typed in. With a `session-id` it is that session's CLI: restart reopens the session's CLI, a way back to the chat is offered, what waits for the CLI is counted, and dropped files are left to the session's input.
 * @fires acp-session-view `{ sessionId, view }` the way back to the chat, from a session's ended CLI
 */
export class AcpTerminalView extends ViewElement {
  static properties = {
    terminalId: { type: String, attribute: 'terminal-id' },
    sessionId: { type: String, attribute: 'session-id' },
  };

  #terminals = new StoreController(this, { store: $terminals });
  #settings = new StoreController(this, { store: $settings });
  #dropTarget = new StoreController(this, { store: $fileDropTarget });
  #pending = new StoreController(this, { store: $pendingInput });
  /** @type {import('lit/directives/ref.js').Ref<HTMLElementTagNameMap['acp-terminal']>} */
  #terminalRef = createRef();
  /** Stops listening to files dropped from the OS. */
  #stopFileDrop = () => {};

  constructor() {
    super();
    /** @type {string} The terminal this tab shows. */
    this.terminalId = '';
    /** @type {string} The session whose CLI this is; `''` for a terminal tab. */
    this.sessionId = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.#stopFileDrop = fileDrop.onDrop(this.#onFileDrop);
  }

  disconnectedCallback() {
    this.#stopFileDrop();
    super.disconnectedCallback();
  }

  /** Puts the keyboard in the terminal. */
  focus() {
    this.#terminalRef.value?.focus();
  }

  /** Files dropped from the OS on a running terminal: their paths are typed in, as a native terminal does. A session's CLI gets them through the session's input, which keeps them until it runs. */
  #onFileDrop = (/** @type {FileDrop} */ { target, paths }) => {
    if (this.sessionId) return;
    const terminal = this.#terminalRef.value;
    if (terminal && target === terminal && this.#terminals.value[this.terminalId]?.status === 'running') {
      terminal.paste(terminals.shellPaths(paths, app.platform));
    }
  };

  /**
   * A listener for an event handled here: it goes no further, and `act` gets its detail.
   * @template D
   * @param {(detail: D) => unknown} act
   * @returns {(e: Event) => void}
   */
  static #on(act) {
    return (e) => {
      e.stopPropagation();
      act(/** @type {CustomEvent<D>} */ (e).detail);
    };
  }

  /** @returns {number} How many inputs wait for the session's CLI. */
  get #waiting() {
    const pending = this.sessionId ? this.#pending.value[this.sessionId] : undefined;
    return pending ? pending.inserts.length + pending.drops.length : 0;
  }

  render() {
    const info = this.#terminals.value[this.terminalId];
    // A session's CLI shows while it starts, before the backend has its shell.
    if (!info && !this.sessionId) return nothing;
    const { editorFont, editorFontSize } = this.#settings.value;
    const on = AcpTerminalView.#on;
    const session = this.sessionId;
    return html`<acp-terminal
      ${ref(this.#terminalRef)}
      terminal-id=${this.terminalId}
      ?chat-fallback=${session !== ''}
      .connect=${terminals.connect}
      .info=${info ?? null}
      .fontFamily=${editorFont}
      .fontSize=${editorFontSize}
      .waiting=${this.#waiting}
      ?dropping=${this.#dropTarget.value !== null && this.#dropTarget.value === this.#terminalRef.value}
      @acp-terminal-copy=${on((/** @type {{ text: string }} */ d) => app.copy(d.text, 'Copying failed'))}
      @acp-link-open=${on((/** @type {{ url: string }} */ d) => app.openUrl(d.url).catch((err) => app.reportError('Opening the link failed', err)))}
      @acp-terminal-restart=${on((/** @type {{ terminalId: string }} */ d) => (session ? sessions.restartCli(session) : terminals.restart(d.terminalId)))}
      @acp-terminal-title=${session ? nothing : on((/** @type {{ terminalId: string, title: string }} */ d) => setTerminalTitle(d.terminalId, d.title))}
      @acp-terminal-chat=${session ? on(() => this.dispatchEvent(new CustomEvent('acp-session-view', { detail: { sessionId: session, view: 'chat' }, bubbles: true, composed: true }))) : nothing}
    ></acp-terminal>`;
  }
}

customElements.define('acp-terminal-view', AcpTerminalView);
