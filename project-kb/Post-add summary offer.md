# Post-add summary offer

## Overview

*Add paper by DOI or arXiv ID* used to end by asking, in a modal, whether to write an LLM summary for the paper just added, and to show a "Tip: Configure LLM settings..." notice when no LLM was configured. Both are gone: summarising is now reached only through *Write summary*, from the command palette or a paper node's right-click menu.

The reasoning is cost and consent. A summary is a paid model call against a PDF the user may not have decided to read, offered at the moment they were doing something else. A prompt at that moment answers a question nobody asked, and the "Tip" branch nagged users who had deliberately left the LLM unconfigured.

## Current solution

`addPaperByDoi` ends after its confirmation notice and the no-citation-edges warning. `PostAddSummaryModal` is deleted from `src/modals/batch-summary-modals.ts`, since nothing else opened it. The other modals in that file (`BatchMissingPdfModal`, `BatchLongPaperWarningModal`, `BatchSummaryModeModal`) belong to the *Write summary* flow and stay.

`summarizePapersWithPdfs` is untouched and still serves *Write summary*, which is where the whole batch pipeline (PDF resolution, download offer, page-count warning, append/replace choice, token budget) lives.

`isLlmConfigured` is still used, by *Recommend papers*, which refuses up front rather than offering anything.

## Open questions

- *Add paper by DOI* used to be the only route that passed `citationGraphMeta.lastDownloadPath` into summarisation for a single paper. *Write summary* reads the same field itself, so nothing was lost, but it is worth remembering that the two paths resolved the PDF directory identically.

## History

### 2026-09-01 -- Removed the offer

Deleted the post-add modal and the configure-an-LLM tip, along with `PostAddSummaryModal`. README's *Write summary* section now states that adding a paper never starts a summary on its own.
