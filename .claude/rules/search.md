---
paths:
  - "src/components/search-dialog/**"
  - "src/components/search-panel/**"
  - "src/components/search-options/**"
  - "src/components/search-results/**"
  - "src/controllers/find-in-files/**"
  - "src/hooks/search/**"
  - "src/stores/search/search.js"
  - "src-tauri/src/roots/search.rs"
  - "docs/specs/search-dialog.md"
---

# Search in files

Spec: `docs/specs/search-dialog.md`.

## Two searches, two slots

- The **search dialog** (`<acp-search-dialog>`, Mod+Shift+F) lives in `<acp-app>`, wired by `<acp-search-view>` (`views/search-view/`: stores, the search slot, folder questions; it fires
  `acp-search-open` / `-popout` for the app); the **Search pane**
  (`<acp-search-panel>`, the nav rail's Search button) in `<acp-file-column>`, wired by `<acp-search-pane>`
  (`views/search-pane/`: the search slot, `acp-file-open` for a match, `show(state)`). Each view hosts its
  own `FindInFilesController({ slot })`: `'dialog'` in `<acp-search-view>`, `'panel'` in `<acp-search-pane>`.
- `find_in_files` / `cancel_search` take the slot; the backend `Root` keeps a cancel flag per slot,
  so a new search cancels only its own slot's, and closing the root cancels both. A controller runs
  only while `setActive(true)`: the dialog's on its first `-query`, off on `-close`.
- While the dialog is open, `<acp-app>` ignores its other shortcuts (Mod+P, Mod+Shift+T, Ctrl+\`);
  Mod+Shift+F selects the query again.

## Shared blocks

- `<acp-search-options>` (match case / whole word / regex, Alt+C / W / R) and `<acp-search-results>`
  (grouped or flat rows, selection by key, `move()` / `moveTo()`) are presentational and used by both.
  Results carry root-relative paths; the container makes them absolute (`projects.absPath`).
- The dialog's own parts are presentational too: `<acp-search-header>` (title, preview placement, Open in panel:
  `acp-search-header-preview { position }` / `-popout`), `<acp-search-bar>` (query field, clear, the options;
  `acp-search-bar-input { value }` / `-clear`, `focusInput()`), `<acp-search-view-picker>` (`acp-search-view-pick { view }`),
  `<acp-search-recent>` (`acp-search-recent-pick { query }`) and `<acp-search-empty>` (an error or nothing found,
  `acp-search-empty-action { action }`); the dialog turns their events into searches and prefs.
- A match opens selected: `<acp-main-column>.openFile(abs, { line, column, length })`; the 1-based
  column is `offset + start + 1` (`LineMatch.offset` counts UTF-16 units cut from a long line's start).

## Folder and mask filters

- The dialog keeps a root-relative `folder` and a `mask`, shown by `<acp-search-filters>` (the two chips and
  their menus: it fires `acp-search-filter-change { which, value }`, `-folders { query }` and `-leave`, and the
  dialog searches, answers the folder asks and returns focus to the query); `search.filters(folder, mask)`
  (`hooks/search/`, `filters.js`) turns them into the backend's `include` / `exclude`: comma-separated
  globs (commas inside `{…}` or `[…]` don't split), a leading `!` excludes, a pattern without `/`
  matches a name at any depth; includes go inside the (glob-escaped) folder, and with none the folder
  alone is the include.
- The folder menu asks with `acp-search-filter-folders`, which the dialog re-fires as `acp-search-dialog-folders { query }`; `<acp-search-view>` answers with
  `quickOpen(rootId, query, 'dirs')` into `folders` **and** `foldersQuery` (the query it answers).
  Enter in the menu's field picks only from a list whose `foldersQuery` is the latest query asked, so
  a late answer never picks a folder for older typing.

## Persistence

- `$searchDialogPrefs` (`brama:search:dialog`, shared): preview placement, view, splits; written by
  `setSearchDialogPrefs(patch)` on the dialog's `-prefs`.
- `$projectSearch` (`brama:search:project:<project path>`, per window, `setKey()` only): the last
  query, options, folder and mask (`saveProjectSearch` on every `-query`) and 10 recent queries
  (`addRecentSearch` when a match is opened or the search is popped out to the pane).
