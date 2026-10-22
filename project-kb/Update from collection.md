# Update from collection

## Overview

*Canvas: update from collection* (`updateFromCollection` in `src/main.ts`) pulls the papers added to a canvas's source Zotero collection since the canvas was built onto that canvas, without rebuilding it. Requested in issue #54 by a user who had rearranged a canvas by hand and added their own notes, then added references in Zotero.

None of the existing commands covered it: *Create from collection* always writes a new canvas, *Sync to Zotero* goes the other way, *Add by DOI or arXiv* is one paper at a time, and *Resolve missing citation edges* only draws edges between papers already present.

## Current solution

- **Source collection.** The canvas's `citationGraphMeta.zoteroCollectionKey`, written by *Create from collection* (and rewritten by *Sync to Zotero* when it creates a new collection). The meta block does not record the group library, so the command looks the key up again in `ZoteroClient.getCollections()`, which also returns the collection's current name. That keeps old canvases working and needed no meta change. A canvas from *Create from tag* or built by hand has an empty key and is refused with a notice.
- **What counts as present.** `hasPaperNode` against the node IDs, or a literature note on the canvas with the same DOI (case-insensitive), arXiv ID or S2 ID. The S2 check runs again after resolution, to catch a preprint and its published version carrying different DOIs. Papers without DOI or arXiv are skipped and counted, as on creation.
- **Resolution and edges.** One `getPaperBatch(..., includeRefs = true)` over the new papers *and* the existing ones, so `buildCitationEdgesFromBatch` yields edges in both directions from a single response; only edges touching a new paper are kept. Papers S2 cannot resolve are still added from Zotero metadata, without edges, matching *Create from collection*. The S2-enrichment loop was factored into `enrichFromBatch()` and shared with `buildCanvasFromItems`.
- **Placement.** `placeInNewGroup` in `src/canvas/layout.ts` puts the cards in one group labelled `New from Zotero (<date>)`, 400 px right of the bounding box of every node and top-aligned with it, in a square-ish grid ordered by year. Group node first in its slice because Obsidian paints in file order. Group ID `cg-zotero-update-<base36 time>`, deliberately not `cg-tag-`, so *Group papers by tag* treats it as a user group and leaves it in place (it ends up empty once the cards move into tag groups).
- **Write.** `updateCanvas` (see [[Atomic canvas writes]]): the callback re-checks which papers are still absent, appends the group, cards and new edges, and never touches an existing node. Colours are resolved for the new notes only, so existing cards keep theirs.

## Open questions

- Canvases from *Create from tag* could be updated the same way from `zoteroTags`; not done until someone asks.
- The grid arithmetic duplicates `layoutByTag`'s in `src/canvas/tag-layout.ts`. Kept separate because that file was being changed on a parallel branch; worth factoring into one helper later.
- A paper removed from the canvas comes back on the next update. There is no "ignore" list for collection items; the banned-papers list only applies to expand and recommend.

## History

**2026-10-22, introduced** for issue #54. Tests in `src/canvas/layout.test.ts` cover the placement (beside the bounding box, no overlap with existing nodes, year order, empty canvas).
