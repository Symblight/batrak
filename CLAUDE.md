# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev             # Rsbuild dev server (port 1420; full reload, no HMR)
pnpm build           # Build to dist/
pnpm tauri dev       # Run the desktop app (Tauri, src-tauri/)
pnpm typecheck       # tsc over the JSDoc types (no emit); must stay clean
pnpm test            # frontend tests: @web/test-runner in Chrome; must pass
cd src-tauri && cargo test --lib      # backend tests; must pass
cd src-tauri && cargo clippy --all-targets   # no warnings
cd src-tauri && cargo test --lib real_claude -- --ignored --nocapture   # real Claude Code over ACP (network, login)
cd src-tauri && cargo test --lib real_registry -- --ignored   # the real ACP registry and its ETag (network)
cd src-tauri && cargo test --lib real_npm -- --ignored        # a real `npm cache add` prefetch (network, npm)
```

## Architecture

Frontend is **JavaScript with JSDoc types** — no `.ts` sources (only `src/env.d.ts`). Type-checking via
`jsconfig.json` (`checkJs`, `strict`). UI is Lit web components; the Rust backend lives in `src-tauri/`
and is reached through `src/services/ipc.js`.

- `src/components/` — one folder per custom element (see "File structure" below).
- `src/stores/` — global state as nanostores atoms, one file per domain (see "Global state" below).
- `src/services/` — actions and IPC (`project-controller.js`, `session-controller.js`, `ipc.js`, `theme.js`).
- `src/controllers/<feature>/` — Lit `ReactiveController`s (`PascalCaseController.js`), one folder per
  feature, never colocated with the component that first uses them. One `config` object typed by a
  `@typedef`.
- `src/models/types.js` — shared JSDoc typedefs.
- `src/styles/tokens.css` — global app tokens, imported once from `src/main.js`.

Third-party elements: `@symblight/wc-material` (`md-*`), `@symblight/code-editor` (`cdx-*`),
`@symblight/tree-view` (`tvx-*`), `@symblight/chat` (`chx-*`).

### Layers

- **Data layer** (infrastructure): `src/stores/` (nanostores atoms and their actions) and
  `src/services/` (backend calls, controllers that write stores), plus every browser API that holds or
  fetches state outside the page: `localStorage` / `sessionStorage` (only in `stores/`, through
  `persistent.js`), `history` / `location`, `fetch`, the clipboard, `matchMedia`, and
  `@tauri-apps/*` (only in `services/ipc.js`). Nothing above it talks to these directly.
- **Container components** — `<acp-app>` and the columns (`<acp-session-column>`,
  `<acp-agent-column>`, `<acp-main-column>`, `<acp-file-column>`) — are the only components that import
  from `stores/` or `services/`. They subscribe (`StoreController`), call actions and services, and pass
  data down as properties, through their children to the leaves (`<acp-chat>` hands the composer's
  pickers theirs, `<acp-tab-view>` the Settings, Agents and Changes tabs theirs).
- **Every other component is presentational:** data in through properties, intents out as `acp-*`
  events that the column handles (they bubble, composed, through the components in between). No
  imports from `stores/` or `services/`, no `StoreController`, no storage, network or clipboard APIs.
  A child that needs data gets a property; one that must change data fires an event. Where an answer
  belongs to one request, the container calls the child back (`<acp-changes-panel>`'s
  `commitFinished()`, `fillAmendMessage()`; `saveFinished()` of `<acp-agent-form>` and `<acp-agents-view>`); a lazy loader is a property (`<acp-file-tree>`'s
  `listDir`); a query is an event answered by a property (`acp-quick-open-query` → `files`,
  `acp-chat-file-query` → `fileOptions`, `acp-search` → `results`, `acp-agents-query` → `view`).
- A controller counts as part of its host. The data controllers (they read stores or call services)
  are hosted only by a container: `ChatSessionController`, `ChatPartsController` (agent column),
  `TabFilesController` (open tabs' files: reads, baselines, drafts, kept in memory while another
  project is shown, saves; a save over a file
  changed on disk since its draft started, `changedOnDisk`, is refused until the tab view's
  Overwrite / Reload dialog answers; a text file deleted on disk stays shown, `deletedOnDisk`, and
  a save creates it again, like VS Code) and `ChangesReviewController`
  (the Changes tab's expanded files and diffs; main column), `FindInFilesController` (file column).
  The others are pure and go anywhere: `EditorCommentsController` takes the host's `comments` /
  `commentFocus` and fires `acp-comment-add` / `-edit` / `-delete` / `-revealed`,
  `SelectionActionsController` fires `acp-chat-add`; `FloatingController`, `SortableController`,
  `ContextMenuController`, `TabContentController`. `models/` stays pure (no stores, no services):
  shared pure helpers live there (`paths.js`, `settings.js`, `config-options.js`, `about.js`), not in a
  store module.

### Global state

[nanostores](https://github.com/nanostores/nanostores) atoms in `src/stores/`, named `$camelCase`.

- **State → store, streams → events.** Anything a component renders or another component needs lives in a
  store. One-off happenings stay events: DOM `acp-*` events for UI intents (`acp-file-open`), and
  `projectController`'s `fs-change` for watcher batches. Don't mirror a store into a reactive property or
  re-announce it with an event.
- **Actions live next to their store** (`openTab()` / `closeTab()` in `stores/editor.js`) or, when they
  call the backend, in a service that writes the store (`projectController.open()` / `restore()` →
  `$workspace`). Container components call actions (see "Layers"); nobody `set()`s stores other modules own.
- **Narrow with `computed`.** `$rootId` (from `$workspace`) and `$activePath` (from `$editorTabs`) notify
  only when their slice changes, so subscribe to the narrowest store you need.
- **Container components subscribe with `StoreController`** (`src/controllers/store/`):
  `#workspace = new StoreController(this, { store: $workspace })`, read `this.#workspace.value` in
  `render()`. It re-renders the host on change; `onChange(value, oldValue)` runs a side effect (also once
  on connect). Outside a component, or for a one-off read in a handler, use `$store.get()`.
- **Persistence:** `persistentStore(key, initial, { parse, serialize?, listen? })` (`stores/persistent.js`)
  keeps an atom as JSON in `localStorage` under a `brama:` key. `parse` validates what was stored (`null`
  → `initial`), `serialize` drops runtime-only fields (`Workspace.rootId`). `listen: false` for per-window
  state (folder, tabs); leave it on for shared preferences (column widths, settings) so all windows
  stay in sync through `storage` events. Per-window state keyed by something (tabs by project) uses
  `persistentMapStore(prefix, parse)` instead: one item per key, written only through `setKey()`, so two
  windows never overwrite each other's other entries — never `set()` it.
- Persisted today: `$columnWidths` (`brama:layout:column-widths`), `$hiddenColumns`
  (`brama:layout:hidden-columns`, shared; the toolbar's buttons toggle the sessions and file columns), `$workspace` (`brama:workspace`, reopened
  on launch by `projectController.restore()`), `$projectTabs` (`brama:editor:tabs:<project path>`; the
  active project's entry is `$editorTabs`, which shows only files inside it; a tab id is a file's path
  or a view's id (`SETTINGS_TAB_ID`, one long card of sections (Theme, Editor) with a list
  beside it that scrolls to them and follows the scroll; `openSettings(reveal)` sets `$settingsReveal`
  and the tab scrolls there and answers `acp-settings-revealed`; `AGENTS_TAB_ID`, the Agents tab
  (see "Agents over ACP"), opened by `openAgents(reveal)` (`$agentsReveal`: the registry's agents
  to add, or an agent's row; answered by `acp-agents-revealed`); `CHANGES_TAB_ID`, every changed file expanding into its diff, which a
  click in the Changes side pane opens, expands and scrolls to; `terminalTabId(id)` (`models/tab-ids.js`), one per
  terminal, see "Terminals"; `BROWSER_TAB_ID`); `parseTabId()` tells them apart.
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
  `$contextUsage` (`brama:sessions:context-usage:<session id>`, see "History"),
  `$projects` (`brama:projects`, shared; every opened folder is added, `projectController.remove()` drops it
  from the app only), `$collapsedProjects` (`brama:projects:collapsed`) and `$settings` (`brama:settings`,
  shared: appearance and accent, which `services/theme.js` turns into the MD3 palette and `data-theme` on
  `<html>`, and the code editor's font; key dark-only CSS on `:root[data-theme='dark']`, never on
  `prefers-color-scheme`, since Appearance can override the OS). Typedefs for each are in
  `src/models/types.js`.

**Sessions:** `stores/sessions.js` holds `$sessions` (listed), `$draftSessions` (id → project id: a
"New session" with no message yet, not listed) and `$activeSessionId`, which is also the chat's
conversation id; `$activeSession` is `null` for a draft. `sessionController` keeps the active session in
the opened project (`showProject()`: the project's last shown session (`brama:sessions:last:<project path>`, per window, so it
survives a relaunch), its newest, or a new draft),
`create()`s drafts and `start()`s one on its first message. Showing a session resumes its stopped
agent; a hidden one's agent is stopped after 10 min idle (`IDLE_STOP_MS`). The composer's state is per session
(`$composer` is the active session's entry). One `<chx-chat>` holds every session as a conversation
(messages cached per id, a hidden session's reply keeps streaming), bound by `ChatSessionController`
(`src/controllers/chat-session/`, on `<acp-agent-column>`, reaching the chat through `<acp-chat>`'s
`chat`): `activeConversationId`, the draft's first send (put back into
the composer when the backend refuses the session), and each session's unsent composer text and files.
Statuses come from the backend's session events. A draft shows only the composer, centered; the message
list appears with the first message. Replies come over ACP (see "Agents over ACP"); messages live only
in the chat element, and an agent with `session/load` replays them when it starts again.

**Agent comments:** line comments typed in any `cdx-code-editor` live in `$comments` (`stores/comments.js`,
by absolute path, in memory). Every editor's `<cdx-comments>` is controlled through
`EditorCommentsController` (`src/controllers/comments/`): `.comments=${this.#comments.threadsOf(path)}`,
and its submit / edit / delete become `acp-comment-*` events that `<acp-main-column>` turns into store
actions, so one file shown twice (a tab and the
Changes tab) stays in sync. `<acp-comment-bar>` (over `<acp-main-column>`) steps through
`$tabComments` (the active tab's file, or every changed file in Changes) by setting `$commentFocus`: the main column shows the file,
the visible editor of it reveals the thread. Send to agent (`sendToChat()`) clears the comments from the code and hands them to the chat
(`addToChat()`, `stores/chat.js`); `<acp-agent-column>` takes `$chatInserts` into `<acp-chat>`'s composer
(`insertCode()`, once `composerReady()`): a comment as its
own line (file chip `path:line` or `path:from-to`, then the text), a selection as a chip at the caret.
`SelectionActionsController` (`src/controllers/selection-actions/`) shows `<acp-selection-actions>`
(Add to chat, as `acp-chat-add`; Comment) under the caret of a settled selection in the host's own editors: a manual
`popover` toolbar (top layer), placed by `FloatingController` (`src/controllers/floating/`, Floating UI
`computePosition` + `autoUpdate` against a virtual caret element), so it follows scrolling and hides
while the caret is out of view. Alt+F10 focuses it, arrows move between actions, Escape closes it,
and it closes when focus leaves both it and the editor (focus inside it returns to the editor). Editor
events are composed, so a host also hears its children's editors (the tab view hears the Changes
review's): controllers act only on `editorOf(event, renderRoot)` (`models/editor-events.js`).

### Agents over ACP

- **Config** (`src-tauri/src/config/`): opening a project creates `.brama/` (`agents.json`,
  `workspace.json`, `.gitignore` with `local/`), never overwriting. `workspace.json`'s
  `defaultMode` (`local` / `worktree`, anything else `local`; `worktree` only in a repository with
  a commit, since older projects got it written whether git or not) is the run target a new session's
  composer starts with (`$workspaceSettings`, read when the project opens); a worktree picks its
  base from `git_branches` (local branches, sessions' `brama/…` left out). A project's agents are its
  `.brama/agents.json` and nothing else; `<config dir>/brama/agents.json` is the agents of no
  project (the Agents tab with no project open). Nothing is built in, so a new project has no
  agent (the composer's picker offers Add ACP agent…, which opens the Agents tab at the registry's agents,
  and Manage agents…; a draft's send is refused with a notice).
  - **The Agents tab** (`<acp-agents-view>`, presentational; spec: `docs/specs/agents-tab.md`) renders
    `agents_view { projectPath, query, filter }` (`config/view.rs`) as is: the backend matches
    (case- and accent-insensitive, NFD via `icu_normalizer`; every term in the name, id, vendor,
    description or command line), ranks (name starts with it > a word of it does > it contains it >
    another field; with no query the default first, then by name), filters (`all` / `updates` /
    `off`; counts ignore the query) and marks the name's matches (UTF-16 ranges). `agentConfig`
    keeps `$agentsView` for `$agentsQuery` (in memory; the latest answer only), asked again on
    `agents://changed`, a project switch and when the tab shows. It lists only agents that run
    Claude, Codex, Copilot or Antigravity (`registryId` set; others in an agents.json still run, unlisted).
    Rows: installed agents (switch,
    Update, menu: Edit, Set as default, Remove), the user's own agents the project lacks
    (`AgentRow` from `AgentList.userAgents`, Add to project: `agents_import_user`, whole entries
    or `agentIds`, trusted unless the project's MCP servers start with them), and the registry's
    not installed (one-click Add, the only way to add one: no custom agents). `<acp-agent-form>`
    edits. `agentsList` stays for the composer, the trust dialog and session names.
  - **Writing agents.json:** the tab changes that one file (the user's with no project open),
    keeping its other content and key order (`serde_json` `preserve_order`) and refusing a file that
    doesn't parse; a launch is trusted at once only when it is exactly what the user chose there
    (that command and args, no `env`, no project `mcpServers`), else the trust dialog asks.
    `agents_add` takes only a supported registry agent (`known`, alias `registry`: its pinned
    launch, under its id, `<id>-2`… when taken; no `command`), `agents_import_user` only the user's
    agents that run one. Edit is `agents_update`, Set as default `agents_set_default` (refused for an agent that's
    off), Remove `agents_remove` with Undo on the snackbar (`agents_restore`, the entry back where
    it was, its switch too; `notify()` takes an `action` and a `timeout`). An invalid file keeps its
    last valid version and is reported as `file:line:col`.
  - **On/off** (`config/switches.rs`): per user, never in agents.json (the repository's), in
    `<app data>/agent-switches.json` by scope (canonical project path, `""` for the user's file;
    entries of agents the file no longer has are pruned on reload, a file that never parsed prunes
    nothing). An old `"disabled"` key is read, ignored and reported as a problem. An agent that's off
    is listed (`AgentSummary.enabled: false`), not offered by the picker, never started or probed,
    and waits for no trust; `defaultAgent` is the effective one (the file's if it's on, else the
    first that's on). `agents_set_enabled` goes through `emit_changed` and returns how many
    sessions turning off stops (the snackbar counts them).
  - **The ACP registry** (`config/registry.rs`, the only user of `ureq`; spec as above): a snapshot
    is bundled (`config/registry.json`, refreshed by hand at release), the last answer kept in
    `<app data>/acp-registry.json` with its `ETag` and checked again when a day old (launch, an
    hourly look, Check now: `agents_registry_check`), one check at a time, 15 s; a failure keeps
    what's there and marks it offline (`info`, not `warn`). A change emits `agents://changed` with
    `projectPath: null`. Only Claude, Codex, Copilot and Antigravity are read from it
    (`registry::SUPPORTED`; the rest are left out), and can be added (`AgentList.known`, pinned
    launches). Claude, Codex and Copilot run with `npx`; Antigravity, a `binary` in the registry,
    runs `agy_acp_server` from PATH (`Launch::Program`, `registry::ON_PATH`, this platform's
    args): the user installs and updates it, Brama never downloads an agent. An installed agent
    is matched by what it runs (`match_launch`: that program's name, or `npx` running the entry's
    package, its first `-p` / `--package` value or first non-flag argument, with or without
    `@version`), not by id;
    `AgentSummary.version` is the version its args pin, else `agentInfo.version` from its last
    `initialize` (`<app data>/agent-versions.json`); `update` (semver, `npx` agents only) is a
    newer registry version, `pin: true` when the installed one is unknown ("Pin latest").
  - **Updates** (`config/update.rs`, `Updater`): `agents_update_version` / `agents_update_all`
    pin the registry's version in place (`AgentConfigs::pin_versions`, one write; a trusted launch
    stays trusted when the pin is all that changed), emit `agents://changed` (running sessions get
    `agent-outdated`; nothing restarts), then `npm cache add <pkg>@<version>` (login-shell env, own
    process group, 5 min; a failure keeps the pin and `warn`s). A second Update of an agent joins
    the running one. The tab shows "Updating…" from the call until it returns (`$agentsPending`)
    and while the backend says an update runs (another window's).
  - **Following the list:** the watcher flags `.brama/agents.json` (`Changes.config`) → reload →
    `agents://changed`; the user's file has its own watcher (`config/watch.rs`, its folder,
    `projectPath: null`). The composer and the tab follow the list: a draft whose agent left it or
    was turned off gets the one a new session would, an edit form for it closes; sessions follow
    in the backend: every change that reaches `agents://changed` goes through
    `commands::agents::emit_changed`, which runs `Sessions::sync_agents` for the project. A
    session whose agent left the file, or was turned off, is stopped at once, a running turn
    finished first, and is in `error` ("no longer configured" / "Codex is off", plus an
    `unconfigured { reason: removed | off }` event; the banner offers Turn on for `off`), shown
    or not; a start that finds it so does the same.
    When the agent is back, or (for one that left the file, not one turned off) one that runs the
    same (`SessionRecord.launch`, kept at each start; for older sessions the last start line of its `agent.log`, and the session takes that agent's id, a
    `session` event), it is put back as it was: started again if it ran, else stopped. A running agent
    whose launch (command, args, env, MCP servers) the file changes keeps running; the page hears it
    once (`agent-outdated`, the banner's `outdated` notice with Restart, kept through turns; `null` when
    changed back). `Session.agentName` (kept at each start) names a started session's agent once it's
    gone ("Claude Code (removed)" in the picker, `agentInfo(id, name)`); `.brama/local/` is never in the
    snapshot.
  - **Secrets and trust:** `env` values take `${env:NAME}` (login-shell env) and `${keychain:name}`
    (service `brama`), resolved only at spawn: secrets never reach logs, IPC or files. The project's
    file is the repository's, so it can't make the app run anything on its own: an agent whose `command`
    / `args` / `env` it sets, or any start while it lists `mcpServers`, needs the user's trust in that
    exact `LaunchConfig` for that project (`agents_trust`, kept in `<app data>/trusted-agents.json`; a
    changed launch needs trust again). Untrusted, a start fails with an `untrusted` event and a probe is
    refused. `trustController` (`services/trust-controller.js`) asks in a confirm dialog at the top of
    `<acp-app>` when a project opens, its agents.json changes or a start is refused (`agents_untrusted`
    lists every launch waiting; `$trustPrompt`, `stores/trust.js`): Trust project trusts them all
    (`agents_trust`) and restarts the sessions it held back; Not now holds until what they run changes
    or a start is refused again (the session keeps its error notice, whose Restart asks again). A
    launch's `${keychain:…}` items are part of what is trusted, and the dialog names them. Agents can't
    write `agents.json`.
- **Signing in** (spec: `docs/specs/agent-sign-in.md`): an agent's AuthRequired (start, prompt or
  probe) puts the session in `error` with a `sign-in` event (its methods), and notes the launch as
  needing one (`AgentRow.status: signIn`). A prompt sent meanwhile is held (`held`), not failed:
  Stop, cancel or the agent leaving drop it (`prompt-returned`, back into the composer). The banner
  offers the agent's `agent` methods and Retry (`agents_sign_in`, `methodId: null` only checks, for
  a login done in a terminal); once a sign-in, Retry or probe works, every session waiting on that
  launch starts again and sends its held prompt. A `terminal` / `command` method (`acp/auth.rs`
  `login_command`: the launch plus the method's args and env, or the agent's own command) runs in a
  terminal the backend opens for the calling window (`Terminals::open_program`, cwd
  `<app data>/probe`); `agents_sign_in` returns its `LoginTab` (also in `agents://sign-in`'s
  `terminal`, which every window hears; a window joining another's login gets none back), which
  `openLoginTerminal()` shows as a running terminal tab among the sign-in's project's tabs
  (`TerminalInfo.login`: its command line as tooltip, no Restart: the sign-in runs it again); exit
  0 signs in (`Sessions::login_ended`), another exit fails, closing the tab cancels, and a cancel
  closes the tab (`noteSignIn()`). The banner offers every method but API keys, says which terminal
  to finish in (Show terminal only for this window's, `loginHere`), and with no method at all
  offers Open terminal, then Retry. The Agents tab's row offers Sign in (one method runs it, more
  open a menu, none is Retry), "Signing in…" while one runs (`AgentSignIn.pending`, or this
  window's `$signIns`) and why one failed; an agent added there is probed at once and the snackbar
  offers Sign in when it asks for one; the picker says "Needs sign-in" (`AgentSummary.signIn`,
  from `Sessions::agent_list`).
- **Sessions** (`src-tauri/src/session/`): `Sessions` owns every session (`sessions.json` in app
  data; all `stopped` after a restart). The agent starts on the first message, or when its session is
  shown (`resume`: a stopped one only, no `stopped` event; quietly left stopped while the project
  has its worktree's branch). Any number of `local` sessions of a project run; their turns share
  the checkout through a turn slot (`session/runtime/slots.rs`, spec:
  `docs/specs/parallel-sessions.md`): a turn takes it after `ensure_started` and holds it until it
  returns, a prompt sent meanwhile is `queued` (a `queued { holder }` event; saved as `idle`)
  and starts first come, first served; cancel, Stop, Remove, a crash or its agent leaving
  agents.json drop it from the queue (cancelled, never reaching the agent). Worktree sessions
  never queue, and neither do local ones with `.brama/workspace.json` `"localTurns":
  "parallel"` (read at each turn; set by editing the file, Settings has no control for it). Then the files each turn's tool calls change (diffs, and
  locations of calls whose kind isn't `read` / `search` / `fetch` / `think`; normalized, no `..`)
  are its `touched`, and a watcher batch of the project (`Sessions::note_changes`, from
  `Workspaces::open`'s callback; none for a project whose root isn't open) naming one that two
  turns touched, running or ended less than `overlap_grace` (1 s) ago, sends each running one an
  `overlap` (once per file per turn; a banner notice until the turn ends, over an `info` /
  `outdated` one that comes back then). Mode logic sits behind `SessionEnv` (`session/env/`: `local`,
  `worktree`); `env::place()` fixes where a new session runs (kept in its record), `for_session()`
  builds its env. A `worktree` session gets `<app data>/worktrees/<repo>-<hash>/<session id>` on
  branch `brama/<title slug>-<short id>` from `base_branch` (or HEAD), checked out in `prepare`
  (again from the branch if the folder was deleted; Stop mid-checkout, which git can't be
  interrupted in, sets `prepare_cancel` and `prepare` undoes it); its cwd is the project's folder in it. No
  repository, no commit or an unknown base refuses the create. Every agent path goes through
  `to_host_path` + `confine` (no `..`, no symlink out, nothing in `.git`); writes are atomic.
  `HOOK(git)` comments in `run_turn` mark the checkpoint points. `Sessions::remove` (session row
  menu → Remove session) stops the agent, unlists the session, deletes `sessions/<id>/`
  (transcript, log) and calls `SessionEnv::discard`: a no-op for `local`; `worktree` first commits
  uncommitted work onto its branch (`archive` → `git::apply::snapshot_commit`: scratch index, no
  hooks, CAS `update-ref`, Brama's identity when git has none), removes the worktree, and deletes
  the branch only when it has no commits past the base. A detached worktree (Check Out Branch)
  with uncommitted work is kept (a warning). At launch `Sessions::tidy_worktrees` (background)
  prunes worktree metadata and removes app-data worktrees no session owns, unless dirty (a
  warning); branches stay.
- **ACP host** (`src-tauri/src/acp/`): the only module using `agent-client-protocol` (pinned). One
  process per session in its own process group (stopped as a group; `process::stop_all` on app
  exit), stderr → `<app data>/sessions/<id>/agent.log`. Dispatch-loop callbacks never wait:
  permission responders are parked until the user answers. Tests run `acp/fake_agent.rs`
  in-process; `real_claude_agent_end_to_end` (ignored) runs the real agent.
- **Frontend**: each session's events come over a Tauri channel (`{ sessionId, seq, kind, payload }`,
  `update` = raw ACP `SessionUpdate`) into `handleSessionEvent` (`services/acp-adapter.js`), which
  maps updates to `<chx-chat>` chunks (text, `thought`, `tool_call`, `plan`) in the turn's stream,
  or replays them through `subscribe` outside a turn (`session/load`). Permission requests and
  notices live in `stores/session-runtime.js`, shown by `<acp-session-banner>` (a queued
  turn's names the session it waits for, with Show session, and says when that one waits for
  your answer; the run-target picker's Local says how many local sessions share the checkout,
  `$localShared`); `$agentList`
  (`services/agent-config.js`) feeds the agent picker. The agent's text renders as Markdown in
  `<acp-markdown>` (marked + DOMPurify, fences in `<chx-code-block>`, links via `open_url`), full
  width (`chx-message:not([own])` in `shadow.css`), with a caret while it streams. Parts rise in
  while their row is busy (`chx-message-row[aria-busy='true']` in `shadow.css`, CSS only: history and
  rows scrolled back don't replay; opacity and transform only, so row heights hold). A thought is `<acp-part-thinking>`: ACP never
  ends one, so the adapter ends it (`part-end`) at the next shown update or the turn's end, a live
  one timed in `data` (`startedAt`, `endedAt`); the last part of a cancelled reply shows as stopped.
  It also fills the list's `streaming` slot (no reply yet), untimed, instead of `<chx-streaming-indicator>`.
  `ChatPartsController` (`src/controllers/chat-parts/`) renders every message part; file refs
  (`models/file-refs.js`: `@path`, `path:12-23`, inline-code paths, links to files) become file chips
  and links (a folder is `@path/`), and a click on one, or on a tool call's location, fires
  `acp-file-open` (`<acp-app>` opens the tab and selects the file in the tree, expanding its folders);
  a folder's (a folder chip, or a ref the project lists as a folder, like `@.brama`) fires
  `acp-file-reveal` (no tab: selects and expands it in the tree, `AcpFileTree.reveal()`).
- **Session folders:** `Session.folder` is where the agent works (the project, or the project's
  folder in its worktree). Chat refs, tool-call locations and composer chips are relative to it
  (`folderOf()`, `$activeFolder`). A worktree session's files open as tabs of its project
  (`$worktrees`; `read_file` reads its folder through `Sessions::contains`), marked with a branch
  icon, no diff gutter, re-read when its turn ends; its folder refs
  reveal the project's same folder. While a worktree session is active, the Files tree lists its
  folder under a root row named after the worktree (`$treeRoot`, `stores/session-root.js`): the
  session root (`open_session_root`, its own scan and watcher, at most one per window) that
  `sessionRootController` keeps open; Search, Changes and Quick Open stay on the project
  (spec: `docs/specs/worktree-default.md`). A prompt path that is relative is the session's own copy; an
  absolute one inside the project is the user's file there (a selection quotes the project's text).
  A session's own Changes tab (`view:session-changes:<id>`, `models/tab-ids.js`, opened by
  `openSessionChanges()`; kept while it's a worktree session of the project; the session row menu no
  longer offers it, so nothing in the UI opens it now): `SessionChangesController`
  (main column) lists `session_changes` (commits and uncommitted work since `baseCommit`,
  `git::apply::changed_since`, in a scratch index seeded from the worktree's) when shown and after
  each of its turns, and diffs a file against `session_file_at_base`; `<acp-changes-review>` with
  `base` shows them without commit picks, with Apply locally and Check out branch (through
  `sessionController`).
- **Config options** (model, thought level, mode): the agent's own, from `session/new` / `session/load`,
  `config_option_update` and every `session/set_config_option` answer, reach the page as
  `config-options` events (an agent with only legacy `modes` gets a stand-in `mode` option set
  through `session/set_mode`). `applyAgentOptions()` (`stores/composer.js`) replaces the session's
  options and caches them per agent (`brama:agents:config-options`, keeping the agent's defaults
  as first learned), so a new session shows the real models before it starts. A new session starts
  with the user's last picks for its agent (`brama:agents:last-picks`; never a permission mode,
  category `mode`); a listed session without a composer this launch (after a reload) gets one
  from its record: its agent, `config`, run target, started. An agent with nothing cached is probed once per launch
  (`agents_probe_options` → `Sessions::probe_options`: started in `<app data>/probe`, `initialize` +
  `session/new`, no prompt, stopped). A pick goes through `sessionController.setConfigOption()`: shown at once,
  sent if the agent runs, else kept in `ComposerState.chosen` and sent when it starts. Each session
  keeps its own values (`SessionRecord.config`, by option id: the draft's picks at create, then
  every answer and update): a new start of its agent is set to them (`apply_config`, inside the
  start Stop aborts, each answer bounded by `initialize_timeout`) before anyone gets the connection, so an agent that forgets its model on restart or `session/load` doesn't drop it.
- **History**: each session's conversation is appended to `sessions/<id>/transcript.jsonl` (prompts,
  the turn's updates, turn ends; not `usage_update`, not a `session/load` replay); `session_history`
  returns it and `restoreHistory()` rebuilds the chat the first time a session is shown after a
  reload. Context usage (spec: `docs/specs/context-usage.md`) comes only from a running session's
  `usage_update`: `setContextUsage()` keeps its tokens (never the cost) in `$contextUsage`
  (`stores/context-usage.js`, `brama:sessions:context-usage:<session id>`, one item per session),
  so a session shows its last report after a reload or restart (no agent reports on
  `session/load`); `$activeContextUsage` feeds `<acp-context-meter>`, which shows only an empty
  ring until there is one.

### Terminals

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
`ChildKiller`). Frontend: `$terminals` (`stores/terminals.js`, in
memory; `$projectTabs`' `parse` drops terminal tabs) and `terminalController`
(`services/terminals.js`): `connect()` (the tab view's `terminalConnect`) starts a shell when its
tab is first shown and reattaches a remounted `<acp-terminal>` (xterm.js, WebGL renderer where available, else the DOM one; a moved one, as a tab reorder moves it, builds its screen again); a shell keeps running
while its tab or project isn't shown; a terminal's shell is closed once its tab leaves its project's
tabs (any close, its project removed); exit 0 closes the tab (`closeProjectTab()`), any other exit
keeps it with Restart. The tab view asks before closing a terminal whose foreground program isn't
its shell (`terminal_busy`). xterm draws nothing out of view: frontend tests give each test file its
own browser window (`web-test-runner.config.mjs`) and remove their terminals after each test.

### Background work

Commands are `async` and push disk/process work to `spawn_blocking`; nothing blocks the IPC thread.
Work that can be superseded must be cancellable, not just have its result dropped: Quick Open and
Find in Files check a flag, and a project scan (`Snapshot::scan_until`) stops when a newer
`open_workspace` from the same window starts (it then fails with `workspace::SUPERSEDED`, which
`projectController` ignores) or when its root closes. The editor reads only the active tab; other
tabs are read, or re-read after a change on disk or a HEAD move, when they become active.

**Open projects:** `projectController` keeps the backend roots (snapshot + watcher) of the last
`KEEP_OPEN` (3) active projects; activating one of them only switches `$workspace`, no scan. Older
ones are closed and scanned again when activated. Only the active root's changes reach the frontend
(`fs-change`); the others' watchers keep their snapshots and git caches current, and views keyed by
root (`gitController`'s stores and commit picks, the Changes tab's expanded files, the file tree's
expanded folders) save their state on switch and restore it, re-checking what may have changed. A
root belongs to the window that opened it: `Workspaces::close_group` closes a window's roots when it
is destroyed, and `close_window_workspaces` when its page loads again (before any open).

### Logging

`tracing` everywhere in Rust (`tracing::info!` / `warn!` / `debug!`, never `println!`), set up in
`src-tauri/src/logging.rs`: daily files `brama.<date>.log` in the app log dir (macOS:
`~/Library/Logs/dev.brama.app`, last 7 kept), plus stderr in dev builds. Default level is
`brama_lib=debug` in dev, `brama_lib=info` in release; `BRAMA_LOG` overrides it (an `EnvFilter`
directive). The panic hook logs every panic, from any thread, with a backtrace. The frontend logs through
`services/logger.js` (`log(level, message)`, `write_log` command, target `frontend`); `main.js`
calls `logUncaughtErrors()` for uncaught errors and unhandled rejections. Log at `info` for
what a user did or what took noticeable time (a scan), `warn` for failures, and `debug` for every
git call; never log file contents.

**Snackbars:** `<acp-snackbars>` (bottom-end, in `<acp-app>`) shows `$notices` (`stores/notices.js`:
`notify(level, message)`, the same message counts up instead of stacking, at most 4, info 5s / warn
8s / errors until dismissed, held while hovered). A `tracing` layer (`NoticeLayer` in `logging.rs`)
sends every `brama_lib` warn/error and panic to all windows as `app://notice`, whatever `BRAMA_LOG`
says — so a `warn!` is user-visible: use it for real failures only. In the frontend, a failed action
with no inline error goes through `reportError(what, err)` (`services/notices.js`: logs + snackbar);
uncaught errors and rejections show one too.

### Git

`src-tauri/src/git/` drives the `git` CLI (never libgit2), so the user's hooks, LFS and credential
helpers apply.

- Every call goes through `exec::run` / `run_with`: closed stdin, pipes drained on threads, a
  timeout, capped output, scrubbed `GIT_DIR`-style variables, `LC_ALL=C`. Use `Mode::Background`
  for refreshes the user didn't ask for (sets `GIT_OPTIONAL_LOCKS=0`, so they never take
  `index.lock`). The executable comes from `binary::git()`. At most 4 git processes run app-wide
  (`exec::MAX_CONCURRENT`); more callers wait for a slot.
- Anything that changes a repository runs inside `lock::with_mutation`, keyed by the common git
  dir, so a checkout and its worktrees are serialized together.
- Commands take root-relative paths only after `workspace::checked_rel()`.
- Commit (`git/commit.rs`, `git_commit`): the files picked in Changes go in as they are in the
  working tree (`commit --only`, untracked ones staged first and unstaged again if it fails, both
  sides of a rename); whatever else is staged stays staged and out. Amend with no files rewords
  only. During a merge, cherry-pick or revert (no partial commits) the picks are staged and the
  whole index committed. Paths go through stdin (`--pathspec-from-file`, `update-index --stdin`),
  never argv; never pass an empty pathspec file (git then commits the whole index). Hooks and
  filters run under `Mode::Hooks`: 10 min timeout, own process group, stopped with SIGTERM first
  so git removes `index.lock`. The tail of their output is the snackbar's error; it isn't logged.
- `worktree` backs worktree sessions (`add` / `attach` check out under `Mode::Hooks`: a big
  tree, LFS or a `post-checkout` hook outlast 10 s). `apply` backs a worktree session's Apply
  Locally (`session_apply_locally`: its commits and uncommitted work since `baseCommit` as an
  unstaged patch, `--3way` with a conflict list when the project moved on; applied from the
  project's folder, so changes outside it are left out) and Check Out Branch
  (`session_check_out_branch`: refused while the worktree is dirty, which a checkout would leave
  behind; stops the agent, detaches the worktree). Both are refused mid-turn and hold the turn
  slot while they run (`SlotGuard`), so no prompt starts under them. A worktree whose
  branch is checked out elsewhere doesn't start (`prepare`) until it can switch back to it. A
  dirty worktree is removed only after its work was committed (`remove_saved`).
- Frontend: `gitController` (`services/git-controller.js`) writes `stores/git.js` for the active root.
  `$gitRepo` (branch, upstream; `git_head`, no file scan) is kept current while a project is open:
  root change, `fs-change` with `git: true`, window focus. `$gitChanges` (changed files; `git_status`
  scans the working tree) is computed **only on demand**: `gitController.watchChanges()` starts it and
  keeps it fresh on every `fs-change` until the returned stop function runs — `<acp-file-column>`
  watches while Changes is the side pane, `ChangesReviewController` while the Changes tab is active
  (the column also forgets picks of files no longer changed). Stopping
  keeps the files in the store; the spinner shows only for a root's first status. The files picked
  for the next commit are `$commitSelection` (root-relative paths), shared by both. Changes are files
  only: `git status --untracked-files=all` lists new folders file by file. `$gitHead` changes only when HEAD moves; the editor
  reloads its diff baselines on it.
- **Cached git state** (`git/cache.rs`, one `GitCache` per `Root`): `git_head` / `git_status` reuse the
  last answer while the root's change epoch (bumped by the watcher after every batch that changed
  something) and a fingerprint of the repository files (mtime/size of `HEAD`, `index`, the HEAD ref,
  the upstream ref, `packed-refs`, `config`, `FETCH_HEAD`, `info/exclude` — covers a git dir outside the
  root) are
  unchanged. `git_status` takes the caller's `since` version and replies `unchanged` without the
  files; the frontend then keeps the same `files` array, so views neither rebuild nor re-read diffs.
  Refresh passes `force`. Changes inside ignored folders don't bump the epoch.

### Drag and drop

Reordering uses Pragmatic drag and drop through `SortableController` (`src/controllers/sortable/`):
`new SortableController(this, { selector, getId, axis, container, group?, onReorder })` registers the
items `selector` matches in the host's render root after every render; a drag over `container` reorders.
While dragging, the host hides the dragged item (`dragging`) and translates each item by `offsetOf(id)`,
animated only while dragging, so the others slide aside and open the slot it would land in; the slot
comes from the pointer against the items' midpoints measured when the drag starts (live rects move
mid-slide and make the slot flicker), corrected for the container's scroll since. Tabs use it (`moveTab()`; `group` keeps
pinned tabs among pinned). The library reads
`event.target` at `document` and uses `closest()`, which shadow DOM stops at the outermost host, so
it is patched (`patches/@atlaskit__pragmatic-drag-and-drop@4.0.0.patch`: draggables and drop targets
are found on the composed path, lookups continue through shadow hosts, and the element under the
pointer is looked up inside shadow roots). `container` auto-scrolls along `axis` near its edges
(`-auto-scroll`, patched the same way). Re-check both patches when upgrading.

### Column resizing

`ColumnResizeController` (`src/controllers/resize/`) + `<acp-resize-handle>`, dragged with pointer events
and pointer capture — no drag-and-drop library (Pragmatic drag and drop reads `event.target` at
`document`, which shadow DOM retargets to the outermost host, so it never finds a handle in a shadow root).

- The handle fires `acp-resize-start` / `acp-resize` / `acp-resize-end` (drag),
  `acp-resize-step` (arrow keys) and `acp-resize-reset` (double-click), detail `{ name, delta }`, with
  `delta > 0` always meaning "wider" (`edge="start"` flips the pointer direction).
- A host owns its columns: `new ColumnResizeController(this, { store: $columnWidths, columns: { name: {
  property, min, max } } })`. It handles events whose `name` it knows (and stops them) and re-renders
  the host, which binds `controller.columnStyle(name)` (inline `flex-basis` / `width`) on the column —
  never a custom property on the host, whose change restyles the whole app every frame; a drag stays
  local until it ends, then lands in the store (reset removes the key). Column names are keys of the
  shared store, so they're unique app-wide. The default width is that property's value on `:root`
  from `tokens.css` — don't repeat it in JS. Bind `controller.column(name)` onto the handle's
  `value`/`min`/`max`.
- The parent places the handle with a mix class (`z-index: 1; margin-inline: -4px`); the handle draws
  the divider line, so adjacent columns have no border on that side.
- A press becomes a drag after 3px of travel, so a click or the double-click reset stores nothing.
- A drag only moves width between the two columns beside the handle (splitter): on `-start` / `-step`
  the handle measures both rendered widths and the neighbor's CSS `min-width` (`ResizeMeasure`), and the
  change stops where either side hits its limit. A neighbor that's a resizable column too is its
  `partner` (`session` → `agent`) and gets the opposite width; otherwise it's a flex column that takes
  the slack itself.
- **Tauri `dragDropEnabled: false`** (window in `src-tauri/tauri.conf.json`): resizing no longer needs it,
  but any HTML5 drag-and-drop in the page does — with Tauri's native file-drop handler on, wry swallows
  `draggingUpdated`, so the page gets no `dragover` while the button is held.

## Tests first

Work test-driven: before changing behavior, write a test that fails for the missing or broken
behavior, see it fail, then make it pass, then clean up with the tests green. A bug fix starts with a
test that reproduces it.

- **Styles:** a change that is only CSS (a component's `.css`, `shadow.css`, `tokens.css`) gets no
  test, and no test asserts computed styles or custom properties, unless I allow it for that change.

- **Backend:** tests live next to the code (`#[cfg(test)] mod tests`, or `<module>/tests.rs` when
  long). Agent behavior is tested against the in-process fake agent (`acp/fake_agent.rs`; extend
  its scripts rather than mocking `Connection`), files against temp folders, git against
  `git/test_repo.rs`. Test what a caller sees (events, statuses, files on disk), not internals.
- **Frontend:** `@web/test-runner` (`web-test-runner.config.mjs`, real Chrome, mocha + chai) runs
  every `src/**/*.test.js`. A component's tests go in a `tests/` folder inside its own folder, named
  after it (`components/acp-x/tests/acp-x.test.js`); a plain module's sit beside it
  (`models/paths.test.js`). Keep logic in plain functions
  (`stores/`, `models/`, `services/acp-adapter.js`) and test it directly; test a component through its
  properties, events and rendered shadow DOM with `fixture()` from `test/fixture.js`.
- Before reporting work done: `cargo test --lib`, `cargo clippy --all-targets`, `pnpm typecheck` and
  `pnpm test` pass. Say which behavior was verified by a test, which by running the app, and which not at all.

## Commits

One commit per small task. When a task is done and the checks above pass, don't stop at the report:
ask me whether to commit it, showing the files it touches and the proposed message (imperative,
sentence case, no trailing period, like `Run agent sessions over ACP`; a body only when the why isn't
obvious). Commit only after I say yes, only that task's files, never `git add -A` over unrelated
changes. Don't push unless asked.

## Code conventions

- Private class members use native `#field` / `#method()` / `get #x()`, never the `_field` naming
  convention. Declare and initialise private fields in the class body, JSDoc on the declaration
  (`/** @type {number | null} */ #pendingLine = null;`, handlers as arrow-function fields); don't
  assign them in the constructor. Lit reactive properties (`static properties`) keep public names and
  are typed where the constructor initialises them.

### JSDoc

Every JS file is fully typed in JSDoc and checked by `pnpm typecheck` (`checkJs` + `strict`;
`maxNodeModuleJsDepth: 0` keeps tsc out of libraries' shipped JS).

- Each custom element class: `@tag` and a one-line `@summary`, plus `@fires <event> <detail>` for
  every event it dispatches. No prose paragraphs.
- Every function/method with parameters gets `@param` types; add a one-line description when the
  name doesn't say it all. Lifecycle methods (`constructor`, `connectedCallback`, `render`,
  `willUpdate`…) need no comment beyond types.
- Shared shapes are `@typedef`s in `src/models/types.js`, imported with
  `/** @typedef {import('../../models/types.js').X} X */`.
- No `any`. `src/elements.d.ts` maps every `acp-*` tag in `HTMLElementTagNameMap` (the `@symblight`
  libraries ship their own), so `querySelector('acp-x')` is typed — register each new element there.
  Cast an event once at the top of a handler: `/** @type {CustomEvent<{ path: string }>} */ (e).detail`.
- Keep comments minimal otherwise — comment only what isn't obvious from the code (a non-obvious
  constraint, a workaround, a gotcha).

## Styling conventions

- **CSS lives in a `.css` file next to its component**, imported with `?inline` and assigned directly:
  `import styles from './acp-toolbar.css?inline';` → `static styles = styles;`. `scripts/lit-css-loader.cjs`
  (wired in `rsbuild.config.js`) turns the import into a Lit `CSSResult`; `src/env.d.ts` types `*.css?inline` as
  `CSSResultGroup` (it deliberately doesn't reference `@rsbuild/core/types`, whose `*?inline` → `string`
  declaration would win). Never write `css\`…\`` blocks inside component JS.
- SVG icons (`@material-design-icons/svg`) are imported with `?raw` and rendered via `unsafeSVG()`,
  inside `<md-icon>` — size it with `font-size` on a class, don't style `svg` directly.
- **Shared shadow styles:** `src/styles/shadow.css` is the first stylesheet of every shadow root,
  the libraries' included (`src/styles/shadow-styles.js` hooks Lit's `finalizeStyles`; imported
  first in `main.js`). It holds what must match app-wide: thin scrollbars and menu density
  (`md-menu` / `md-menu-item` row height and padding; type sizes stay the library's). It's the one
  place tag selectors are allowed, because it must reach menus inside third-party shadow roots. A
  component sets only what differs (e.g. a menu's `--md-menu-min-width`), never menu density.
- Colors come from the app tokens in `src/styles/tokens.css` (`--md-surface`, `--md-on-surface-variant`,
  `--md-primary`, …, mapped from wc-material's `--md-sys-color-*`) and spacing from `--space-*`. No raw hex.
- **Scales live in `tokens.css`; no literals for them in components:** type (`--font-size-xs/sm/md/lg`,
  `--font-weight-medium`), icons (`--icon-size-xs…lg`, set as `font-size` on the icon's class), spacing
  (`--space-0-5…4`), corners (`--shape-corner-extra-small/small/medium/full`), state layers
  (`--state-hover/focus/pressed/disabled`), elevation (`--elevation-*`), stacking (`--z-*`), column limits
  and `md-button` vertical padding (`--button-block-space-compact/regular`). A one-off optical value stays
  a literal; add a token once a second place needs it. Prefer logical properties (`margin-inline-start`,
  `inset-block-end`, `text-align: start`).
- **Derived colors use `color-mix()`** over those tokens (hover/pressed tints, translucent fills,
  borders: `color-mix(in srgb, var(--md-primary) 12%, transparent)`), not a new token or an `rgba()`
  copy of one, so they follow the theme and accent.
- **Layout that depends on available space uses container queries** (`container-type: inline-size` on
  the host or a wrapper, `@container (width < …)`), not `@media` on the viewport: columns are resized
  and hidden, so a component's width isn't the window's. Name the container
  (`container-name: acp-<component>`) when a rule must target a specific one.
- **Use native CSS nesting** (`&`) for a node's states and its `@container` / `@media` rules, kept
  inside the selector they change (rules in "BEM" below).

### BEM

Shadow DOM already scopes styles; BEM is kept for **readability, flat predictable specificity, and
consistency** with the `@symblight` libraries. Skills `bem-css` (selectors, nesting, custom properties)
and `bem-lit-blocks` (block/element/modifier decisions, file structure) in `.claude/skills/` hold the
full rules — load them when writing or reviewing component CSS or structure.

- **Block = the custom element** (the host, `:host`). Classes are named after the tag:
  `acp-tab-view`, `acp-tab-view__tab`, `acp-tab-view__close-icon`.
- **Element** = a node in the component's own `render()`: `block__element`. Flat — no element-of-element
  (`a__b__c` means you found a new block).
- **Modifier** = `block__element_modifier` / `block_modifier` with a **single** underscore
  (`acp-app__files_with-code`, `acp-quick-open__item_selected`) — never `--modifier`. Host
  state/variant is a reflected attribute styled as `:host([attr])`. Content/data attributes are not modifiers.
- A **nested custom element is its own block**, never the parent's element. To place or size it, mix a
  parent element class onto it (`<md-icon class="acp-tab-view__close-icon">`,
  `<acp-file-tree class="acp-file-column__pane">`). A block sets no external geometry (margins, position).
- **No** tag selectors, `*`, `#id`, descendant combinators between entities, resets, or `!important`.
  Outer-tree rules already beat a child's `:host` rules, so a parent hides a child with
  `.parent__pane[hidden] { display: none; }` — no `!important`.
- **Native CSS nesting** only via `&`, for one node's own states: `&:hover`, `&::placeholder`,
  `&[active]`, `@container (…) { … }`. Write BEM names in full (`&__x` does not concatenate). Bare nesting (`.a { .b {} }`)
  creates a descendant combinator — don't. The `safari >= 18.2` build target (Tauri's WebKit on current macOS; no older fallbacks) keeps nesting, `@scope` and `scrollbar-color` native.
- Component custom properties are namespaced `--acp-<component>-*` (public) / `--_acp-<component>-*`
  (internal). Theme third-party elements through their own documented properties
  (`--tvx-tree-view-*`, `--cdx-status-bar-*`, `--md-tab-*`).

### File structure

Flex scheme: `src/components/` is a flat list of block folders, each holding the element's JS and CSS
under the tag name, and its tests in `tests/`:

```
src/components/
├── acp-tab-view/
│   ├── acp-tab-view.js
│   ├── acp-tab-view.css
│   └── tests/
│       └── acp-tab-view.test.js
└── acp-toolbar/
    ├── acp-toolbar.js
    ├── acp-toolbar.css
    └── tests/
        └── acp-toolbar.test.js
```

The element's tests live in a `tests/` folder inside its block folder, not in a global tree. No category grouping. Components import each other as `'../acp-x/acp-x.js'` and services as
`'../../services/x.js'`.
