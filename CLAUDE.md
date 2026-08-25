# Citation Graph Plugin -- Developer Notes

## README maintenance

After any change that adds, removes, or modifies a command or setting, update `README.md` before committing. The README is the authoritative reference for users and must stay in sync with the code.

Specifically check:
- The **Features** list at the top
- The **Commands** section (one subsection per command)
- The **Configuration** settings table
- The **Prerequisites** section if new external tools are required

## Download sources

The download command tries arXiv and then whatever `getDownloadFallback()` in `src/api/fallback-source.ts` returns, against the `DownloadFallback` interface in `src/api/download-fallback.ts`. That indirection is deliberate: the picker's row gating, progress messages and error reporting are all written against the interface, so a build with a fallback and a build without one share every line of the download path except that one function.

When touching the download path, keep source-specific knowledge (which identifier a source needs, what its setup requires, which of its errors are per-run rather than per-paper) behind the interface rather than in `download-picker.ts`.

## Project knowledge base (`project-kb/`)

`project-kb/` holds one markdown note per topic: a specific bug, feature, or design decision, accumulated over time rather than logged per session. Search it before starting a task (grep the key terms of the task), read any relevant note in full, and update or create a note after finishing meaningful work.

Notes read as living documents, not changelogs. Use sections like `## Overview`, `## Current solution`, `## Open questions`, `## History`, and prepend new History entries so the latest work is visible first.

`project-kb/private/` is gitignored when present and holds notes that must stay out of this repository. Do not move anything out of it without asking.

## Downstream variants

If a `CLAUDE.private.md` exists at the repository root, read it as well before starting work: this checkout is then a downstream variant carrying files that must not be pushed here. The guards in `.githooks/` enforce that; see `.githooks/README.md`.
