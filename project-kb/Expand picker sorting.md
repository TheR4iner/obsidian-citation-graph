# Expand picker sorting

## Overview

The *Expand paper* window sorts its list by citation count, year, title, or the order the expanded paper cites its references, each ascending or descending. A dropdown picks the key and a button flips the direction; picking a key resets the direction to that key's natural one (citations and year descending, title and paper order ascending). Rows missing the sort value go last in either direction. The sort is stable, so ties keep the previous order, which gives a cheap secondary sort.

The sort lives in the Expand picker only, not the shared `PaperPickerModal`: the Recommend picker shows the model's own ranking, and sorting it was not asked for.

## Where "order in the paper" comes from

Checked against live APIs on 2026-10-07:

- **Semantic Scholar** returns references in no bibliography order. For `10.1371/journal.pcbi.1004385` its first reference is CrossRef's `ref3`.
- **OpenAlex** `referenced_works` is a set of work IDs, not ordered by the paper.
- **Crossref** `reference` arrays are in bibliography order (keys `ref1..refN`, `CR1..CRn`).

So Crossref is the only source. `CrossRefClient.getReferenceList` returns every entry in order, DOI or not, with its deposited text (`article-title`, `volume-title`, `unstructured`). A DOI missing from the `DOI` field is pulled out of the `unstructured` text when a publisher URL carries one. After the merge, `numberByBibliography` in `multi-source.ts` sets `referenceIndex` on the merged papers in three passes:

1. DOI match whose title is contained in the entry's text (both reduced to lowercase letters and digits).
2. For entries still open, the longest unplaced paper title (at least 20 normalized characters) the entry's text contains.
3. For entries still open, the DOI match unconfirmed (book chapters where the text names only the book).

Pass 1 must confirm the title because publishers deposit wrong DOIs. Found on `10.1038/s42005-023-01233-w`: ref 11, "Quantum reservoir processing" (npj QI 5, 2019, real DOI `10.1038/s41534-019-0149-8`), carries `10.1038/s41534-018-0113-z`, which is "Soundness and completeness of quantum root-mean-square errors". OpenAlex inherits the same wrong DOI, and S2 lists both papers. Before the title check, slot 11 showed the wrong paper and the right one sank to the end.

`deduplicatePapers` also folds a DOI-less paper into the DOI entry with the same normalized title, and keys an arXiv-only S2 paper by `10.48550/arXiv.<id>`, so books and preprints that one source lists with a DOI and another without appear once and get a position.

Coverage: 40 of 41 on `10.1038/s42005-023-01233-w` with S2 reachable (the one miss is an entry naming only a conference). Before title matching: 4 of 8 (PLOS `10.1371/journal.pcbi.1004385`), 88 of 98 (PRL).

## Known limits

- Needs a DOI, the CrossRef setting on, and a publisher that deposited references. arXiv-only papers never get positions; the dropdown then shows "Order in paper (not available)" disabled.
- Entries with neither a DOI nor a title in their text (e.g. "Huang et al. 2004 IEEE international joint conference on neural networks, 985-990") stay unplaced. Matching on first author plus year would catch them but risks mismatches; not done.
- Pass 2 is a substring heuristic: a DOI-less entry whose real paper is absent from every source could be claimed by a different paper whose long title its text happens to contain.
- Positions are only as complete as the merged list: with S2 unreachable, papers only S2 knows are absent (see [[Semantic Scholar rate-limit feedback]]).
- Cache entries written before this feature carry no positions. Not invalidated, to avoid re-fetching every cached paper; *expand paper (force refresh)* fixes one paper.

## History

- 2026-10-07: Report that "many references are not picked up" when expanding `10.1038/s42005-023-01233-w`, e.g. ref 11. Causes: the wrong deposited DOI above, DOI-less Crossref entries dropped, duplicate rows across sources, and a failed S2 request swallowed and cached. Replaced the index-at-parse approach with `numberByBibliography` after the merge; test in `src/api/multi-source.test.ts` built from that paper's real data.
- 2026-10-07: Added the sort control, `referenceIndex` from Crossref, and `sortChoices` with a test in `expand-picker.test.ts`. UI checked in a browser harness that shims Obsidian's DOM helpers.
