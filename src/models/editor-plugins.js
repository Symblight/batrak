import { EditorView } from '@codemirror/view';
import { defineCdxPlugin } from '@symblight/code-editor';
import { allPreset } from '@symblight/code-editor/presets';

/**
 * Compact scrollbars. CodeMirror's scroller sits in the editor's shadow root, out of reach of our CSS,
 * so the rules go in as a theme. WebKit (Tauri on macOS) lacks `scrollbar-color`: it gets the pseudo-elements.
 */
const scrollbarPlugin = defineCdxPlugin({
  id: 'acp-scrollbar',
  extensions: [
    EditorView.theme({
      '@supports (scrollbar-color: auto)': {
        '.cm-scroller': {
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--md-outline-variant) transparent',
        },
      },
      '@supports not (scrollbar-color: auto)': {
        '.cm-scroller::-webkit-scrollbar': { width: '6px', height: '6px' },
        '.cm-scroller::-webkit-scrollbar-track, .cm-scroller::-webkit-scrollbar-corner': {
          background: 'transparent',
        },
        '.cm-scroller::-webkit-scrollbar-thumb': {
          background: 'var(--md-outline-variant)',
          borderRadius: '3px',
        },
      },
    }),
  ],
});
/**
 * Byline of line comments typed in the app. Comments aren't sent or stored anywhere yet: each editor
 * keeps its own until it closes.
 * @type {import('@symblight/code-editor').CdxCommentAuthor}
 */
export const commentAuthor = { id: 'me', name: 'You' };

/** Plugins of every read-only code view: the tabs here and the diffs in the Changes tab. */
export const editorPlugins = [...allPreset, scrollbarPlugin];
