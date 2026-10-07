# Expand picker sorting

## Overview

The *Expand paper* window sorts its list by citation count, year, title, or the order the expanded paper cites its references, each ascending or descending. A dropdown picks the key and a button flips the direction; picking a key resets the direction to that key's natural one (citations and year descending, title and paper order ascending). Rows missing the sort value go last in either direction. The sort is stable, so ties keep the previous order, which gives a cheap secondary sort.

The sort lives in the Expand picker only, not the shared `PaperPickerModal`: the Recommend picker shows the model's own ranking, and sorting it was not asked for.

## Where "order in the paper" comes from

Checked against live APIs on 2026-10-07:

- **Semantic Scholar** returns references in no bibliography order. For `10.1371/journal.pcbi.1004385` its first reference is CrossRef's `ref3`.
- **OpenAlex** `referenced_works` is a set of work IDs, not ordered by the paper.
- **Crossref** `reference` arrays are in bibliography order (keys `ref1..refN`, `CR1..CRn`).

So Crossref is the only source. `getReferencesForDoi` records each entry's index in the full `reference` array as `S2Paper.referenceIndex`, taken before the no-DOI entries are dropped so the number matches the paper's own numbering. `mergePapers` in `multi-source.ts` carries it across the DOI merge, so an S2 entry inherits the position of its Crossref twin.

Coverage on the two test papers: 4 of 8 references positioned (PLOS, many references without DOIs), 88 of 98 (PRL).

## Known limits

- Needs a DOI, the CrossRef setting on, and a publisher that deposited references. arXiv-only papers never get positions; the dropdown then shows "Order in paper (not available)" disabled.
- References Crossref lists without a DOI cannot be matched to the S2 entries, so they go last. Matching on title against Crossref's `unstructured` string would recover some; not done.
- Cache entries written before this feature carry no positions. Not invalidated, to avoid re-fetching every cached paper; *expand paper (force refresh)* fixes one paper.

## History

- 2026-10-07: Added the sort control, `referenceIndex` from Crossref, and `sortChoices` with a test in `expand-picker.test.ts`. UI checked in a browser harness that shims Obsidian's DOM helpers.
