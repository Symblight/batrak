---
paths:
  - "src/stores/**"
  - "src/hooks/tabs/**"
  - "src/controllers/tab-content/**"
  - "src/components/tab-view/**"
  - "src/views/main-column/**"
  - "src/components/image-preview/**"
  - "src/components/settings/**"
  - "src/hooks/settings/**"
  - "src/stores/markdown-view/**"
  - "src/hooks/markdown/**"
  - "src/hooks/markdown-view/**"
  - "src/components/markdown*/**"
---

# Persisted state and tabs

- Persisted today: `$columnWidths` (`brama:layout:column-widths`), `$hiddenColumns`
  (`brama:layout:hidden-columns`, shared; the toolbar's buttons toggle the sessions and file columns), `$project` (`brama:project`, reopened
  on launch by `projects.restore()`), `$projectTabs` (`brama:editor:tabs:<project path>`; the
  active project's entry is `$editorTabs`, which shows only files inside it; a tab id is a file's path
  or a view's id (`SETTINGS_TAB_ID`, one long card of sections (Theme, Editor) with a list
  beside it that scrolls to them and follows the scroll; `openSettings(reveal)` sets `$settingsReveal`
  and the tab scrolls there and answers `acp-settings-revealed`; `AGENTS_TAB_ID`, the Agents tab
  (see `agent-config.md`), opened by `openAgents(reveal)` (`$agentsReveal`: the registry's agents
  to add, or an agent's row; answered by `acp-agents-revealed`); `CHANGES_TAB_ID`, every changed file expanding into its diff, which a
  click in the Changes side pane opens, expands and scrolls to; `tabs.terminalId(id)` (`stores/tab-ids/tab-ids.js`, re-exported by `hooks/tabs/tabs.js`), one per
  terminal: a tab of the terminal panel's group, or of the editor's once dragged there, see `terminals.md`; `BROWSER_TAB_ID`); `parseTabId()` tells them apart.
  `TabContentController` (`src/controllers/tab-content/`) picks the view for a tab's content
  (`ContentKind`: a file is `markdown` / `image` (SVG too) by extension, else `code`; a view tab by its
  kind) and renders it with the host's view for that kind; only `readsFile()` tabs are read from disk:
  text, or an image's bytes (`read_file_bytes`, at most 64 MB) as `EditorTab.image`, a `Blob` that
  `<acp-image-preview>` shows centered (never scaled up) over a checkerboard (`background="auto"`: the
  column's), with a footer of resolution, type and size. A markdown file is shown in `<acp-markdown-view>`
  (see "Markdown view" below); the Browser view is a mock for now. Pinned tabs (`EditorTabs.pinned`) lead the strip and survive Close Others / Close Tabs to the Right / Close All. Everything in `<acp-main-column>` opens as such a
  tab. View tabs need no project: with none open, `$editorTabs` is the `''` entry, which holds only them),
  `$projectTerminalPanelHeights` (`brama:layout:terminal-panel:<project path>`, per window like the tabs,
  one item per project through `setKey()`: the terminal panel's height in px, clamped when read; the
  panel's tabs (`$projectTerminalTabs`) and whether it is open (`$projectTerminalPanels`) are in memory
  only, since shells don't outlive the page),
  `$projectExpandedFolders` (`brama:file-tree:expanded:<project path>`, per window like the tabs; the
  active project's entry is `$expandedFolders`, root-relative folders the file tree is controlled by: it
  sends the user's expand/collapse up (`acp-expanded-change`, the file column writes it) and expands
  stored folders as their parents load),
  `$contextUsage` (`brama:sessions:context-usage:<session id>`, see `sessions.md`),
  `$sessionReads` (`brama:sessions:read:<session id>`, shared: `{ seen: ISO | null }`, `null` marked
  unread by hand; dropped only by `forgetRead()` on remove / revert to draft) and `$readBaselines`
  (`brama:sessions:baseline:<agent id>\n<project path>`, shared: an ISO time, written once when a sync
  lists that agent for the project), see `sessions.md`,
  `$searchDialogPrefs` (`brama:search:dialog`, shared: the search dialog's preview placement, view
  and splits), `$projectSearch` (`brama:search:project:<project path>`, per window, one item per
  project through `setKey()`: the dialog's last query, options, folder and mask, and the project's
  10 recent searches; two windows on one project: last write wins),
  `$projects` (`brama:projects`, shared; every opened folder is added, `projects.remove()` drops it
  from the app only), `$collapsedProjects` (`brama:projects:collapsed`) and `$markdownModes` (`brama:markdown:mode:<project path>`, per window, one item per project through
  `setKey()`: `{ [root-relative path]: 'raw' | 'split' | 'preview' }`, only modes other than the default,
  an invalid one dropped on read), `$markdownSplit` (`brama:layout:markdown-split`, shared: the editor's
  share of Split in percent, 20–80), `$settings` (`brama:settings`,
  shared: appearance and accent, which `settings.syncTheme()` (`hooks/settings/settings.js`) turns into the MD3 palette and `data-theme` on
  `<html>`, the code editor's font, `markdownDefaultView` (`raw` / `split` / `preview`: how a markdown file never set
  opens; no control in Settings, so `raw` unless the stored value is edited) and `markdownScrollSync`; key dark-only CSS on `:root[data-theme='dark']`, never on
  `prefers-color-scheme`, since Appearance can override the OS). Typedefs for each are in
  `src/hooks/settings/types.js`.

## Markdown view

Spec: `docs/specs/markdown-view-modes.md`. A `.md` / `.mdx` tab (content kind `markdown`) is shown by
`<acp-editor-view>` in `<acp-markdown-view>` (`src/components/markdown-view/`): the code editor
(`<acp-code-view>`, hidden in Preview, never removed, so the caret, undo and an unsaved draft survive),
a live preview of `tab.draft ?? tab.content`, and `<acp-markdown-switcher>` in a bar above them (Raw /
Split / Preview, and in Split the scroll sync toggle). There is no status-bar mode item: `cdx-footer`
has no slot for one.

- **View per file:** `markdownView` (`src/hooks/markdown-view/`) reads and writes `$markdownModes` by the
  file's place in its project (a worktree session's copy is the project's file), falling back to
  `$settings.markdownDefaultView`; setting the default deletes the entry. `pruneModes()`
  (`stores/markdown-view/`) drops entries of files that are gone; nothing calls it yet.
- **Rendering:** `markdown.render(text, { policy, baseDir, root, decorate })` (`src/hooks/markdown/`) is the
  only place markdown becomes DOM: `markdown-it` parses (task lists added as a core rule), DOMPurify
  sanitizes against an explicit allowlist (`policy.js`, its own instance per policy, links judged on the
  parsed `URL`) into a fragment of an inert document, then link, image, heading id and class rules run on
  its nodes. `reply` (chat, `<acp-markdown>`'s default) turns an image into a link; `document` (the preview)
  keeps local images, which `<acp-markdown>` loads through its `loadImage` property (`read_file_bytes`,
  object URLs freed with the image; at most 200 a render), resolves relative links inside the project
  (`acp-file-open`, `acp-file-reveal`; `<acp-editor-view>` says "Not found" for one that is not there)
  and anchors to `acp-md-<slug>` heading ids. Remote images are never fetched. The preview re-renders 150 ms
  after typing stops (500 ms and "Rendering…" over 1 MB) and keeps the DOM of unchanged leading blocks.
- **Scroll sync:** `MarkdownScrollSyncController` (`src/controllers/markdown-scroll-sync/`) maps the editor's
  top line to the preview's block (`blocks` of the render: start line and node) and back; a scroll it made
  itself is ignored when its event arrives. Without a block map it scrolls in proportion. The block the
  editor is at gets a bar in the preview's margin; the source line gets none.
- **Keys** (`<acp-main-column>`, capture phase on the tab view, only for a markdown tab): Mod+K then V toggles
  Split (the chord waits 1.2 s), Mod+Shift+V Preview, Esc leaves Preview unless text is selected. Hints come
  from `shortcuts` (`markdownSplit`, `markdownPreview`). The preview has no find of its own: Mod+F searches
  the editor, so it does nothing in Preview.
