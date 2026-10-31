---
paths:
  - "src-tauri/src/config/**"
  - "src-tauri/crates/agent-acp/src/auth.rs"
  - "src-tauri/crates/agent-*/**"
  - "src-tauri/src/commands/agents.rs"
  - "src/services/{agent-config,trust-controller}/**"
  - "src/stores/{agents,trust}/**"
  - "src/components/acp-{agents-view,agent-form,agent-picker}/**"
  - "docs/specs/{agents-tab,agent-sign-in}.md"
---

# Agents: config, registry, trust, sign-in

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
  - **The ACP registry** (`config/registry.rs`, the only user of `ureq`; spec as above): nothing
    is bundled; it is fetched at the first launch, the last answer kept in
    `<app data>/acp-registry.json` with its `ETag` and checked again when a day old (launch, a
    look every minute, Check now: `agents_registry_check`); until it first answers no agent is
    known (the tab lists nothing and says so) and it is tried every minute (`RETRY_EVERY`).
    One check at a time, 15 s; a failure keeps
    what's there and marks it offline (`info`, not `warn`). A change emits `agents://changed` with
    `projectPath: null`. Only Claude, Codex, Copilot and Antigravity are read from it
    (an agent crate names each, `Agent::registry_id` / `AgentHub::for_registry_id`, and the registry
    must distribute it as the crate installs it, `Agent::install`; the rest are left out), and can be added (`AgentList.known`, pinned
    launches). Claude, Codex and Copilot run with `npx`; Antigravity, a `binary` in the registry,
    runs its archive's program (`cmd`'s file name, `agy_acp_server.par`) from PATH
    (`Launch::Program`, this platform's args): the user installs and updates it, Brama never
    downloads an agent; a start that doesn't find it says so with the archive's link
    (`registry::not_installed`). An installed agent
    is matched by what it runs (`match_launch`: that program's name, or `npx` running the entry's
    package, its first `-p` / `--package` value or first non-flag argument, with or without
    `@version`), not by id;
    `AgentSummary.version` is the version its args pin, else `agentInfo.version` from its last
    `initialize` (`<app data>/agent-versions.json`); `update` (semver, `npx` agents only) is a
    newer registry version, `pin: true` when the installed one is unknown ("Pin latest").
  - **Updates** (`config/update.rs`, `Updater`): `agents_update_version` / `agents_update_all`
    pin the registry's version in place (`AgentConfigs::pin_versions`, one write; a trusted launch
    stays trusted when the pin is all that changed), emit `agents://changed` (running sessions get
    `agent-outdated`; nothing restarts), then the agent crate's download (`Agent::update`: the pin and `npm cache add <pkg>@<version>` for an npx agent,
    `agent-kit`; login-shell env, own process group, 5 min; a failure keeps the pin and `warn`s).
    How an agent installs, pins and updates is its crate's (`Agent::install`, `update`;
    spec: `docs/specs/agent-plugins.md`). A second Update of an agent joins
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
    refused. `trustController` (`services/trust-controller/trust-controller.js`) asks in a confirm dialog at the top of
    `<acp-app>` when a project opens, its agents.json changes or a start is refused (`agents_untrusted`
    lists every launch waiting; `$trustPrompt`, `stores/trust/trust.js`): Trust project trusts them all
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
  launch starts again and sends its held prompt. A `terminal` / `command` method (`agent-acp`'s `auth.rs`
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
