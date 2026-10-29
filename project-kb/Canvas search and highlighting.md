## Overview

Two features that point the user at nodes on the open canvas: *Canvas: search papers* (highlight every paper whose title or authors match) and the flash on *Papers: add by DOI or arXiv* when the paper is already there.

## Current solution

- Matching is `matchesPaperQuery` in `src/canvas/search.ts`: every whitespace-separated query word must appear in the title or an author name, case- and accent-insensitive. An empty query matches nothing, so an empty box clears the highlights.
- The modal is a `SuggestModal` (`src/modals/canvas-search.ts`). `getSuggestions` re-highlights on every keystroke. Choosing a result zooms to it and keeps the highlights; closing without a choice clears them. Obsidian closes the modal before calling `onChooseSuggestion`, so `onClose` defers its check by 50 ms, the same trick as `StatusPickerModal`.
- Highlighting goes through undocumented canvas internals typed as `LiveCanvas` / `LiveCanvasNode` in `main.ts`: `canvas.nodes` (Map of live nodes), `node.nodeEl`, `node.x/y/width/height`, and `canvas.zoomToBbox`. Every field is optional, so an Obsidian release that renames one degrades to "no highlight" rather than a crash.
- Classes on `.canvas-node`: `citation-graph-search-hit` (accent glow), `citation-graph-search-miss` (opacity 0.25), `citation-graph-flash` (three 0.6 s pulses, removed on `animationend`). Styles are at the end of `styles.css`.
- Search items come from the live nodes' file paths, read through `frontmatterOf` + `paperFromFrontmatter`, so a node whose note has no frontmatter is not searchable.

## Open questions

- Highlights only clear through another search closed with Escape. If that proves awkward, clearing on a canvas click is the obvious next step.

## History

- 2026-10-29: Verified in the dev vault (Obsidian 1.14.4) with screenshots: `canvas.nodes`, `nodeEl` and `zoomToBbox` all exist; live highlighting, zoom on choice, Escape clearing and the duplicate-add flash all work. Method: a second Obsidian instance with `--user-data-dir=<scratch profile> --remote-debugging-port=9333`, its `obsidian.json` listing only the dev vault, the vault's plugin symlinks pointed at this checkout's build for the test and restored afterwards, driven with Playwright `connect_over_cdp` (the `annas-dl` conda env has Playwright).
- 2026-10-29: Added both features.
