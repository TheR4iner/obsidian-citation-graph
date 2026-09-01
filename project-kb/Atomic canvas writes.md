# Atomic canvas writes

## Overview

Every command that changes a `.canvas` file or a literature note reads and writes it through `Vault.process`, never `Vault.read` followed by `Vault.modify`.

`process` re-reads the file under the vault's write lock and hands the callback what is actually on disk at that moment. `modify` just writes, so a command that read the canvas, spent two minutes in Semantic Scholar, and then wrote its snapshot back destroyed everything the user did during those two minutes.

## Current solution

`CitationGraphPlugin.updateCanvas(file, mutate)` in `src/main.ts` is the single entry point: it parses the freshly read content with `parseCanvasData`, hands it to `mutate`, and serialises the result. The contract is that `mutate` must derive its result from the canvas it is given and never from one captured earlier.

Two consequences shape most of the call sites:

- **The callback is synchronous.** No note can be read once the canvas is open for writing. Anything requiring a file read has to happen first, which is why `syncStatusColors` was split into the async `resolveStatusColors(notePaths)` (reads notes, returns a `Map<notePath, colour>`, also brings each note's marker class up to date) and the sync `paintStatusColors(nodes, colours)`.
- **Layout and edge resolution run inside the callback.** `expandCanvas`, `layoutNewPapers` and `resolveNewEdges` are all synchronous, so they are called against the fresh canvas rather than against the snapshot. Counts reported to the user are captured from inside the callback for the same reason: what was written is what gets reported.

A note path absent from the colour map means "not a paper, leave the node alone". That distinction matters because a canvas legitimately holds the user's own notes beside papers.

`resolveMissingEdges` is the clearest case: its fetch loop runs for minutes on a large canvas, and it now recomputes which edges are missing at write time.

`writeSummary` uses `Vault.process` on the note directly, for the same reason at note level: a summary call takes minutes, and the old read-modify-write overwrote anything typed into the note meanwhile.

## Open questions

- `updateCanvas` has no conflict detection: if the callback's premises are invalidated (a paper it is adding an edge for was deleted meanwhile) the result is a dropped edge, not an error. That is the right outcome for every current caller, but it is an assumption, not a guarantee.

## History

**2026-09-01 — introduced.** Converted all eighteen `vault.modify` call sites on canvases and notes, plus the banned-papers manager in the settings tab, as part of the community plugin pre-submission audit. See [[Community plugin submission]]. The Obsidian review checklist asks for `Vault.process` over `Vault.modify`; the lost-update bug it prevents was real and independent of the review.
