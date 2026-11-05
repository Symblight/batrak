# Brama

Lightweight agent-first client for working with AI coding agents. The main object is a **session**: agent + isolated workspace + change history. The code editor is secondary (view and small edits).

Stack: Tauri 2 (Rust) + Lit 3 + Rsbuild, plain JavaScript with JSDoc types (`jsconfig.json`: `checkJs`, `strict`).

> `acp-*` is the prefix of this app's Lit components; the Rust module `acp` is the future host for the Agent Client Protocol.

## Requirements

- Node 20+
- Rust **1.85+** (Tauri 2 dependencies need edition 2024) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)

## Run

```sh
pnpm install   # clones the public Symblight/rich-components over SSH, so needs a GitHub SSH key (tree-view is built on install)
pnpm tauri icon <path-to-1024px.png>   # generates src-tauri/icons (once)
pnpm tauri dev
```

Check the Rust side: `cd src-tauri && cargo check`.

Show the Code pane from the devtools console:

```js
document.querySelector('acp-app').shadowRoot.querySelector('acp-editor-column')
  .dispatchEvent(new CustomEvent('acp-file-open', { detail: { path: 'a.js' } }));
```

## Layout

Toolbar (40px) on top. Below: Session column (272px) | Agent column (380px) | Editor column (rest: Code `flex: 1`, hidden until a file is opened, + side pane 300px with Files / Search; the side pane fills the column while Code is hidden).

Shortcuts: Cmd/Ctrl+P — Quick Open (`:42` goes to a line; `@`, `#`, `>` are reserved), Cmd/Ctrl+Shift+F — Find in Files.

## Workspace snapshot

`src-tauri/src/workspace/` keeps every entry of an opened root in memory (relative path, file/dir,
ignored, size, mtime). It is built by a parallel `ignore` walk (.gitignore, .ignore, global
gitignore; `.git` skipped); ignored folders are listed but read lazily, one level per expand.
A `notify` watcher re-reads the directories it reports and emits `workspace://changed`.
The file tree, Quick Open (`nucleo-matcher`) and Find in Files (`grep-searcher`, streamed over a
Tauri `Channel`) all read from it. Every command takes a `rootId`, so each session can later get
its own worktree snapshot.

Timing on a real repo: `BRAMA_BENCH_ROOT=/path/to/repo cargo test --release bench -- --ignored --nocapture`.

## Structure

```
src/
  main.js                  entry
  styles/tokens.css        MD3-style tokens, light/dark
  models/types/types.js  JSDoc typedefs (Session mirrors Rust struct)
  services/
    ipc.js                 only place that knows Rust command names
    project-controller.js  opened folder + workspace rootId, re-emits fs changes
    session-controller.js  stub EventTarget
    editor-facade.js       EditorFacade contract (JSDoc)
  components/              acp-app, acp-toolbar, acp-session-column, acp-agent-column,
                           acp-editor-column, acp-file-tree, acp-search-panel,
                           acp-code-editor, acp-quick-open
src-tauri/src/
  lib.rs, main.rs
  commands/                thin IPC layer (sessions, fs, workspace)
  workspace/               snapshot, watcher, quick_open, search
  session/                 Session, SessionStatus
  storage/, git/, acp/     empty modules (future)
```
