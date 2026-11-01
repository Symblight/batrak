import { app } from '../../hooks/app/app.js';
import { fileDrop } from '../../hooks/file-drop/file-drop.js';
import { projects } from '../../hooks/projects/projects.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { addDrop, hasPendingInput, takePendingInput } from '../../stores/chat/chat.js';
import { $activeSessionId } from '../../stores/sessions/sessions.js';
import { AcpTerminal } from '../../components/terminal/terminal.js';

/** @typedef {import('lit').ReactiveControllerHost & HTMLElement} SessionInputHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('../../components/chat/chat.js').AcpChat} AcpChat */
/** @typedef {import('../../hooks/file-drop/types.js').FileDrop} FileDrop */

/**
 * @typedef {Object} SessionInputConfig
 * @property {() => AcpChat | null} chat The composer's chat.
 * @property {() => AcpTerminal | null} cli The active session's CLI while it runs.
 * @property {() => boolean} inTerminal The active session shows its CLI in place of the chat.
 * @property {() => boolean} opening A project is opening.
 * @property {() => string | null} root The active session's folder, else the project's.
 * @property {() => boolean} draft The active session is a draft.
 */

/** Larger attachments aren't sent to be saved (the backend's cap). */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/**
 * What the user gives the shown session besides typing, wherever it is shown: code sent from the
 * editors and files dropped from the OS go into the composer, or into the CLI of a session shown in
 * the terminal (kept until it can take them); files attached in the composer are saved where the
 * agent reads them and come back as path chips. Checked after every update of the host, which
 * re-renders as `$pendingInput` changes.
 * @implements {ReactiveController}
 */
export class SessionInputController {
  /** @type {SessionInputHost} */
  #host;
  /** @type {SessionInputConfig} */
  #config;
  /** @type {() => void} Stops listening to files dropped from the OS. */
  #stopDrops = () => {};

  /**
   * @param {SessionInputHost} host
   * @param {SessionInputConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  hostConnected() {
    this.#stopDrops = fileDrop.onDrop(this.#onFileDrop);
  }

  hostDisconnected() {
    this.#stopDrops();
  }

  /** What waited goes in once it can: the session's CLI showed (it was starting) or restarted, or the chat did (its CLI had ended). */
  hostUpdated() {
    this.#applyPending();
  }

  /**
   * @param {Element | null} target
   * @returns {target is AcpTerminal} Whether it is the session's CLI shown here.
   */
  isOwnTerminal(target) {
    return target instanceof AcpTerminal && this.#host.contains(target);
  }

  /**
   * @param {Element | null} target
   * @returns {boolean} Whether it is the chat, shown here (not the session's CLI in its place).
   */
  isShownChat(target) {
    const { chat, inTerminal, opening } = this.#config;
    return target !== null && target === chat() && !inTerminal() && !opening();
  }

  /**
   * Files dropped from the OS on the session's CLI (its paths typed in, as a native terminal does,
   * once it runs) or its chat (into the composer); kept until then.
   */
  #onFileDrop = (/** @type {FileDrop} */ { target, paths }) => {
    if (this.isOwnTerminal(target) || this.isShownChat(target)) addDrop(paths);
  };

  /**
   * What waits for the shown session goes into its running CLI or its composer once up; otherwise
   * it keeps waiting (a CLI starting or ended, a composer not up yet).
   */
  async #applyPending() {
    const id = $activeSessionId.get();
    if (id === null || !hasPendingInput(id)) return;
    await this.#host.updateComplete;
    const { chat: getChat, cli, inTerminal, opening, root } = this.#config;
    if (inTerminal()) {
      const running = cli();
      if (!running) return;
      const { inserts, drops } = takePendingInput(id);
      if (inserts.length) running.paste(sessions.cliInput(inserts, root()));
      if (drops.length) running.paste(terminals.shellPaths(drops, app.platform));
      return;
    }
    const chat = getChat();
    if (!chat || opening() || !(await chat.composerReady())) return;
    // Shown elsewhere meanwhile (another session, or this one's CLI): it waits.
    if ($activeSessionId.get() !== id || inTerminal()) return;
    const { inserts, drops } = takePendingInput(id);
    if (inserts.length) chat.insertCode(inserts);
    if (drops.length) this.#dropOnChat(id, drops);
  }

  /**
   * Dropped files and folders become chips, like `@` picks (an image too: the agent reads it by its
   * path). Kept for the session when another one shows meanwhile.
   * @param {string} sessionId
   * @param {readonly string[]} paths
   */
  async #dropOnChat(sessionId, paths) {
    const chat = this.#config.chat();
    const keep = () => addDrop(paths, sessionId);
    try {
      const kinds = await fileDrop.kinds(paths);
      if ($activeSessionId.get() !== sessionId) return keep();
      const files = fileDrop.chatDropOf(paths.map((path, i) => ({ path, kind: kinds[i] })), this.#config.root());
      if (!chat || !(await chat.composerReady()) || $activeSessionId.get() !== sessionId) return keep();
      chat.insertFiles(files);
    } catch (err) {
      app.reportError('Adding dropped files failed', err);
    }
  }

  /**
   * Files attached in the composer (`acp-chat-attach`): each saved into the session's folder, the
   * saved ones' path chips put in, the others named in an error. A draft's chips are absolute: its
   * folder may yet be a worktree's, where the project's attachments aren't.
   */
  onAttach = async (/** @type {Event} */ e) => {
    const { files } = /** @type {CustomEvent<{ files: File[] }>} */ (e).detail;
    const sessionId = $activeSessionId.get();
    const folder = this.#config.root();
    if (sessionId === null || folder === null) {
      app.reportError('Attaching the files failed', new Error('No session to attach them to'));
      return;
    }
    const draft = this.#config.draft();
    /** @type {string[]} */
    const paths = [];
    /** @type {string[]} */
    const failed = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        failed.push(`${file.name}: too large to attach (over ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`);
        continue;
      }
      try {
        paths.push(await sessions.saveAttachment(folder, file));
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failed.length) app.reportError('Attaching the files failed', new Error(failed.join('; ')));
    const chat = this.#config.chat();
    if ($activeSessionId.get() !== sessionId || !chat) return addDrop(paths, sessionId);
    chat.insertFiles(paths.map((path) => ({ path: draft ? path : (projects.rel(folder, path) ?? path), folder: false })));
  };
}
