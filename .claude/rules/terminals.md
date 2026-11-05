---
paths:
  - "apps/desktop/src-tauri/src/terminal/**"
  - "apps/desktop/src-tauri/src/commands/terminal.rs"
  - "apps/desktop/src/hooks/terminals/**"
  - "apps/desktop/src/stores/terminals/terminals.js"
  - "apps/desktop/src/stores/tab-group/**"
  - "apps/desktop/src/components/terminal/**"
  - "apps/desktop/src/components/terminal-action/**"
  - "apps/desktop/src/views/terminals-view/**"
  - "apps/desktop/src/views/terminal-view/**"
  - "docs/specs/terminal-panel.md"
  - "apps/desktop/src/hooks/file-drop/**"
  - "docs/specs/terminal-tab.md"
  - "web-test-runner.config.mjs"
---

# Terminals

Specs: `docs/specs/terminal-tab.md` (the shell) and `docs/specs/terminal-panel.md` (where it lives). A terminal runs the user's default shell
(`terminal::shell::default_shell()`: `$SHELL`, the account's shell, `/bin/zsh`; agents' login-shell
environment uses the same) as a login shell in a PTY (`src-tauri/src/terminal/`, `portable-pty`),
started in the shown folder (Main's or the workspace's, `$shownFolder`), else the project, else home (New Terminal: ⌃\`, the macOS
*Terminal* menu, the panel's `+`, and the nav rail's first click), a session's folder (session menu → Open in → Terminal), or a file tree row's folder (its menu → Open in → Terminal). The backend refuses a
cwd outside open roots, session folders (`Sessions::contains_folder`) and home; a missing one falls
back to the project. `Terminals` owns every shell by window (closed on window destroy, page load
(`close_window_terminals`) and app exit; the terminal commands refuse, or skip, another window's
ids: `Terminals::owns` / `of_group`); a reader thread keeps the last 1 MiB of output (cut at a
line start) and streams raw bytes to the attached channel (`terminal_attach`, which replays it
first), pausing once `FLOW_PAUSE_AT` is sent and not yet drawn (the page acknowledges in
`ACK_EVERY` steps, `terminal_ack`). A waiter thread reports the shell's exit, without waiting for
a background job that still holds the PTY. Input goes as raw bytes (`terminal_write`, id in the
`terminal-id` header), so xterm's binary mouse reports arrive intact. Input and output are never
logged. Keep it portable: unix-only parts behind `cfg(unix)` with a Windows path (ConPTY,
`ChildKiller`). Frontend: `$terminals` (`stores/terminals/terminals.js`; a tab's terminal is saved, `$savedTerminals`, and comes back with a new shell once shown, its output gone) and the `terminals` hook
(`hooks/terminals/terminals.js`, its pure rules in `rules.js`): `connect()` (passed by `<acp-terminal-view>`) starts a shell when its
tab is first shown and reattaches a remounted `<acp-terminal>` (xterm.js, WebGL renderer only while shown and where available, else the DOM one; a moved one, as a tab reorder moves it, keeps its screen); a shell keeps running,
and its screen stays mounted (`<acp-terminals-view>` has a tab view per folder, the shown one's in front), while its tab, workspace or project isn't shown; a terminal's shell is closed once its tab is in neither its
folder's terminal group nor its editor tabs (any close, its project removed: `removeProjectTerminals()`, which also closes the project's terminals in its workspaces' folders, `TerminalInfo.projectPath`); a workspace's are closed, their shells awaited, before it is deleted (`terminals.closeFolder()`);
exit 0 closes the tab (`closeTerminalTab()`, in whichever group holds it), any other exit
keeps it with Restart. The previous page load's shells are closed (`close_window_terminals`) by `terminals.start()`, first thing in `<acp-app>`, and before any attach or close. "Open in → Terminal" is `sessions.openInTerminal()` (a hook may not import a controller). `paste(text)` pastes as the user would (bracketed when the program asked for it, else line
breaks become spaces), kept until the shell is connected. Files dropped from the OS on a running terminal (a tab, or a
session's CLI) are typed in as shell-escaped paths plus a space (`terminals.shellPaths()`,
`hooks/terminals/rules.js`), like a native terminal: Tauri's native drag and drop
(`dragDropEnabled: true`) → `ipc.onDragDrop()` → `fileDrop` (`hooks/file-drop/file-drop.js`:
position to CSS px — physical on Windows, logical on macOS / Linux — and the innermost
`DROP_TARGETS` element under it through shadow roots, `hooks/file-drop/rules.js`; `$fileDropTarget`
while over one, `fileDrop.onDrop()` listeners get `{ target, paths }`) → the column that renders the target pastes
(`<acp-terminal-view>` for a terminal tab; a session's CLI, which the same view shows with a
`session-id`, gets them through `SessionInputController` in `<acp-agent-column>` and `$pendingInput`)
and sets the terminal's `dropping` outline (`acp-chat` is a target too: see `sessions.md`). The tab view asks before closing a terminal whose foreground program isn't
its shell (`terminal_busy`). xterm draws nothing out of view: frontend tests give each test file its
own browser window (`web-test-runner.config.mjs`) and remove their terminals after each test.

**The terminal panel** (`<acp-terminals-view>`, `src/views/terminals-view/`): a row under the agent and
editor columns (`<acp-app>`'s layout, see `column-resize.md`), a second *tab group* rather than a second tab system.
`tabGroup()` (`stores/tab-group/`) holds the open / close / move / pin rules once, over a per-folder map store; the editor's
group is `$folderTabs` / `$editorTabs` and the panel's is `$folderTerminalTabs` / `$terminalTabs` (`terminalGroup`, in memory,
terminal tab ids only). The view is an `<acp-tab-view>` (strip, confirm, one mounted panel per tab) with its `add` slot
(`<acp-terminal-action action="new">`, right after the last tab) and `actions` slot (`action="hide"`), its events turned into
`terminalGroup` actions. Per folder (Main's or a workspace's, `TerminalInfo.folder`): `$folderTerminalPanels` (`{ open }`), the tabs, the height
(`$folderTerminalPanelHeights`, persisted); the panel is shown only while open *and* it has a terminal (the hook hides it
with its last one), and stays mounted while hidden. Entry points open a tab in a project's group and show its panel: the nav rail runs `terminals.showPanel()` (hidden with no terminal: shows it with a first one in the shown folder;
hidden with terminals: shows them as they were, adds none; shown: asks to focus the active one, `$terminalFocus`, answered by
the view), `terminals.newTerminal()` (`+`, ⌃\`, the menu) and `openInSession()` call `openTerminal()` (the shown folder's),
and a sign-in's login (`openLoginTerminal()`) opens in the folder shown when the sign-in started (a login moved to the editor is shown there). `terminals.hidePanel()` (`−`) stops no shell. A terminal tab dragged out of the
panel's strip onto the editor's moves the terminal: `moveTerminalToEditor()` opens it in the editor's group, then closes it in the
panel's, so its shell is never without a tab (drop targets: see `drag-drop.md`); the editor's tab view still renders and confirms
terminal tabs, and nothing else opens them there. Nothing moves back.
