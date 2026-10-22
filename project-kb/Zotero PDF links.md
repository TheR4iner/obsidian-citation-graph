# Zotero PDF links

## Overview

Issue #57 (split from #55, case 1): when papers are added to a canvas, find each one in the local Zotero by DOI and link the PDF Zotero stores from the note's `pdf` frontmatter property. *PDFs: link from Zotero* reruns the check over the active canvas. Setting `linkZoteroPdfs` (default on) gates only the automatic run.

Sibling #56 (link a PDF the plugin downloaded) writes the same `pdf` property with the same rule: null, `""` or `"null"` count as empty, anything else is never overwritten.

## Current solution

Zotero 7 local API, verified against Zotero's own source on the `7.0` branch (`chrome/content/zotero/xpcom/server/server_localAPI.js`, `xpcom/data/item.js`), since no instance was running to query:

1. `GET /api/{users/0|groups/<id>}/items?q=<doi>&qmode=fields`. `qmode` maps straight to the search condition `quicksearch-<qmode>`; `fields` is all fields (DOI and Extra included) without full text, so a PDF that merely cites the DOI does not match. Results are still filtered to an exact case-insensitive DOI (`ZoteroClient.extractDOI`, so a DOI in Extra counts).
2. Each regular item's response JSON carries `links.attachment` = its best attachment (`getBestAttachment`: oldest PDF first) with `href` (an API URL on localhost), `attachmentType`, and `attachmentSize`, which is **omitted when the file is missing on disk**. `pdfAttachmentPath` requires `application/pdf` and a size, and only follows an href whose path matches `/api/(users|groups)/<n>/items/<KEY>`.
3. `GET <that path>/file/view/url` answers `text/plain` with `item.getLocalFileURL()`, a `file://` URL. This covers imported and linked files alike, which `links.enclosure` (imported only) would not. Hence `localGetText` beside `localGet`.

`pdfLinkValue` in `src/paper-files.ts` turns the URL into `[[vault/relative.pdf]]` when the file is inside the vault (`isInside`, not a prefix test), else keeps the `file://` URL. `setPdfLink` in `src/notes/literature.ts` writes only an empty property and reports whether it wrote.

Error handling: an unreachable server raises `ZoteroUnreachableError` (connect error or timeout in `localGetText`); the run stops with one notice and the add that triggered it still succeeds. Other per-paper failures are logged and counted in the closing notice. The automatic run is silent when it linked nothing, so users without Zotero see at most the one "cannot connect" notice per add.

Hooked after the canvas write in `buildCanvasFromItems`, `expandPaper`, `addPaperByDoi` and `addRecommendedPapers`. *Send papers to canvas* does not run it: those notes already exist.

## Open questions

- Papers with only an arXiv ID are not looked up. Zotero items for preprints often carry the arXiv-minted DOI, which is matched; a search by arXiv ID could be added if asked.
- Group libraries are searched one after another per paper. With many groups that is many requests; fine at local-server latency.
- Once #56 lands, its `linkPdf` should delegate to `setPdfLink` so the empty-value rule lives once.

## History

**2026-10-22** -- Implemented for #57. Format verified from Zotero 7.0 source; no live instance was running.
