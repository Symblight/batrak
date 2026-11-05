/** @typedef {import('lit').ReactiveControllerHost & import('lit').LitElement} ReactiveElementHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('../../hooks/markdown/types.js').RenderedBlock} Block */

/**
 * The editor as the controller scrolls it: the code editor's view behind three calls.
 * @typedef {Object} EditorScroller
 * @property {HTMLElement} dom The scrolling element.
 * @property {() => number} topLine 1-based line at the top of the viewport.
 * @property {(line: number) => void} scrollToLine Puts a 1-based line at the top.
 */

/**
 * @typedef {Object} MarkdownScrollSyncConfig
 * @property {() => EditorScroller | undefined} editor `undefined` until the editor exists.
 * @property {() => HTMLElement | null} preview The preview's scrolling element.
 * @property {() => readonly Pick<Block, 'line' | 'node'>[]} blocks The preview's blocks; none: scroll in proportion.
 * @property {() => boolean} enabled
 * @property {(node: Node | null) => void} [onCurrent] The block the panes are at changed.
 */

/** Frames a scroll the controller made may take to reach its pane's `scroll` event. */
const ECHO_FRAMES = 4;

/** @typedef {'editor' | 'preview'} Pane */

/**
 * Keeps a markdown file's editor and preview at the same place while either is scrolled by the user:
 * the editor's top line picks the last block that starts at or above it and brings it to the preview's
 * top; the preview's first visible block brings its line to the editor's top. A scroll the controller
 * made itself is ignored when its event arrives, so the panes never chase each other.
 * @implements {ReactiveController}
 */
export class MarkdownScrollSyncController {
  /** @type {ReactiveElementHost} */
  #host;
  /** @type {MarkdownScrollSyncConfig} */
  #config;
  /** @type {Record<Pane, HTMLElement | null>} The elements listened to. */
  #bound = { editor: null, preview: null };
  /** @type {Record<Pane, number>} Frames left in which the pane's next `scroll` event is our own. */
  #echo = { editor: 0, preview: 0 };
  /** @type {Node | null} */
  #current = null;

  /**
   * @param {ReactiveElementHost} host
   * @param {MarkdownScrollSyncConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  hostConnected() {
    this.#host.updateComplete.then(() => this.#bind());
  }

  hostUpdated() {
    this.#bind();
  }

  hostDisconnected() {
    this.#unbind('editor');
    this.#unbind('preview');
  }

  /** Listens to whichever elements the panes are now. */
  #bind() {
    if (!this.#host.isConnected) return;
    this.#rebind('editor', this.#config.editor()?.dom ?? null, this.#onEditor);
    this.#rebind('preview', this.#config.preview(), this.#onPreview);
  }

  /**
   * @param {Pane} pane
   * @param {HTMLElement | null} element
   * @param {EventListener} listener
   */
  #rebind(pane, element, listener) {
    if (this.#bound[pane] === element) return;
    this.#unbind(pane);
    this.#bound[pane] = element;
    element?.addEventListener('scroll', listener, { passive: true });
  }

  /** @param {Pane} pane */
  #unbind(pane) {
    this.#bound[pane]?.removeEventListener('scroll', pane === 'editor' ? this.#onEditor : this.#onPreview);
    this.#bound[pane] = null;
  }

  /**
   * The next `scroll` event of a pane is the controller's own: ignored once, or after a few frames.
   * @param {Pane} pane
   */
  #expectEcho(pane) {
    const mark = ++this.#echo[pane];
    const tick = (/** @type {number} */ left) => {
      if (this.#echo[pane] !== mark) return;
      if (left > 0) requestAnimationFrame(() => tick(left - 1));
      else this.#echo[pane] = 0;
    };
    requestAnimationFrame(() => tick(ECHO_FRAMES));
  }

  /**
   * @param {Pane} pane
   * @returns {boolean} The event is the echo of our own scroll.
   */
  #isEcho(pane) {
    if (this.#echo[pane] === 0) return false;
    this.#echo[pane] = 0;
    return true;
  }

  #onEditor = () => {
    if (!this.#config.enabled() || this.#isEcho('editor')) return;
    const editor = this.#config.editor();
    const preview = this.#config.preview();
    if (!editor || !preview) return;
    const blocks = this.#config.blocks();
    if (blocks.length === 0) {
      this.#setCurrent(null);
      this.#scrollTo('preview', preview, ratio(editor.dom) * range(preview));
      return;
    }
    const line = editor.topLine();
    const block = blocks.filter((b) => b.line <= line).pop() ?? blocks[0];
    this.#setCurrent(block.node);
    const top = preview.scrollTop + (block.node instanceof Element ? block.node.getBoundingClientRect().top - preview.getBoundingClientRect().top : 0);
    this.#scrollTo('preview', preview, top);
  };

  #onPreview = () => {
    if (!this.#config.enabled() || this.#isEcho('preview')) return;
    const editor = this.#config.editor();
    const preview = this.#config.preview();
    if (!editor || !preview) return;
    const blocks = this.#config.blocks();
    if (blocks.length === 0) {
      this.#setCurrent(null);
      this.#scrollTo('editor', editor.dom, ratio(preview) * range(editor.dom));
      return;
    }
    const top = preview.getBoundingClientRect().top;
    const block =
      blocks.find((b) => b.node instanceof Element && b.node.getBoundingClientRect().bottom > top + 1) ?? blocks[blocks.length - 1];
    this.#setCurrent(block.node);
    this.#scrollEditorTo(editor, block.line);
  };

  /**
   * @param {Pane} pane
   * @param {HTMLElement} element
   * @param {number} top
   */
  #scrollTo(pane, element, top) {
    const before = element.scrollTop;
    element.scrollTop = top;
    // Nothing moved, nothing will be heard.
    if (element.scrollTop !== before) this.#expectEcho(pane);
  }

  /**
   * @param {EditorScroller} editor
   * @param {number} line
   */
  #scrollEditorTo(editor, line) {
    if (editor.topLine() === line) return;
    editor.scrollToLine(line);
    // The editor measures before it scrolls, so the move may land a frame later: the echo is waited for.
    this.#expectEcho('editor');
  }

  /** @param {Node | null} node */
  #setCurrent(node) {
    if (node === this.#current) return;
    this.#current = node;
    this.#config.onCurrent?.(node);
  }
}

/** @param {HTMLElement} element */
const range = (element) => Math.max(0, element.scrollHeight - element.clientHeight);

/** @param {HTMLElement} element How far through its scroll range the element is, 0–1. */
const ratio = (element) => (range(element) === 0 ? 0 : element.scrollTop / range(element));
