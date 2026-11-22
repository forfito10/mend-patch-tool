# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/forfito10/mend-patch-tool/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/forfito10/mend-patch-tool/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

`mend` is the entry for the make.fun competition [hidden-spec-cli-01-run-20261122](https://make.fun/competitions/hidden-spec-cli-01-run-20261122).

It is one command-line tool that applies the edits AI models write, in four formats, to a tree of text files:

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- V4A patches (`*** Begin Patch` …),
- text-editor tool calls as JSON.

It finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-trimmed,
fully trimmed), writes every change or nothing, and prints what it changed or why it failed. See SPEC.md-level
behaviour in the entry itself: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.

Node 22, the standard library alone — no dependencies, no install step.

## Layout

- `main.ts` — the CLI (the whole entry).
- `runner.ts` — the kit's trial runner (kept as handed out).
- `check.ts` — runs the public practice set against `main.ts`.

MIT licensed.
