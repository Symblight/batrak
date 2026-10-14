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
 * Compact gutter: tighter line numbers and a narrower fold column. Selectors lead with `.cm-gutters`
 * to outrank the library's theme, whatever order the two are mounted in.
 */
const gutterPlugin = defineCdxPlugin({
  id: 'acp-gutter',
  extensions: [
    EditorView.theme({
      '.cm-gutters .cm-lineNumbers .cm-gutterElement': { padding: '0 0.25rem 0 0.125rem' },
      '.cm-gutters .cm-foldGutter .cm-gutterElement': { width: '0.875rem' },
      '.cm-gutters .cdx-fold-marker': { inlineSize: '0.875rem', blockSize: '0.875rem' },
      '.cm-gutters .cdx-vcs-gutter': { minWidth: '8px' },
      '.cm-gutters .cdx-comments-gutter .cm-gutterElement': { inlineSize: '0.875rem' },
      '.cm-gutters .cdx-comment-add, .cm-gutters .cdx-comment-marker': {
        inlineSize: '0.75rem',
        blockSize: '0.75rem',
      },
      '.cm-gutters .cdx-comment-add svg, .cm-gutters .cdx-comment-marker svg': {
        inlineSize: '0.625rem',
        blockSize: '0.625rem',
      },
    }),
  ],
});
/**
 * Indent guides start where the code does, clear of the diff sign. The guide plugin draws them from
 * 2px into the line (CodeMirror's default padding); ours, `--cdx-line-padding-inline`, is wider and
 * holds the sign. The library draws an added line's sign on the same `::before` as the guides, so
 * they crossed it and were spaced in the sign's smaller font: the sign moves to `::after`. Selectors
 * go through `.cm-content` to outrank the library's and the plugin's themes.
 */
const indentGuidePlugin = defineCdxPlugin({
  id: 'acp-indent-guides',
  extensions: [
    EditorView.theme({
      '.cm-content .cm-indent-markers::before': { left: 'var(--cdx-line-padding-inline, 2px)' },
      '&.cm-merge-b .cm-content .cm-changedLine::before, .cm-content .cdx-line-added::before': {
        content: '""',
        left: 'var(--cdx-line-padding-inline, 2px)',
        font: 'inherit',
      },
      '&.cm-merge-b .cm-content .cm-changedLine::after, .cm-content .cdx-line-added::after': {
        content: '"+"',
        position: 'absolute',
        insetInlineStart: '2px',
        font: '500 0.75rem/inherit var(--cdx-content-font-family)',
        color: 'var(--cdx-diff-added-sign-color)',
        userSelect: 'none',
        pointerEvents: 'none',
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
export const editorPlugins = [...allPreset, scrollbarPlugin, gutterPlugin, indentGuidePlugin];
