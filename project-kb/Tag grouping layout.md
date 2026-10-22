# Tag grouping layout

## Overview

*Canvas: group papers by tag* (command id `relayout-by-tag`, issue #58) rearranges the open canvas into one labelled canvas group node per tag, read from each paper note's `tags` frontmatter. The alternative to the year timeline that *Canvas: relayout* (`relayout-canvas`) produces.

## Current solution

- `src/canvas/tag-layout.ts` holds the pure `layoutByTag(nodes, tagOf)`; `relayoutByTag` in `src/main.ts` builds `tagOf` (note path to first tag or null) before opening the canvas, then calls it inside `updateCanvas`, per [[Atomic canvas writes]]. File nodes absent from `tagOf` are not papers and are left alone, the same convention as the status colour map.
- Tags come from `metadataCache` via `LiteratureNoteManager.getPrimaryTag`. Safe here, unlike the status cycle in [[Reading status on canvas nodes]], because the command writes no note before reading tags. `readFrontmatterTags` accepts a list or a comma/space separated string and strips a leading `#`. Only frontmatter tags count, not inline body tags.
- New notes get `tags: []` so the Properties panel shows the slot.
- Plugin-made groups carry IDs `cg-tag-<n>` (`isTagGroup`). Each run removes them and redraws, and *Relayout* removes them too, so they never outlive the layout that drew them. The user's own groups are untouched.
- Groups are emitted before every other node: Obsidian paints in file order, so a group after its cards would cover them.
- Layout anchors on the min corner of the papers **and** the previous tag groups, otherwise each re-run creeps right and down by the group padding. Cards fill a near-square grid **column by column** after sorting by `(x, y)`, which is what makes a re-run reproduce the same order (row-major fill plus an x-first sort permuted cards on every run). A test pins idempotence.
- Both relayout commands share `confirmPositionReset`, since both discard manual positions.

## Decisions

- **Multi-tag paper: first tag, one card.** A duplicate card would need a second node ID, and edges attach to exactly one node, so duplicates would either drop arrows or need edge cloning; the canvas would also stop being one-node-per-paper, which every other command assumes (`hasPaperNode`, send, delete). Users control the grouping by tag order.
- **Untagged papers** go in a final "Untagged" group, keyed by null internally so a paper literally tagged `Untagged` gets its own `#Untagged` group.
- **Status colours** are untouched: nodes are moved with `{...node, x, y}`, so `color` survives, and the status label is a note cssclass that does not depend on position.

## Open questions

- Groups start at the papers' old top-left corner and can overlap the user's own nodes. Not solved: avoiding them means a packing problem for little gain.
- Edge `fromSide`/`toSide` are left as they were and may point the "wrong" way after the move.
- Nested tags (`ml/transformers`) group by the full tag, not the parent.

## History

**2026-10-22** -- Implemented for #58: command, pure layout with tests, `tags: []` in new notes, *Relayout* clears tag groups, shared confirmation dialog.
