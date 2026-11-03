import { expect } from '@esm-bundle/chai';
import { $markdownModes } from '../../../stores/markdown-view/markdown-view.js';
import { $sessions } from '../../../stores/sessions/sessions.js';
import { $settings } from '../../../stores/settings/settings.js';
import { DEFAULT_SETTINGS } from '../../../stores/settings/rules.js';
import { $project } from '../../../stores/project/project.js';
import { markdownView } from '../markdown-view.js';

describe('markdownView', () => {
  beforeEach(() => {
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $markdownModes.setKey('/p', undefined);
    $sessions.set([]);
    $settings.set(DEFAULT_SETTINGS);
    $project.set(null);
  });

  describe('a file’s view', () => {
    it('is the Settings default until it is set', () => {
      expect(markdownView.modeOf('/p/docs/a.md')).to.equal('raw');

      $settings.set({ ...DEFAULT_SETTINGS, markdownDefaultView: 'preview' });
      expect(markdownView.modeOf('/p/docs/a.md')).to.equal('preview');
    });

    it('is remembered by the file’s place in its project', () => {
      markdownView.setMode('/p/docs/a.md', 'split');

      expect(markdownView.modeOf('/p/docs/a.md')).to.equal('split');
      expect(markdownView.modeOf('/p/docs/b.md')).to.equal('raw');
      expect($markdownModes.get()['/p']).to.deep.equal({ 'docs/a.md': 'split' });
    });

    it('goes back to the default when set to it, leaving nothing stored', () => {
      markdownView.setMode('/p/a.md', 'preview');
      markdownView.setMode('/p/a.md', 'raw');

      expect($markdownModes.get()['/p']).to.equal(undefined);
    });

    it('is the same for a worktree session’s copy as for the project’s file', () => {
      $sessions.set([
        /** @type {import('../../sessions/types.js').Session} */ (
          /** @type {unknown} */ ({ id: 's', projectId: '/p', mode: 'worktree', folder: '/wt/s', branch: 'b', title: 't', status: 'idle' })
        ),
      ]);

      markdownView.setMode('/wt/s/docs/a.md', 'split');

      expect(markdownView.modeOf('/p/docs/a.md')).to.equal('split');
      expect($markdownModes.get()['/p']).to.deep.equal({ 'docs/a.md': 'split' });
    });

    it('is the default for a file outside the project, and is not kept', () => {
      markdownView.setMode('/elsewhere/a.md', 'split');

      expect(markdownView.modeOf('/elsewhere/a.md')).to.equal('raw');
      expect($markdownModes.get()['/p']).to.equal(undefined);
    });

    it('is the default with no project open', () => {
      $project.set(null);

      markdownView.setMode('/p/a.md', 'split');

      expect(markdownView.modeOf('/p/a.md')).to.equal('raw');
    });
  });

  describe('the shortcuts', () => {
    it('toggles Split between Raw and Split, taking Preview to Split', () => {
      expect(markdownView.afterSplitToggle('raw')).to.equal('split');
      expect(markdownView.afterSplitToggle('split')).to.equal('raw');
      expect(markdownView.afterSplitToggle('preview')).to.equal('split');
    });

    it('toggles Preview between Raw and Preview, taking Split to Preview', () => {
      expect(markdownView.afterPreviewToggle('raw')).to.equal('preview');
      expect(markdownView.afterPreviewToggle('preview')).to.equal('raw');
      expect(markdownView.afterPreviewToggle('split')).to.equal('preview');
    });

    it('toggles the file’s own view', () => {
      markdownView.toggle('/p/a.md', 'split');
      expect(markdownView.modeOf('/p/a.md')).to.equal('split');
      markdownView.toggle('/p/a.md', 'preview');
      expect(markdownView.modeOf('/p/a.md')).to.equal('preview');
      markdownView.toggle('/p/a.md', 'preview');
      expect(markdownView.modeOf('/p/a.md')).to.equal('raw');
    });
  });
});
