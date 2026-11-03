import { html, nothing } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/code-view/code-view.js';
import '../../components/markdown-view/markdown-view.js';
import { imageType } from '../../components/image-preview/image-type.js';
import { app } from '../../hooks/app/app.js';
import { markdownView } from '../../hooks/markdown-view/markdown-view.js';
import { projects } from '../../hooks/projects/projects.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { contentKindOf } from '../../controllers/tab-content/TabContentController.js';
import { $commentFocus, $comments } from '../../stores/comments/comments.js';
import { $fileLanguages, setFileLanguage } from '../../stores/editor/editor.js';
import { $markdownSplit, setMarkdownSplit } from '../../stores/layout/layout.js';
import { notify } from '../../stores/notices/notices.js';
import { $worktrees } from '../../stores/sessions/sessions.js';
import { $settings, setMarkdownScrollSync } from '../../stores/settings/settings.js';
import { $project } from '../../stores/project/project.js';
import { $rootId } from '../../stores/workspaces/workspaces.js';

/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */

/**
 * @tag acp-editor-view
 * @summary A file tab's code editor wired to its data: the project, the file's picked language and the file's comments; a markdown file's in the markdown view, with the view it was left in.
 * @fires acp-tab-edit `{ id, value }` An edit in an editable file.
 * @fires acp-tab-save `{ id }` Mod+S in an editable file.
 * @fires acp-tab-conflict `{ id }` Mod+S in an editable file changed on disk since its edits started.
 * @fires acp-file-open `{ path }` A link of a markdown preview to a file that exists.
 * @fires acp-file-reveal `{ path, expand }` A link of a markdown preview to a folder that exists.
 */
export class AcpEditorView extends ViewElement {
  static properties = {
    tab: { attribute: false },
  };

  #project = new StoreController(this, { store: $project });
  #rootId = new StoreController(this, { store: $rootId });
  #worktrees = new StoreController(this, { store: $worktrees });
  #languages = new StoreController(this, { store: $fileLanguages });
  #settings = new StoreController(this, { store: $settings });
  #comments = new StoreController(this, { store: $comments });
  #commentFocus = new StoreController(this, { store: $commentFocus });
  #markdownModes = new StoreController(this, { store: markdownView.modes });
  #markdownSplit = new StoreController(this, { store: $markdownSplit });

  constructor() {
    super();
    /** @type {EditorTab | null} The file tab this shows. */
    this.tab = null;
  }

  /** Reads a local image of a markdown file for its preview. */
  #loadImage = async (/** @type {string} */ path) => {
    // The text can name any file: only an image is read, not a video or a log of 64 MB.
    const { mime } = imageType.of(path);
    if (mime === '') throw new Error('Not an image');
    return new Blob([await projects.readFileBytes(path)], { type: mime });
  };

  /**
   * Whether a path of the project is in its listing; any other is taken to be there.
   * @param {string} path Absolute.
   */
  async #exists(path) {
    const rel = projects.relPath(path);
    const rootId = this.#rootId.value;
    if (rel === null || rel === '' || rootId === null) return true;
    const slash = rel.lastIndexOf('/');
    try {
      const entries = await projects.listDir(rootId, slash === -1 ? '' : rel.slice(0, slash));
      return entries.some((entry) => entry.path === rel);
    } catch {
      return true;
    }
  }

  /**
   * A link of the preview to a file or folder goes on only if it is there, else it is said.
   * @param {Event} e
   */
  #onPreviewTarget = async (e) => {
    if (!e.composedPath().some((n) => n instanceof Element && n.localName === 'acp-markdown')) return;
    e.stopPropagation();
    const detail = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    if (await this.#exists(detail.path)) this.dispatchEvent(new CustomEvent(e.type, { detail, bubbles: true, composed: true }));
    else notify('warn', `Not found: ${projects.relPath(detail.path) ?? detail.path}`);
  };

  /** @param {EditorTab} tab */
  #renderMarkdown(tab) {
    const { markdownScrollSync } = this.#settings.value;
    return html`<acp-markdown-view
      .tab=${tab}
      .mode=${markdownView.modeOf(tab.path)}
      .scrollSync=${markdownScrollSync}
      .ratio=${this.#markdownSplit.value}
      .language=${this.#languages.value[tab.path] ?? ''}
      .root=${this.#project.value?.path ?? null}
      .rootId=${this.#rootId.value}
      .worktrees=${this.#worktrees.value}
      .listDir=${projects.listDir}
      .comments=${this.#comments.value}
      .commentFocus=${this.#commentFocus.value}
      .loadImage=${this.#loadImage}
      @acp-markdown-mode=${(/** @type {CustomEvent<{ mode: import('../../hooks/markdown/types.js').MarkdownMode }>} */ e) => {
        e.stopPropagation();
        markdownView.setMode(tab.path, e.detail.mode);
      }}
      @acp-markdown-sync=${(/** @type {CustomEvent<{ on: boolean }>} */ e) => {
        e.stopPropagation();
        setMarkdownScrollSync(e.detail.on);
      }}
      @acp-markdown-ratio=${(/** @type {CustomEvent<{ ratio: number }>} */ e) => {
        e.stopPropagation();
        setMarkdownSplit(e.detail.ratio);
      }}
      @acp-markdown-error=${(/** @type {CustomEvent<{ error: unknown }>} */ e) => {
        e.stopPropagation();
        app.reportError('Rendering the markdown failed', e.detail.error);
      }}
      @acp-file-open=${this.#onPreviewTarget}
      @acp-file-reveal=${this.#onPreviewTarget}
      @acp-tab-language=${(/** @type {CustomEvent<{ path: string, language: string }>} */ e) => {
        e.stopPropagation();
        setFileLanguage(e.detail.path, e.detail.language);
      }}
    ></acp-markdown-view>`;
  }

  render() {
    const tab = this.tab;
    if (!tab) return nothing;
    if (contentKindOf(tab) === 'markdown') return this.#renderMarkdown(tab);
    return html`<acp-code-view
      .tab=${tab}
      .language=${this.#languages.value[tab.path] ?? ''}
      .root=${this.#project.value?.path ?? null}
      .rootId=${this.#rootId.value}
      .worktrees=${this.#worktrees.value}
      .listDir=${projects.listDir}
      .comments=${this.#comments.value}
      .commentFocus=${this.#commentFocus.value}
      @acp-tab-language=${(/** @type {CustomEvent<{ path: string, language: string }>} */ e) => {
        e.stopPropagation();
        setFileLanguage(e.detail.path, e.detail.language);
      }}
    ></acp-code-view>`;
  }
}

customElements.define('acp-editor-view', AcpEditorView);
