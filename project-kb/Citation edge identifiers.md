# Citation edge identifiers

## Overview

Every citation edge is a `{ fromId, toId }` pair of *paper identifiers*, and `expandCanvas` resolves each endpoint through the `allPapers` map that `indexPapers` built. `indexPapers` keys a paper under exactly two things: `paper.id` and, when present, `paper.semanticScholarId`. An endpoint naming anything else resolves to nothing and the edge is discarded, which on the canvas looks like a paper that arrived with no arrow.

The trap is that `Paper.id` is *not* the Semantic Scholar `paperId`. `s2PaperToPaper` sets `id = doi || arxiv || paperId` and sets `semanticScholarId` to `null` whenever the `paperId` is synthetic (prefixed `doi:`, `openalex:`, `arxiv:` or `crossref:`), which is what the fallback sources hand back. So for any paper resolved through OpenAlex, arXiv or Crossref, the raw `paperId` is indexed under nothing at all.

**Rule: build edge endpoints from `Paper.id`, never from an `S2Paper.paperId`.** Where the counterpart is a note already in the vault, prefer `buildCitationEdges`, which matches on S2 ID, DOI (lowercased) and arXiv ID and emits `paper.id` on both sides.

## Current solution

Two commands resolve edges: *Expand paper* (and *Add paper by DOI or arXiv*) covers the edges incident to the paper it acts on, and *Canvas: resolve missing citation edges* walks every paper on the canvas. The second exists because the first cannot be composed into the whole: expanding paper by paper never links a pair that arrived by separate routes, since the picker disables the row of a paper already present.

- `buildCitationEdges` (main.ts) is the general path: it takes a `Paper` plus the raw reference/citation lists and returns edges naming `paper.id` on both ends. Used by *Add paper by DOI or arXiv*, *Recommend papers*, and *Expand paper*'s existing-canvas half.
- *Expand paper* pairs each `selected[i]` with `newPapers[i]` (index-aligned, both derived from the same `selected` array) and takes `newPapers[i].id`. This stays exact even for a paper with a synthetic id and no DOI or arXiv, which `buildCitationEdges` could not match on any identifier.
- The expanded paper's own endpoint comes from `canvasPapers.find(p => p.notePath === targetNotePath)`, so it is the same `id` string `indexPapers` keyed, rather than a re-derivation from frontmatter that could differ in DOI case.
- `resolveNewEdges` (builder.ts) is the single place a `CitationEdge` becomes a `CanvasEdge`. It resolves both endpoints through the paper index, dedupes against the edges the canvas already carries *and* within its own input, and logs anything it drops with both endpoint identifiers.
- `expandCanvas` delegates its edge half to `resolveNewEdges`. The edges-only command calls `resolveNewEdges` directly rather than going through `expandCanvas`, because `layoutNewPapers` rebuilds the year layout for every node and would silently discard hand-placed positions. An edges-only sync must rewrite `edges` and nothing else.
- The edges-only command keys the cache by `DOI:<doi>` / `ARXIV:<arxiv>` / S2 id in that order, which the cache's `externalIdIndex` resolves to the canonical entry. Note this handles an arXiv-only paper, which *Expand paper* refuses (its `externalId` is `doi ? DOI:doi : s2Id`, so it comes out null).
- A `fetchRefsAndCitations` returning `null` means every source came back empty, which an exhausted S2 rate limit looks identical to from the caller. Nothing is cached in that case (`multi-source.ts` returns `null` before `setMerged` is reached, so the TTL never holds an empty answer), and the count is reported in the closing notice rather than passed over.

## Open questions

- *Canvas: resolve missing citation edges* is one round of requests per paper, so a large canvas is slow on a force refresh without an S2 API key. No batching: `getPaperWithRefs` is per-paper. `SemanticScholarClient.buildCitationEdgesFromBatch` exists for the collection path and might be reusable here.
- Nothing prompts the user to run the edges-only command; the canvas silently stays under-linked until they think to. A count of unlinked-but-citing pairs would need the same round of requests, so there is no cheap hint to offer.

## History

### 2026-08-31 -- expand dropped the arrow for fallback-sourced papers

Reported on the `quantum_complexity` canvas: expanding "How Much Structure Is Needed for Huge Quantum Speedups?" and picking "Entanglement-assisted quantum speedup" added the node and the note but no arrow. The canvas had zero edges.

Cause: the expand path built `newEdges` from `s2p.paperId` directly. The citing paper came from OpenAlex with `paperId: "doi:10.48550/arxiv.2211.14898"`, so `s2PaperToPaper` gave it `id = "10.48550/arxiv.2211.14898"` and `semanticScholarId = null`; the map had no `"doi:…"` key and `expandCanvas` hit its `if (!fromNodeId || !toNodeId) continue`.

Two aggravating factors, both fixed in the same pass:

- The drop was silent, so nothing in the log pointed at it.
- Re-running *Expand paper* could not repair the canvas: expand only built edges for papers it added in that run, and the picker disables the row of a paper already present (`resolveWith` filters on `alreadyOnCanvas`). So the missing arrow was unreachable. Expand now also runs `buildCitationEdges` against the existing canvas papers, which both fixes older canvases on a re-run and closes the wider gap where a reference added on an earlier run never got linked at all.

Regression guard: `src/canvas/builder.test.ts` covers `expandCanvas` resolving `paper.id` and `semanticScholarId` endpoints, dropping an unindexed one, and not duplicating an edge the canvas already carries.

### 2026-08-31 -- added Canvas: resolve missing citation edges

Expanding papers one at a time does not converge on a fully-linked canvas, which is what prompted this. Two reasons: an expansion only resolves edges incident to the paper being expanded, and the picker refuses to re-add a paper already on the canvas. So the edges-only command walks every paper instead.

Implementation notes worth remembering:

- The `resolveNewEdges` extraction from `expandCanvas` was the point of the change, not a tidy-up. Reusing `expandCanvas` with `newPapers: []` would have looked correct and quietly relayouted the canvas, throwing away manual node positions.
- Walking every paper offers each edge twice (once as A's reference, once as B's citation), hence the in-run dedupe in `resolveNewEdges`. Both directions of a mutual citation are still kept: the key is ordered.
- Tests in `src/canvas/builder.test.ts`.
