@AGENTS.md

# CLAUDE.md — apps/desktop

`AGENTS.md` in this folder (imported above) holds the frontend's rules for every agent. This file
holds only what is specific to Claude Code.

- Writing, extending or slimming a frontend test suite uses the `lit-test-suite` skill. Where it
  differs from `AGENTS.md`, `AGENTS.md` wins (mocha + chai with `fixture()` from `test/fixture.js`,
  `__tests__/` folders, no test for covered behavior, the Styles rule). Name the skill in the brief
  of any subagent that writes tests.
- Load the `bem-css` and `bem-lit-blocks` skills when writing or reviewing component CSS or
  structure.
- The `new-component` skill scaffolds a new element.
- The subsystem notes in `.claude/rules/` load on their own when you read or edit the files in
  their `paths:`.
