import { html, nothing } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { app } from '../../hooks/app/app.js';
import { fileDrop } from '../../hooks/file-drop/file-drop.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { $fileDropTarget } from '../../stores/file-drop/file-drop.js';
import { $settings } from '../../stores/settings/settings.js';
import { $terminals, setTerminalTitle } from '../../stores/terminals/terminals.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/terminal/terminal.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/file-drop/types.js').FileDrop} FileDrop */

/**
 * @tag acp-terminal-view
 * @summary A terminal tab wired to its data: the shell's state, the editor's font, copy, restart, the title the shell sets, and files dropped from the OS typed in.
 */
export class AcpTerminalView extends ViewElement {
  static properties = {
    terminalId: { type: String, attribute: 'terminal-id' },
  };

  #terminals = new StoreController(this, { store: $terminals });
  #settings = new StoreController(this, { store: $settings });
  #dropTarget = new StoreController(this, { store: $fileDropTarget });
  /** @type {import('lit/directives/ref.js').Ref<HTMLElementTagNameMap['acp-terminal']>} */
  #terminalRef = createRef();
  /** Stops listening to files dropped from the OS. */
  #stopFileDrop = () => {};

  constructor() {
    super();
    /** @type {string} The terminal this tab shows. */
    this.terminalId = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.#stopFileDrop = fileDrop.onDrop(this.#onFileDrop);
  }

  disconnectedCallback() {
    this.#stopFileDrop();
    super.disconnectedCallback();
  }

  /** Files dropped from the OS on a running terminal: their paths are typed in, as a native terminal does. */
  #onFileDrop = (/** @type {FileDrop} */ { target, paths }) => {
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

  render() {
    const info = this.#terminals.value[this.terminalId];
    if (!info) return nothing;
    const { editorFont, editorFontSize } = this.#settings.value;
    const on = AcpTerminalView.#on;
    return html`<acp-terminal
      ${ref(this.#terminalRef)}
      terminal-id=${this.terminalId}
      .connect=${terminals.connect}
      .info=${info}
      .fontFamily=${editorFont}
      .fontSize=${editorFontSize}
      ?dropping=${this.#dropTarget.value !== null && this.#dropTarget.value === this.#terminalRef.value}
      @acp-terminal-copy=${on((/** @type {{ text: string }} */ d) => app.copy(d.text, 'Copying failed'))}
      @acp-terminal-restart=${on((/** @type {{ terminalId: string }} */ d) => terminals.restart(d.terminalId))}
      @acp-terminal-title=${on((/** @type {{ terminalId: string, title: string }} */ d) => setTerminalTitle(d.terminalId, d.title))}
    ></acp-terminal>`;
  }
}

customElements.define('acp-terminal-view', AcpTerminalView);
