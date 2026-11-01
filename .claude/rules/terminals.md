---
paths:
  - "src-tauri/src/terminal/**"
  - "src-tauri/src/commands/terminal.rs"
  - "src/hooks/terminals/**"
  - "src/stores/terminals/terminals.js"
  - "src/components/terminal/**"
  - "src/services/file-drop/file-drop.js"
  - "src/models/file-drop/file-drop.js"
  - "docs/specs/terminal-tab.md"
  - "web-test-runner.config.mjs"
---

# Terminals

Spec: `docs/specs/terminal-tab.md`. A Terminal tab runs the user's default shell
(`terminal::shell::default_shell()`: `$SHELL`, the account's shell, `/bin/zsh`; agents' login-shell
environment uses the same) as a login shell in a PTY (`src-tauri/src/terminal/`, `portable-pty`),
started in the active session's folder, else the project, else home (New Terminal: ⌃\`, the macOS
*Terminal* menu), or a session's folder (session menu → Open in → Terminal). The backend refuses a
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
`ChildKiller`). Frontend: `$terminals` (`stores/terminals/terminals.js`, in
memory; `$projectTabs`' `parse` drops terminal tabs) and the `terminals` hook
(`hooks/terminals/terminals.js`, its pure rules in `rules.js`): `connect()` (the tab view's `terminalConnect`) starts a shell when its
tab is first shown and reattaches a remounted `<acp-terminal>` (xterm.js, WebGL renderer where available, else the DOM one; a moved one, as a tab reorder moves it, builds its screen again); a shell keeps running
while its tab or project isn't shown; a terminal's shell is closed once its tab leaves its project's
tabs (any close, its project removed); exit 0 closes the tab (`closeProjectTab()`), any other exit
keeps it with Restart. The previous page load's shells are closed (`close_window_terminals`) by `terminals.start()`, first thing in `<acp-app>`, and before any attach or close. "Open in → Terminal" is `sessionController.openInTerminal()` (a hook may not import a controller). `paste(text)` pastes as the user would (bracketed when the program asked for it, else line
breaks become spaces), kept until the shell is connected. Files dropped from the OS on a running terminal (a tab, or a
session's CLI) are typed in as shell-escaped paths plus a space (`terminals.shellPaths()`,
`hooks/terminals/rules.js`), like a native terminal: Tauri's native drag and drop
(`dragDropEnabled: true`) → `onFileDrag()` (`ipc.js`) → `fileDrop` (`services/file-drop/file-drop.js`:
position to CSS px — physical on Windows, logical on macOS / Linux — and the innermost
`DROP_TARGETS` element under it through shadow roots, `models/file-drop/file-drop.js`; `$fileDropTarget`
while over one, a `drop { target, paths }` event) → the column that renders the target pastes
(`<acp-agent-column>`; `<acp-main-column>`, which gives the tab view `droppingTerminal`) and sets
the terminal's `dropping` outline (`acp-chat` is a target too: see `sessions.md`). The tab view asks before closing a terminal whose foreground program isn't
its shell (`terminal_busy`). xterm draws nothing out of view: frontend tests give each test file its
own browser window (`web-test-runner.config.mjs`) and remove their terminals after each test.
