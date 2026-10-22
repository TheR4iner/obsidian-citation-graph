# Tag grouping layout

## Overview

*Canvas: group papers by tag* (command id `relayout-by-tag`, issue #58) rearranges the open canvas into one labelled canvas group node per tag, read from each paper note's `tags` frontmatter. Groups overlap: a paper with tags A and B sits where group A and group B intersect and outside every other tag group. The alternative to the year timeline that *Canvas: relayout* (`relayout-canvas`) produces.

## Current solution

- `src/canvas/tag-layout.ts` holds the pure `layoutByTag(nodes, tagOf)`, returning the new nodes plus the note paths of papers sent to the two fallback groups. `relayoutByTag` in `src/main.ts` builds `tagOf` (note path to tag list) before opening the canvas, calls the layout inside `updateCanvas` per [[Atomic canvas writes]], and shows a sticky notice naming fallback papers. File nodes absent from `tagOf` are not papers and are left alone.
- Tags come from `metadataCache` via `LiteratureNoteManager.getTags`. Safe here, unlike the status cycle in [[Reading status on canvas nodes]], because the command writes no note before reading tags. `readFrontmatterTags` accepts a list or a comma/space separated string and strips a leading `#`. Tags are deduplicated and grouped case-insensitively; the first spelling in note-path order labels the group.
- **Membership is geometric.** Obsidian decides which groups a card is in by which rectangles contain it, so placement is the whole feature. Tests check the invariant directly: every card is fully inside or fully clear of every group, and the groups containing it are exactly its tags (or exactly its one fallback group).
- **Clusters.** Tags linked by a shared paper (union-find over combinations) form a cluster; clusters are laid out side by side and never overlap. Most canvases are many one-tag clusters, which lay out exactly like plain groups with no search.
- **Search.** Per cluster, each tag gets an integer rectangle on a `(2n+1)^2` grid. A cell's membership is `colMask & rowMask`. Simulated annealing (seeded `mulberry32`, so a pure function of the input) moves one rectangle endpoint at a time, maximising the number of papers whose exact combination has a cell, with total rectangle extent as a tie-breaker. The scorer is allocation-free for clusters up to 30 tags (one 30-bit word); larger clusters use joined multi-word keys, slower but correct. Budget: `SEARCH_BUDGET` cell evaluations per cluster.
- **Geometry.** Each drawable combination takes the first cell with its exact membership. Grid lines without cards are dropped (keeping one per tag so no rectangle vanishes; dropping a line never changes the membership of the cells that remain). Columns and rows are then sized to their cards, with `CELL_PADDING` between every cell edge and its cards. Each tag rectangle is inset 10 to 55 px depending on a hash of its label, so groups that start on the same cell edge do not draw one line and stack labels; the inset is always less than the padding, so containment is unaffected.
- **Fallbacks.** `Untagged`, `Too many tags` (over `MAX_TAGS_PER_PAPER` = 3) and `Tag combination not drawable` are plain groups to the right of the clusters.
- **Idempotence.** The anchor is the min over the papers and over previous groups' positions minus their (recomputable) inset, so re-runs do not creep. Cells fill column by column after sorting by `(x, y)`, which reproduces the same order. A test pins a full second run equal to the first.
- Plugin groups carry IDs `cg-tag-<n>` (`isTagGroup`); each run and *Relayout* remove them. Groups are emitted before every other node because Obsidian paints in file order.
- New notes get `tags: []`. No plugin UI adds tags to notes, so the three-tag limit is enforced only at relayout time; any future UI that adds tags must refuse a fourth.

## Decisions

- **Overlapping groups, at most three tags** (user decision, 2026-10-22), replacing the first-tag rule that shipped briefly in #61. Duplicating cards per tag was rejected: edges attach to one node, and every other command assumes one node per paper.
- **Undrawable combinations go to a fallback group**, never into a group whose tag they lack. They are a hard geometric limit, not a search failure alone: n rectangles form at most `2n^2 - 2n + 2` regions (borders of two axis-parallel rectangles cross at most 4 times), while three-tag combinations grow as `n^3`. The test uses 12 tags with all pairs and triples: 286 combinations against at most 266 regions.

## Measured

- 3 tags, all 7 combinations: always fully drawn, about 60 ms.
- 8 tags, 60 random papers with 1 to 3 tags (44 distinct combinations): 10 to 11 papers fall back. Quadrupling the budget gained one paper at four times the cost, so the budget stays at 2e7 (about 0.3 s for that case).

## Open questions

- Coverage on dense clusters (many tags, many distinct triples) is limited. A constructive start (consecutive-ones ordering for one axis) might beat random restarts.
- Groups start at the papers' old top-left corner and can overlap the user's own nodes.
- Edge `fromSide`/`toSide` are left as they were and may point the "wrong" way after the move.
- Nested tags (`ml/transformers`) group by the full tag, not the parent.

## History

**2026-10-22 (later)** -- Overlapping groups with a three-tag limit, fallback groups with notices, cluster split, annealing search; `getPrimaryTag` replaced by `getTags`.

**2026-10-22** -- First version (#61): one group per first tag, `tags: []` in new notes, *Relayout* clears tag groups, shared confirmation dialog.
