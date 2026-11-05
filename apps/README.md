# apps

What a user runs. Each app is a thin front over `packages/`: it renders the core's types and
events and implements the traits the core declares (`Dirs`, `Notifier`, `EventSink`,
`ProgramRunner`). An app never depends on another app.

- `desktop/` — the Tauri app with its Lit frontend (`ARCHITECTURE.md` §7.1)
- `cli/` — the `batrak` binary (`ARCHITECTURE.md` §7.2)
