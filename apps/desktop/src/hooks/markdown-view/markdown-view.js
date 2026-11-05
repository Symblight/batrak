import { $markdownModes, modeOf, setMode } from '../../stores/markdown-view/markdown-view.js';
import { $workspaces } from '../../stores/workspaces/workspaces.js';
import { $settings } from '../../stores/settings/settings.js';
import { $project } from '../../stores/project/project.js';
import { projects } from '../projects/projects.js';

/** @typedef {import('../markdown/types.js').MarkdownMode} MarkdownMode */

/**
 * Where a file's view is kept: its project, and its path in it (a worktree session's copy counts as
 * the project's file).
 * @param {string} path Absolute.
 * @returns {{ project: string, rel: string } | null} `null` outside the shown project.
 */
function placeOf(path) {
  const project = $project.get()?.path;
  if (!project) return null;
  const rel = projects.rel(project, projects.projectPathOf($workspaces.get(), path));
  return rel === null ? null : { project, rel };
}

/** How each markdown file is shown, the Settings default for one never set. */
export const markdownView = Object.freeze({
  /** Subscribe to this for a change of any file's view. */
  modes: $markdownModes,

  /**
   * @param {string} path Absolute.
   * @returns {MarkdownMode}
   */
  modeOf(path) {
    const fallback = $settings.get().markdownDefaultView;
    const place = placeOf(path);
    return place ? modeOf(place.project, place.rel, fallback) : fallback;
  },

  /**
   * @param {string} path Absolute.
   * @param {MarkdownMode} mode
   */
  setMode(path, mode) {
    const place = placeOf(path);
    if (place) setMode(place.project, place.rel, mode, $settings.get().markdownDefaultView);
  },

  /**
   * Mod+K V: Split on, or off to Raw.
   * @param {MarkdownMode} mode
   * @returns {MarkdownMode}
   */
  afterSplitToggle(mode) {
    return mode === 'split' ? 'raw' : 'split';
  },

  /**
   * Mod+Shift+V: Preview on, or off to Raw.
   * @param {MarkdownMode} mode
   * @returns {MarkdownMode}
   */
  afterPreviewToggle(mode) {
    return mode === 'preview' ? 'raw' : 'preview';
  },

  /**
   * @param {string} path Absolute.
   * @param {'split' | 'preview'} which
   */
  toggle(path, which) {
    const mode = markdownView.modeOf(path);
    markdownView.setMode(path, which === 'split' ? markdownView.afterSplitToggle(mode) : markdownView.afterPreviewToggle(mode));
  },
});
