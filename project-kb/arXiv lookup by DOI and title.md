# arXiv lookup by DOI and title

## Overview

`src/api/arxiv-lookup.ts` finds the arXiv ID of a paper whose note does not record one, so the download path never reports "no source" without having asked arXiv.

The problem it solves: Semantic Scholar files a preprint and the journal article it became as two unrelated records far more often than it links them. A paper added by the DOI of its published version therefore lands with `arxiv: null` in frontmatter, and the preprint is sitting on arXiv the whole time.

## Current solution

`findArxivId(paper, clients)` tries four routes, cheapest first, and returns null rather than guessing:

1. `paper.arxiv`, normalised through `normalizeArxiv` from `recommend.ts`.
2. An arXiv-minted DOI (`10.48550/arXiv.X`). No network.
3. OpenAlex's record of where the DOI is hosted: `OpenAlexClient.getLocationUrlsForDoi` selects `locations,best_oa_location` and returns every `landing_page_url` and `pdf_url`, which `arxivIdFromUrl` scans for `arxiv.org/abs/` or `arxiv.org/pdf/`. This is the route that usually works.
4. `ArxivMetadataClient.searchByTitle`, confirmed with `titlesMatch`.

**arXiv's API has no DOI field.** Its supported search prefixes are `ti`, `au`, `abs`, `co`, `jr`, `cat`, `rn`, `id` and `all`. That is why route 3 exists at all: OpenAlex is the only cheap way from a publisher DOI to an arXiv ID.

**A title search must be confirmed, never trusted.** arXiv ranks by relevance and happily returns near misses; accepting one downloads a different paper and files it under this note. `titlesMatch` compares on letters and digits alone (the three sources disagree about hyphens, case and trailing punctuation) and requires the *whole* title, so a prefix is rejected.

**Query building.** `searchByTitle` strips everything but letters, digits and spaces before quoting the phrase, because a colon or bracket in a title makes arXiv reject the query outright, and caps it at the first 20 words.

An ID discovered during a run comes back in `DownloadOutcome.resolvedArxiv`, keyed by note path, and `recordArxivIds` in `main.ts` writes it into frontmatter so the next run needs no lookup.

## Open questions

- Cost: routes 3 and 4 are one rate-limited request each (OpenAlex 150ms, arXiv 3s), per paper with no recorded ID. A batch of forty such papers spends around two minutes in lookups. That is why the picker leaves those rows unticked by default; see [[Download sources]].
- Route 3 trusts OpenAlex's location list. A work whose arXiv location OpenAlex has not recorded falls through to the title search, which is the slow path.

## History

**2026-09-01 — introduced**, in response to a paper added by a non-open-access publisher DOI being greyed out in the download window despite being on arXiv. Unit-tested without network (17 cases) by injecting fakes for both clients.
