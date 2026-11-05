---
paths:
  - "src/stores/{comments,chat}/**"
  - "src/controllers/{comments,selection-actions,floating}/**"
  - "src/components/{comment-bar,selection-actions,code-view}/**"
  - "src/views/{main-column,editor-view}/**"
  - "src/hooks/comments/**"
---

# Agent comments and selection actions

**Agent comments:** line comments typed in any `cdx-code-editor` live in `$comments` (`stores/comments/comments.js`,
by absolute path, in memory). Every editor's `<cdx-comments>` is controlled through
`EditorCommentsController` (`src/controllers/comments/`): `.comments=${this.#comments.threadsOf(path)}`,
and its submit / edit / delete become `acp-comment-*` events that `<acp-main-column>` turns into store
actions (a file tab's editor is `<acp-editor-view>`, which passes it the comments and the focus; the
events go on up to the column, since the Changes tab's editors fire them too), so one file shown twice (a tab and the
Changes tab) stays in sync. `<acp-comment-bar>` (over `<acp-main-column>`) steps through
`$tabComments` (the active tab's file, or every changed file in Changes) by setting `$commentFocus`: the main column shows the file,
the visible editor of it reveals the thread. Send to agent (`sendToChat()`) clears the comments from the code and hands them to the chat
(`addToChat()`, `stores/chat/chat.js`); `<acp-agent-column>` takes `$chatInserts` into `<acp-chat>`'s composer
(`insertCode()`, once `composerReady()`): a comment as its
own line (file chip `path:line` or `path:from-to`, then the text), a selection as a chip at the caret.
A session shown in the terminal gets them in its running CLI instead, as text (`cliInput()`,
`hooks/sessions/cli-input.js`: `@path#L3-5`, relative to the session folder; comments on lines of their own)
through `<acp-terminal>`'s `paste()`; while its CLI starts, or after it ended, they wait in the store (for
the CLI, or the composer once the chat shows).
`SelectionActionsController` (`src/controllers/selection-actions/`) shows `<acp-selection-actions>`
(Add to chat, as `acp-chat-add`; Comment) under the caret of a settled selection in the host's own editors: a manual
`popover` toolbar (top layer), placed by `FloatingController` (`src/controllers/floating/`, Floating UI
`computePosition` + `autoUpdate` against a virtual caret element), so it follows scrolling and hides
while the caret is out of view. Alt+F10 focuses it, arrows move between actions, Escape closes it,
and it closes when focus leaves both it and the editor (focus inside it returns to the editor). Editor
events are composed, so a host also hears its children's editors (the tab view hears the Changes
review's): controllers act only on `comments.editorOf(event, renderRoot)` (`hooks/comments/comments.js`).
