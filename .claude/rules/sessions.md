---
paths:
  - "src-tauri/src/session/**"
  - "src-tauri/crates/agent-acp/**"
  - "src-tauri/src/agents/**"
  - "src-tauri/src/commands/sessions.rs"
  - "src/hooks/{sessions,chat,composer}/**"
  - "src/stores/{sessions,session-sync,session-runtime,session-read,composer,context-usage,clock,chat}/**"
  - "src/views/agent-column/**"
  - "src/views/chat-view/**"
  - "src/components/{chat,session-*,markdown,part-thinking,context-meter,mode-picker,agent-picker,model-picker}/**"
  - "src/controllers/{chat-session,chat-parts,workspace-changes,session-actions}/**"
  - "docs/specs/{session-sync,parallel-sessions,context-usage,worktree-default,session-input,session-read-state}.md"
---

# Sessions over ACP

**Sessions:** `stores/sessions/sessions.js` holds `$sessions` (listed), `$draftSessions` (id →
`{ projectId, workspaceId }`: a new chat with no message yet, not listed) and `$activeSessionId`, which is also the chat's
conversation id; `$activeSession` is `null` for a draft. The `sessions` hook keeps the active session in
the shown workspace (`showWorkspace()`: its last shown session (`brama:sessions:last:<folder>`, Main's
the project path, per window, so it survives a relaunch), its newest, or a new draft of it), and the
`workspaces` hook switches the shown workspace to the shown chat's when a chat of another one is
shown (a banner). The Sessions column lists only the
shown workspace's chats under `<acp-workspace-header>`,
`create()`s drafts and `start()`s one on its first message. Where a draft's chat goes is its
composer footer's pick (`<acp-run-target>`, `ComposerState.runTarget`, default
`composer.runTargetOf()`: This workspace in a worktree workspace, Local in Main; or New worktree
from a base of Main's branches, which `<acp-chat-view>` lists at each opening of the base menu and
fetches once per draft; offered only where `$workspacesEnabled`, `stores/workspace-status/`, but a
pick of it holds at send (the backend refuses where it can't be)):
`start()` / `startInTerminal()` list it there (Local: Main's, the window shows Main), and New
worktree first calls `workspaces.create()` (`workspace_create`, unnamed, listed at once), moves the
chat into it (`moveSession()`) and shows it; a refused create is a snackbar and a draft again (New
chat then reuses the shown draft of the workspace, else the last added); a chat removed meanwhile
deletes the new workspace.
New workspace (picker, Mod+N) is `sessions.create(…, { kind: 'worktree' })`. Showing a session resumes its stopped
agent; a hidden one's agent is stopped after 10 min idle (`IDLE_STOP_MS`). The composer's state is per session
(`$composer` is the active session's entry). One `<chx-chat>` holds every session as a conversation
(messages cached per id, a hidden session's reply keeps streaming), bound by `ChatSessionController`
(`src/controllers/chat-session/`, on `<acp-chat-view>`, reaching the chat through `<acp-chat>`'s
`chat`): `activeConversationId`, the draft's first send (put back into
the composer when the backend refuses the session), and each session's unsent composer text and files.
Statuses come from the backend's session events. A draft shows only the composer, centered; the message
list appears with the first message. Replies come over ACP (see below and `agent-config.md`); messages live only
in the chat element and the agent, which replays them (`session/load`) when it starts again.

- **The list** (`<acp-session-list>`): one `tvx-tree-view`: Unread and Read folders (`splitByRead()`), chats under them, a chat's subagents under it, Show more as Read's last row (the sessions are in memory; it reveals the next `SESSIONS_PAGE` and moves focus to the first). A click selects, a double-click or Enter opens (`acp-session-select`, `acp-subagent-open`), and the open row keeps a lighter fill of its own while another is selected, since the tree highlights only the selected row); F2 or the menu renames (the tree's editing). `::part(row):hover` sets custom properties that reach what the row holds, which swaps `<acp-session-row-trailing>`'s age and status for Mark as read (unread only), Pin and the menu button, and shows a folder's chevron; the tree's own chevrons are hidden. Folder and subagent open state isn't persisted.
- **Sessions** (`src-tauri/src/session/`; `runtime.rs` holds `Sessions` and the lifecycle calls,
  `runtime/` one module per concern, each adding to `Sessions` / `Inner`: `api`, `state`, `start`,
  `turn`, `sign_in`, `agents`, `host`, `worktree`, `sync`, `slots`): the agents own the sessions (spec:
  `docs/specs/session-sync.md`). `Sessions::sync` (`session/runtime/sync.rs`, `sessions_sync` →
  `sessions://synced` to every window) asks each agent of a project that's on, trusted and not
  waiting for a sign-in for its sessions there (`acp::Catalog`: `initialize` + `session/list` of
  the project and its workspaces' folders, a session first seen in a workspace's folder landing in that workspace, scratch process in `<app data>/probe`, two at a time, 15 s
  each; one that listed is kept up for the next sync, stopped after 90 s unused) and makes them the list (`SyncReport`: `listed` / `unsupported` / `off` / `untrusted` /
  `signIn` / `failed` per agent); a complete list drops the stopped sessions it no longer has, never one its CLI runs (a new CLI's session isn't listed yet). A
  session first seen in a list gets the id `<agent id>~<acp id>`. `sessions.json` in app data
  stores the list as last seen (no messages, all `stopped` after a restart) so it shows at once; a
  sync runs at launch, when a project is shown (5 min stale), when a session is opened (its agent,
  every 30 s at most), for agents that didn't list once `$agentList` changes, on Resync
  (`<acp-session-sync>` in the session list), and every 20 s for the shown project's listing agents
  (quiet, window visible). `Session.activeElsewhereUntil`: its agent saw activity that wasn't
  Brama's, plus 2 min, never while its CLI runs here nor from that CLI's writes; `isActiveElsewhere(session, $now)` (`stores/clock/clock.js`, 10 s ticks) shows it
  with the working spinner while it doesn't run here. A chat its CLI runs has `Session.activity` instead (spec: `docs/specs/session-activity.md`): its agent crate's `session_activity()`, read every 3 s (`watch_cli_records`, `session/runtime/cli.rs`), `null` where the agent can't tell, so no spinner; `sessionIndicator()` and the workspace's `statusOf()` read it. Showing a session waits for its agent's
  sync before resuming, and doesn't resume one active elsewhere (the banner's Resume does). The agent starts on the first message, or when its session is
  shown (`resume`: a stopped one only, no `stopped` event; quietly left stopped while the project
  has its workspace's branch). Any number of chats of a folder (Main's, or one workspace's) run;
  their turns share it through a turn slot keyed by the folder (`session/runtime/slots.rs`, spec:
  `docs/specs/parallel-sessions.md`): a turn takes it after `ensure_started` and holds it until it
  returns, a prompt sent meanwhile is `queued` (a `queued { holder }` event; saved as `idle`)
  and starts first come, first served; cancel, Stop, Remove, a crash or its agent leaving
  agents.json drop it from the queue (cancelled, never reaching the agent). A turn in Main never
  waits for one in a workspace; no turn queues with the project's `.brama/workspace.json` `"localTurns":
  "parallel"` (read at each turn; set by editing the file, Settings has no control for it). Then the files each turn's tool calls change (diffs, and
  locations of calls whose kind isn't `read` / `search` / `fetch` / `think`; normalized, no `..`)
  are its `touched`, and a watcher batch of a folder (`Sessions::note_changes(folder, …)`, from
  a root's `Host::files_changed`, a project's or a workspace's; none for a folder whose root isn't open) naming one that two
  turns touched, running or ended less than `overlap_grace` (1 s) ago, sends each running one an
  `overlap` (once per file per turn; a banner notice until the turn ends, over an `info` /
  `outdated` one that comes back then). Mode logic sits behind `SessionEnv` (`session/env/`: `local`,
  `workspace`); `env::Placement::of(project, workspace)` fixes where a new chat runs (mode, folder,
  worktree fields, `workspace_id`; kept in its record; used by `new_record` and a listing's
  `listed_record`), `for_session()` builds its env, and `Inner::prepare_folder` (`start.rs`) gets
  the folder ready for an ACP or CLI start alike (`Workspaces::ready`, then the env's `prepare`). **Workspaces** (`src-tauri/src/workspace/`, spec: `docs/specs/workspaces.md`):
  `<app data>/workspaces.json`, `Workspaces` (in `Sessions`, `sessions.workspaces()`), each a
  worktree `<app data>/worktrees/<repo>-<hash>/<slug>` on `brama/<slug>` (`-2`… when taken) from
  its base branch (default `origin/HEAD`'s, `main`, `master`, HEAD's), checked out by
  `check_out` (in the background from `workspace_create`) or at its first chat's start
  (`Workspaces::ready`, which every chat start waits on); checkout, removal and placing live in
  `workspace/checkout.rs`; commands in `commands/workspaces.rs`,
  every change `workspaces://changed` (`{ projectPath }`), the page's `$workspaces`
  (`hooks/workspaces/`). A chat (`workspaceId`) runs in its workspace's folder (`mode: worktree`,
  the worktree fields copied); its env is `WorkspaceEnv`: `prepare` only checks the
  folder (missing: "folder is missing", until `recreate_workspace`) and switches a detached
  worktree back on its branch (refused while the project has it); it never checks out or removes. `session_create` takes the chat's `workspaceId` (`new_record`): `null` for Main
  (the project folder, `mode: local`, no git needed), or a workspace's id (refused for another
  project's). `workspace_create` stores a workspace at once (`Workspaces::place`); one created
  without a name is called after its branch ("Workspace 2"), `nameSource: agent`: its first chat's
  message names it, then it takes its oldest chat's agent title, from `session_info_update` or a
  listing, until renamed (`name_workspace_after`). Removing a chat never touches its workspace; only Delete workspace does. At load, a worktree session without a workspace gets one of its own
  (`workspaces::migrate`, idempotent). No repository, no commit or an unknown base refuses a
  workspace; a base resolves as a local branch, then a remote-tracking one (`origin/main`), then
  any other name, and the new branch never tracks it. A workspace lists `creating` from its first
  announcement until its checkout ends, and `missing` whenever its folder isn't checked out (also
  one never checked out, after a relaunch or a failed checkout), so Recreate folder runs it.
  `WorkspaceRecord::checkout_state()` (`Ready` / `NeverCheckedOut` / `Absent`) is the one test of
  that: a record stores `checkedOut` once its first checkout succeeded (older records: true), so a
  chat's start checks out only a workspace never checked out, and one deleted outside Brama
  (folder and branch alike) stays missing until Recreate. Delete
  stops a running checkout (`Workspaces` keeps a cancel flag per workspace; git is stopped like a
  timeout, `exec::Options.cancel`) and undoes it. An empty folder an interrupted checkout left is
  replaced; one with files is named in the error. Every agent path goes through
  `to_host_path` + `confine` (no `..`, no symlink out, nothing in `.git`); writes are atomic.
  `HOOK(git)` comments in `try_turn` (`session/runtime/turn.rs`) mark the checkpoint points. `Sessions::remove` (session row
  menu → Remove session) stops the agent, deletes the session in its agent (`session/delete`, or
  keeps it `hidden` in `sessions.json` where the agent can't), unlists it, deletes `sessions/<id>/`
  (its log); its folder stays. `Sessions::delete_workspace` removes each of its chats that way,
  then `Workspaces::discard` (`checkout::remove`) commits uncommitted work onto the branch
  (`git::apply::snapshot_commit`: scratch index, no hooks, CAS `update-ref`, Brama's identity when
  git has none), removes the worktree, and deletes the branch unless Keep branch and it has
  commits past the base. A detached worktree (Check out branch) with uncommitted work is kept (a
  warning). Apply to Main / Check out branch / Changes act per workspace and hold every chat's
  turn slot, all or none (`hold_workspace`). At launch `Sessions::tidy_worktrees` (background)
  prunes worktree metadata and removes app-data worktrees no workspace owns, unless dirty (a
  warning); branches stay.
- **ACP host** (`src-tauri/crates/agent-acp/`, the app's `crate::acp`): the only crate using `agent-client-protocol` (pinned). One
  process per session in its own process group (stopped as a group; `process::stop_all` on app
  exit), stderr → `<app data>/sessions/<id>/agent.log`. Dispatch-loop callbacks never wait:
  permission responders are parked until the user answers. Tests run `agent-acp`'s `fake_agent.rs` (feature `test-support`)
  in-process; `real_claude_agent_end_to_end` (ignored) runs the real agent.
- **Frontend**: each session's events come over a Tauri channel (`{ sessionId, seq, kind, payload }`,
  `update` = raw ACP `SessionUpdate`) into `handleSessionEvent` (`hooks/sessions/adapter.js`), which
  maps updates to `<chx-chat>` chunks (text, `thought`, `tool_call`, `plan`) in the turn's stream,
  or replays them through `subscribe` outside a turn (`session/load`). Permission requests and
  notices live in `stores/session-runtime/session-runtime.js`, shown by `<acp-session-banner>` (a queued
  turn's names the session it waits for, with Show session, and says when that one waits for
  your answer); `$agentList`
  (the `agents` hook, `hooks/agents/agents.js`) feeds the agent picker. The agent's text renders as Markdown in
  `<acp-markdown>` (`markdown.render()` with the `reply` policy: markdown-it + DOMPurify, fences in `<chx-code-block>`, links via `open_url`), full
  width (`chx-message:not([own])` in `shadow.css`), with a caret while it streams. Parts rise in
  while their row is busy (`chx-message-row[aria-busy='true']` in `shadow.css`, CSS only: history and
  rows scrolled back don't replay; opacity and transform only, so row heights hold). A thought is `<acp-part-thinking>`: ACP never
  ends one, so the adapter ends it (`part-end`) at the next shown update or the turn's end, a live
  one timed in `data` (`startedAt`, `endedAt`); the last part of a cancelled reply shows as stopped.
  It also fills the list's `streaming` slot (no reply yet), untimed, instead of `<chx-streaming-indicator>`.
  Files dropped from the OS on the shown chat (Tauri's native drop, see `terminals.md`; the page
  gets no HTML5 drop, so `<chx-chat>`'s own drop is dead) are handled by `<acp-agent-column>`,
  which sets `<acp-chat-view dropping>` (on its `<acp-chat>`) while they're over it: `fileDrop.kinds()` (`dropped_kinds`) says what each is, and
  `fileDrop.chatDropOf()` (`hooks/file-drop/rules.js`) makes each file or folder, an image too (the agent reads
  it by its path), a chip at the caret (`AcpChat.insertFiles()`, built like an `@` pick), relative
  to the session's folder inside it, else absolute. `promptOf()` sends a relative chip as a
  `mention`, an absolute one only as `@path` in the text (the backend confines mentions to the
  project). `dropped_kinds` (`commands/dropped.rs`) takes only paths of the window's last 4
  drops, which Rust records from the drag-drop event (`DroppedFiles`). A drop while the composer
  isn't up waits for it (`$pendingInput`, see "Session input").
  `ChatPartsController` (`src/controllers/chat-parts/`) renders every message part; file refs
  (`chat.parseFileRef()`, `hooks/chat/file-refs.js`: `@path`, `path:12-23`, inline-code paths, links to files) become file chips
  and links (a folder is `@path/`), and a click on one, or on a tool call's location, fires
  `acp-file-open` (`<acp-app>` opens the tab and selects the file in the tree, expanding its folders);
  a folder's (a folder chip, or a ref the project lists as a folder, like `@.brama`) fires
  `acp-file-reveal` (no tab: selects and expands it in the tree, `AcpFileTree.reveal()`).
- **Session folders:** `Session.folder` is where the agent works (the project, or the project's
  folder in its worktree). Chat refs, tool-call locations and composer chips are relative to it
  (`folderOf()`, `$activeFolder`). Main's folder is the project, a workspace's its own:
  `folderOfWorkspace()` (`hooks/workspaces/folder.js`) is the one rule behind `$activeRoot`,
  `$shownFolder` and a draft's folder. A chat is a workspace's when it has a `workspaceId` (the
  page reads no `mode`). A workspace's files open as tabs of its folder (each
  folder has its own tabs and terminals, `persisted-state.md`; deleting the workspace forgets them
  and its last chat; `read_file` reads its folder through `Sessions::contains`), marked with a branch
  icon, no diff gutter, re-read when its turn ends; its folder refs
  reveal the project's same folder. While a chat of a workspace is shown, the window shows that
  workspace's folder (`$activeRoot`, see CLAUDE.md "Open roots"): Files, Search, Changes, Quick Open
  and the branch follow it; removing a chat leaves its workspace's root open (only Delete
  workspace closes it). A prompt path that is relative is the session's own copy; an
  absolute one inside the project is the user's file there (a selection quotes the project's text).
  A workspace's Changes tab (`view:workspace-changes:<id>`, `stores/tab-ids/tab-ids.js`, `tabs.workspaceChangesId()`, opened by
  `openWorkspaceChanges()` from `workspaces.changes()`, Changes since base, with or without chats; kept while the workspace is in
  the project's `$workspaces`, and until they're listed): `WorkspaceChangesController`
  (`<acp-workspace-changes-tab>`, one per tab, following its own workspace) lists `workspace_changes` (commits and uncommitted work since `baseCommit`,
  `git::apply::changed_since`, in a scratch index seeded from the worktree's) when shown and after
  each turn of any of its chats, and diffs a file against `workspace_file_at_base`; `<acp-changes-review>` with
  `base` shows them without commit picks, with Apply to Main and Check out branch (`workspaces.apply()` /
  `checkOut()`, the `workspaces` hook).
- **Config options** (model, thought level, mode): the agent's own, from `session/new` / `session/load`,
  `config_option_update` and every `session/set_config_option` answer, reach the page as
  `config-options` events (an agent with only legacy `modes` gets a stand-in `mode` option set
  through `session/set_mode`). `applyAgentOptions()` (`stores/composer/composer.js`) replaces the session's
  options and caches them per agent (`brama:agents:config-options:2`, keeping the agent's defaults
  as first learned), so a new session shows the real models before it starts. A new session starts
  with the user's last picks for its agent (`brama:agents:last-picks`; never a permission mode,
  category `mode`); a listed session without a composer this launch (after a reload) gets one
  from its record: its agent, `config`, started. An agent with nothing cached is probed once per launch
  (`agents_probe_options` → `Sessions::probe_options`: started in `<app data>/probe`, `initialize` +
  `session/new`, no prompt, stopped), one at a time; an agent picked in the composer is probed at
  once (`agents.loadOptions()`, once per launch, cached or not). `$composerOptionsStatus`
  (`whileLoadingOptions()`: `loading` / `failed`) drives the composer's two dropdowns,
  `<acp-agent-picker>` then `<acp-model-picker>` (model, thought level and other options; disabled
  with a spinner while an agent with nothing cached loads). Permission options (category `mode`, and
  `permissions` like Copilot's `allow_all`) are `<acp-mode-picker>`'s; a mode value's icon and
  color come from its `risk`, which the backend tags it with (its agent crate's `mode_risk`,
  `agents::tag_modes`), never from its name. `normalizeOptions()` keeps
  each value once (Copilot sends `auto` twice) and drops a description that repeats the name. A pick goes through `sessions.setConfigOption()`: shown at once,
  sent if the agent runs, else kept in `ComposerState.chosen` and sent when it starts. Each session
  keeps its own values (`SessionRecord.config`, by option id: the draft's picks at create, then
  every answer and update): a new start of its agent is set to them (`apply_config`, inside the
  start Stop aborts, each answer bounded by `initialize_timeout`) before anyone gets the connection, so an agent that forgets its model on restart or `session/load` doesn't drop it.
- **History**: Brama stores no messages. A session's conversation is its agent's replay
  (`session/load`, when it's shown), shown once per launch (`adapter.js` `loaded`: a later load
  after an idle stop adds nothing); an agent with only `session/resume` continues it without
  history (the banner says so). A page that opens a session whose agent runs (a reload, another
  window) gets its conversation since that start as a `snapshot` event (`session/runtime/replay.rs`,
  in memory while the agent runs), then each permission request still pending again, and the
  snapshot goes through the same `replay()`; a replay ends only on
  `idle` / `stopped` / `error`, so one taken mid-turn takes the rest of the turn (spec:
  `docs/specs/session-reattach.md`). Context usage (spec: `docs/specs/context-usage.md`) comes only from a running session's
  `usage_update`: `setContextUsage()` keeps its tokens (never the cost) in `$contextUsage`
  (`stores/context-usage/context-usage.js`, `brama:sessions:context-usage:<session id>`, one item per session),
  so a session shows its last report after a reload or restart (no agent reports on
  `session/load`); `$activeContextUsage` feeds `<acp-context-meter>`, which shows only an empty
  ring until there is one.
- **Read / unread** (spec: `docs/specs/session-read-state.md`): the backend stamps activity, so every
  window shares the times: `activity { at }` for a turn's output (at most one per `OUTPUT_STAMP`, 1 s,
  skipping the disk write; the turn's end persists it), `at` on `turn-end` and a failed `error`, and
  `session_send_prompt` returns its stamp. The adapter passes each to `touchSession(id, at)`, which
  keeps the later. `stores/session-read/session-read.js` holds `$sessionReads` and `$readBaselines`
  (see `persisted-state.md`) and `$unreadSessions`, computed through `isUnread()`
  (`hooks/sessions/rules.js`): unread when marked by hand, or when `lastActivityAt` is more than
  `READ_SLACK_MS` (5 s) after `seen`; with no mark, after the project's baseline (none: read).
  Actions: `markSeen` (replaces any mark), `markRead`, `markUnread`, `markProjectRead`, `forgetRead`,
  all skipping writes that change nothing; `remove()` calls `forgetRead()` after unlisting the
  session. `trackSeen()` (`hooks/sessions/seen.js`) marks the shown session seen while the page is
  visible, the window focused and the agent column shown, and once more when that stops.
  `recordBaselines()` runs on each sync report. UI: a dot in the row's indent (in the pin's place),
  a heavier title, a primary age; `● N new` beside Show more; Mark as read / unread in the row menu,
  Mark all as read of the shown workspace's chats on Mod+Shift+R (`markWorkspaceRead`;
  `markProjectRead` in the shortcut table, handled by `<acp-app>`).
- **Session input** (spec: `docs/specs/session-input.md`): what the user gives a session reaches it
  in Chat and Terminal alike, or is refused with a reason, never dropped. A composer send is read
  from its html (`inputOfComposer()`, `hooks/sessions/input-parts.js`), never its plain `value` (a chip
  is only its label there), into `InputPart`s that `promptOfInput()` (ACP) and `cliPromptOf()`
  (`hooks/sessions/cli-input.js`, the CLI's `@path`, `@path#L3-5`) write. `sessions`
  (`hooks/sessions/input.js`) decides a draft's first send (`draftTarget`: `startTerminal` or
  the chat). A file attached in the composer (picked, pasted) never stays an attachment:
  `<acp-chat>` hands it to the column (`acp-chat-attach`), which saves it into the session's
  folder (`save_attachment`, `commands/attachments.rs`: `.brama/attachments/`, self-ignoring in
  git, one-word unique names claimed with `create_new`, 64 MB at most, never through a symlink;
  a draft's chips are absolute) and puts its path chip in, so both views send
  a path (an image read by path works in a CLI; the chat's own file reads are text only). An
  attachment that still reaches a send is refused (`refuseFiles`: a notice, the send cancelled so
  the composer keeps it). A terminal draft's composer clears only once its CLI started. Editor
  code and OS drops wait in `$pendingInput` (`stores/chat/chat.js`, per session) until the shown
  session's composer is up or its CLI runs (`<acp-agent-column>`'s `#applyPending`); an ended
  CLI shows how many wait. A first prompt goes on the CLI's command line only on Unix and up to
  `MAX_ARG_PROMPT` bytes (`config/cli.rs`, a leading space if it starts with `-`); otherwise it's
  pasted, without Enter, once the CLI turns bracketed paste on or settles
  (`Terminals::paste_when_ready`). For a new input or view: add an `InputPart` kind that every
  renderer writes, route through `sessions` / `$pendingInput`, never an `if (inTerminal)` in a
  caller; "in a turn" is `inTurn()` (`hooks/sessions/rules.js`).
