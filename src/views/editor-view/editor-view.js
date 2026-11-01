import { html, nothing } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/code-view/code-view.js';
import { projects } from '../../hooks/projects/projects.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $commentFocus, $comments } from '../../stores/comments/comments.js';
import { $fileLanguages, setFileLanguage } from '../../stores/editor/editor.js';
import { $worktrees } from '../../stores/sessions/sessions.js';
import { $settings } from '../../stores/settings/settings.js';
import { $rootId, $workspace } from '../../stores/workspace/workspace.js';

/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */

/**
 * @tag acp-editor-view
 * @summary A file tab's code editor wired to its data: the project, the file's picked language, the editor's font and the file's comments.
 * @fires acp-tab-edit `{ id, value }` An edit in an editable file.
 * @fires acp-tab-save `{ id }` Mod+S in an editable file.
 * @fires acp-tab-conflict `{ id }` Mod+S in an editable file changed on disk since its edits started.
 */
export class AcpEditorView extends ViewElement {
  static properties = {
    tab: { attribute: false },
  };

  #workspace = new StoreController(this, { store: $workspace });
  #rootId = new StoreController(this, { store: $rootId });
  #worktrees = new StoreController(this, { store: $worktrees });
  #languages = new StoreController(this, { store: $fileLanguages });
  #settings = new StoreController(this, { store: $settings });
  #comments = new StoreController(this, { store: $comments });
  #commentFocus = new StoreController(this, { store: $commentFocus });

  constructor() {
    super();
    /** @type {EditorTab | null} The file tab this shows. */
    this.tab = null;
  }

  render() {
    const tab = this.tab;
    if (!tab) return nothing;
    const { editorFont, editorFontSize } = this.#settings.value;
    return html`<acp-code-view
      .tab=${tab}
      .language=${this.#languages.value[tab.path] ?? ''}
      .root=${this.#workspace.value?.path ?? null}
      .rootId=${this.#rootId.value}
      .worktrees=${this.#worktrees.value}
      .listDir=${projects.listDir}
      .editorFont=${editorFont}
      .editorFontSize=${editorFontSize}
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
