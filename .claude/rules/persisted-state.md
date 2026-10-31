---
paths:
  - "src/stores/**"
  - "src/models/tab-ids/tab-ids.js"
  - "src/controllers/tab-content/**"
  - "src/components/tab-view/**"
  - "src/views/main-column/**"
  - "src/components/image-preview/**"
  - "src/components/settings/**"
  - "src/services/theme/theme.js"
---

# Persisted state and tabs

- Persisted today: `$columnWidths` (`brama:layout:column-widths`), `$hiddenColumns`
  (`brama:layout:hidden-columns`, shared; the toolbar's buttons toggle the sessions and file columns), `$workspace` (`brama:workspace`, reopened
  on launch by `projectController.restore()`), `$projectTabs` (`brama:editor:tabs:<project path>`; the
  active project's entry is `$editorTabs`, which shows only files inside it; a tab id is a file's path
  or a view's id (`SETTINGS_TAB_ID`, one long card of sections (Theme, Editor) with a list
  beside it that scrolls to them and follows the scroll; `openSettings(reveal)` sets `$settingsReveal`
  and the tab scrolls there and answers `acp-settings-revealed`; `AGENTS_TAB_ID`, the Agents tab
  (see `agent-config.md`), opened by `openAgents(reveal)` (`$agentsReveal`: the registry's agents
  to add, or an agent's row; answered by `acp-agents-revealed`); `CHANGES_TAB_ID`, every changed file expanding into its diff, which a
  click in the Changes side pane opens, expands and scrolls to; `terminalTabId(id)` (`models/tab-ids/tab-ids.js`), one per
  terminal, see `terminals.md`; `BROWSER_TAB_ID`); `parseTabId()` tells them apart.
  `TabContentController` (`src/controllers/tab-content/`) picks the view for a tab's content
  (`ContentKind`: a file is `markdown` / `image` (SVG too) by extension, else `code`; a view tab by its
  kind) and renders it with the host's view for that kind; only `readsFile()` tabs are read from disk:
  text, or an image's bytes (`read_file_bytes`, at most 64 MB) as `EditorTab.image`, a `Blob` that
  `<acp-image-preview>` shows centered (never scaled up) over a checkerboard (`background="auto"`: the
  column's), with a footer of resolution, type and size. Markdown and browser views are mocks
  for now. Pinned tabs (`EditorTabs.pinned`) lead the strip and survive Close Others / Close Tabs to the Right / Close All. Everything in `<acp-main-column>` opens as such a
  tab. View tabs need no project: with none open, `$editorTabs` is the `''` entry, which holds only them),
  `$projectExpandedFolders` (`brama:file-tree:expanded:<project path>`, per window like the tabs; the
  active project's entry is `$expandedFolders`, root-relative folders the file tree is controlled by: it
  sends the user's expand/collapse up (`acp-expanded-change`, the file column writes it) and expands
  stored folders as their parents load),
  `$contextUsage` (`brama:sessions:context-usage:<session id>`, see `sessions.md`),
  `$searchDialogPrefs` (`brama:search:dialog`, shared: the search dialog's preview placement, view
  and splits), `$projectSearch` (`brama:search:project:<project path>`, per window, one item per
  project through `setKey()`: the dialog's last query, options, folder and mask, and the project's
  10 recent searches; two windows on one project: last write wins),
  `$projects` (`brama:projects`, shared; every opened folder is added, `projectController.remove()` drops it
  from the app only), `$collapsedProjects` (`brama:projects:collapsed`) and `$settings` (`brama:settings`,
  shared: appearance and accent, which `services/theme/theme.js` turns into the MD3 palette and `data-theme` on
  `<html>`, and the code editor's font; key dark-only CSS on `:root[data-theme='dark']`, never on
  `prefers-color-scheme`, since Appearance can override the OS). Typedefs for each are in
  `src/models/types/types.js`.
