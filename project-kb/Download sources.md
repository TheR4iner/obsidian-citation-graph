# Download sources

## Overview

The Download command fetches PDFs for papers on a canvas. It tries arXiv first over plain HTTPS, and then whatever secondary source the build is configured with, if any.

The indirection matters more than it looks. The download path is written entirely against one interface, so a build with a second source and a build without one share every line except the function that names the source.

## Current solution

Three files:

- `src/api/download-fallback.ts` declares the `DownloadFallback` interface. Seven members, each of which the picker actually consumes: `name` (used in progress and error text), `isAvailable()` (probed once per run), `setupHint` (shown when that probe fails), `canAttempt(paper)` (synchronous, so the picker can decide which rows are selectable), `missingIdentifierHint`, `download()`, and `isSetupError(message)`.
- `src/api/fallback-source.ts` contains `getDownloadFallback()` and nothing else. Returning `null` means arXiv is the only source.
- `src/modals/download-picker.ts` holds the whole download loop and knows nothing about any particular source.

Two design points are load-bearing:

**`isAvailable()` is probed once, not per paper.** A missing prerequisite is a property of the run, not of a paper. Probing per paper would spawn an interactive shell for every row, and reporting per paper would bury the one actionable message under N identical copies. Hence `isSetupError()`: errors it recognises are surfaced once, everything else once per paper.

**`canAttempt()` must be synchronous.** The picker calls it while building rows to decide what is selectable, so it can only look at identifiers the paper already carries. Anything requiring I/O belongs in `download()`.

## Row gating

A row is selectable when *any* configured source could attempt the paper: it has a valid arXiv ID, or the fallback's `canAttempt()` says yes. Papers no source can supply are labelled `no source` and disabled; papers already present in the download directory are labelled `downloaded` and left unchecked.

Already-downloaded detection matches the formatted filename (`Title (FirstAuthor) (Year).pdf`) that this plugin renames every download to, and falls back to matching a DOI with `/` and `.` replaced by `_`, which is how several external tools name their files.

## History

**2026-08-21**: Introduced the `DownloadFallback` seam and moved the download loop behind it. Added `src/modals/download-picker.test.ts` covering source selection and failure reporting (9 cases).

Two bugs surfaced while doing it, both from the picker having been written around a single DOI-based source:

- Row selection was gated on the paper having a DOI, so a paper with an arXiv ID but no DOI could not be downloaded at all even though the arXiv path would have worked, while a paper with a DOI and no arXiv ID was selectable and always failed. Now gated on "some source can attempt this".
- Already-downloaded detection only matched files named after the DOI. Since every successful download is immediately renamed to `Title (FirstAuthor) (Year).pdf`, it essentially never matched a file this plugin had itself downloaded. It now checks the formatted name first.
