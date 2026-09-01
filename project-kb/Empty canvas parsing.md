# Empty canvas parsing

## Overview

Obsidian creates a new `.canvas` file as a zero-byte file, and writes `{}` in some paths where every node has been removed. Neither is what the plugin's canvas code expects: it wants an object with `nodes` and `edges` arrays.

Every command read its canvas with a bare `JSON.parse(await this.app.vault.read(file))`. Against a zero-byte file that throws `SyntaxError: Unexpected end of JSON input`, which the surrounding `catch` surfaced verbatim as a notice. Against `{}` it parses, then fails one line later on `canvasData.nodes.map`.

The user-visible symptom was reported for *Add paper by DOI or arXiv ID* on a freshly created canvas, but all twelve canvas read sites had it, including the target-canvas read in *Send papers to another canvas*, where picking a brand-new empty target is the natural thing to do.

## Current solution

`src/canvas/parse.ts` exports `parseCanvasData<T>(content, path)`:

- empty or whitespace-only content returns `{ nodes: [], edges: [] }`
- a parsed object gets missing `nodes` / `edges` filled in with `[]`, every other key (notably `citationGraphMeta`) preserved
- content that is not valid JSON, or is valid JSON but not an object, throws with the canvas path in the message

`CitationGraphPlugin.readCanvas<T>(file)` wraps it over `vault.read`. All twelve call sites in `src/main.ts` go through it; there is no `JSON.parse` of canvas content left in that file. The generic parameter carries the per-command `citationGraphMeta` shape that used to be written as `as CanvasData & { ... }`.

Downstream of the parse, every command already guarded on `fileNodes.length === 0` and now degrades to "No paper nodes found on this canvas." *Add paper by DOI* and *Expand paper* work on an empty canvas, since `expandCanvas` / `layoutNewPapers` handle an empty existing node list.

### Metadata seeding

Related gap found in the same pass: `citationGraphMeta` was only ever written by canvas creation from a Zotero collection or tag. A canvas populated purely with *Add paper by DOI* therefore had no metadata block, and *Send papers to another canvas* rejects such a canvas outright (`if (!sourceData.citationGraphMeta)`). *Add paper by DOI* now seeds a block with an empty `zoteroCollectionKey`, `collectionName` from the canvas basename, and empty `bannedPapers` when none exists.

## Open questions

- Other commands lazily create `citationGraphMeta` when they need to write into it (banned papers, `lastDownloadPath`, Zotero key). Only *Add paper by DOI* seeds it up front. Whether the seeding belongs in `readCanvas` instead is unresolved; it was kept at the one site where a canvas first gains papers.

## History

### 2026-09-01 -- Fix

Traced the reported `Unexpected end of JSON input` on *Add paper by DOI* against an empty canvas to bare `JSON.parse` at every canvas read site. Added `src/canvas/parse.ts` with tests (`src/canvas/parse.test.ts`), the `readCanvas` helper on the plugin, and rewrote all twelve sites. Seeded `citationGraphMeta` in *Add paper by DOI*. Full build green: 228 tests.
