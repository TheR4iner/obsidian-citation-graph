# Citation Graph

An Obsidian plugin that turns a Zotero collection into a **citation graph canvas**: papers as nodes, citations as edges, laid out on a timeline by year. From there you can expand the graph with references and citing works, track what you have read, download PDFs, and have an LLM summarise them, all without leaving your vault.

<!-- Demo video and GIF go here. -->

## What it does

**Build a canvas.** *Create from collection* pulls a Zotero collection; *Create from tag* pulls everything carrying one or more tags (several tags means an intersection, and importer-added tags are hidden unless you ask for them). Papers are resolved through Semantic Scholar, citation edges are drawn between any two papers both present, and each paper gets a literature note with structured frontmatter.

**Grow it.** *Expand paper* finds a paper's references and citing works, filtered by direction, keyword and year, and sorted by citation count. Pick what to add, and notes, nodes and edges appear (with the new papers optionally pushed to Zotero). *Add paper by DOI or arXiv* adds one paper directly; if Semantic Scholar does not know it, the plugin falls back to OpenAlex, arXiv and Crossref so it still lands with whatever metadata exists.

**Read through it.** Every paper carries a reading status painted as its node colour, so a canvas doubles as a reading list: *to read*, *reading*, *read*, *read with notes written*, and *abandoned*. Set them one at a time, cycle them from a hotkey, or repaint a whole canvas at once.

**Fill it in.** *Download* fetches PDFs from arXiv. *Write summary* sends a PDF to Anthropic, OpenAI, Google Gemini, or a local Claude CLI and writes a structured summary into the note, with a progress bar and a token budget you can cap.

**Keep it tidy.** *Sync canvas to Zotero* pushes new papers back. *Send papers to canvas* copies or moves papers with their edges between canvases. *Relayout canvas* re-sorts by year. *Delete paper* removes the node, its edges and the note together, which Obsidian's own delete does not.

## Requirements

- **Zotero**, running, with the local API enabled: Edit, Settings, Advanced, then tick *"Allow other applications on this computer to communicate with Zotero"*.
- **Better BibTeX** (recommended) for the citekeys used in note filenames and matching.
- For *Write summary*: an API key for Anthropic, OpenAI or Google Gemini, or the Claude CLI installed locally.
- For *Sync to Zotero*: a Zotero API key and user ID from [zotero.org/settings/keys](https://www.zotero.org/settings/keys).

## Installation

Not yet in the community marketplace, so install by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/TheR4iner/obsidian-citation-graph/releases).
2. Put all three in `.obsidian/plugins/citation-graph/` inside your vault.
3. Enable **Citation Graph** under Settings, Community Plugins.

## Commands

All are in the command palette under `Citation Graph:`.

| Command | What it does |
|---|---|
| **Create from collection** | Builds a canvas from a Zotero collection, into `<collections folder>/<collection name>/` |
| **Create from tag** | Builds a canvas from an intersection of Zotero tags, into a folder named after the tags |
| **Expand paper** | Adds a paper's references and citing works; **(force refresh)** bypasses the local cache |
| **Add paper by DOI or arXiv** | Adds one paper from a DOI, an arXiv ID, or a URL containing either |
| **Write summary** | Writes an LLM summary into the note under `## Summary` |
| **Download** | Fetches PDFs for papers on the canvas |
| **Set paper status** | Sets the selected papers to *to read*, *reading*, *read*, or *abandoned* |
| **Cycle reading status** | Advances the selection one step through *to read*, *reading*, *read*. Good on a hotkey |
| **Refresh reading status** | Repaints every paper on the canvas from its note |
| **Relayout canvas** | Re-sorts nodes chronologically, discarding manual positions |
| **Sync canvas to Zotero** | Pushes the canvas's papers back to a Zotero collection |
| **Send papers to canvas** | Copies or moves papers, with their edges, to another canvas |
| **Delete paper** | Deletes the node, its edges and the literature note together |
| **Clear Semantic Scholar cache** | Drops cached reference data if you suspect it is stale |

Commands that act on papers take the current canvas selection, and fall back to a fuzzy picker when nothing is selected.

### Worth knowing

**Reading status lives in the note**, in a `status` frontmatter field, so it follows a paper across every canvas it appears on and is queryable from Dataview. Notes predating this feature carry `read: true` and are treated as *read* until their status is next set.

**"Read with notes written" is derived, not stored.** As soon as a note contains anything beyond the generated template, whether your own prose, an added heading, a checklist, or a summary from *Write summary*, the paper is painted as annotated. It is therefore absent from the status picker, and it is why *Refresh reading status* exists: writing notes changes a paper's appearance with no command involved. Abandoned papers are the exception and stay abandoned, since notes on them usually record why you dropped the paper.

**Write summary finds the PDF** by looking for `Title (Author) (Year).pdf` in the canvas's last download directory and then in the default download path, and offers to download it if it is missing. It warns before summarising anything over ten pages, and asks whether to append or replace when a `## Summary` section already exists.

**Download** saves as `Title (FirstAuthor) (Year).pdf`. Papers already in the target directory are marked `downloaded` and left unchecked; papers no configured source can supply are marked `no source` and cannot be selected. Only arXiv ships configured, so papers with no arXiv version cannot be fetched. Adding a source means implementing `DownloadFallback` (`src/api/download-fallback.ts`) and returning it from `src/api/fallback-source.ts`; the picker, progress reporting and error messages pick it up with no other changes.

**Send papers to canvas** carries an edge over whenever both its endpoints exist on the target. It does not go looking for new ones: run *Expand paper* on the target for that.

## Settings

| Setting | Description | Default |
|---|---|---|
| **Collections folder** | Root folder for canvases. Each canvas gets a subdirectory holding the canvas and its literature notes | `collections` |
| **Zotero API key** | Needed only for syncing back to Zotero | |
| **Zotero user ID** | Numeric ID from the same Zotero keys page | |
| **Semantic Scholar API key** | Optional, raises the rate limit above the free 100 requests per 5 minutes | |
| **Node width / height** | Canvas node size in pixels | 600 / 800 |
| **To read** | Node colour for papers not started | No colour |
| **Reading** | Node colour for papers in progress | Yellow |
| **Read** | Node colour for papers finished but not written up | Cyan |
| **Read + notes written** | Node colour applied automatically once the note has content of its own | Green |
| **Abandoned** | Node colour for papers you decided not to finish; also dimmed with a dashed border | Red |
| **LLM provider** | Anthropic API, OpenAI API, Google Gemini API, or the local Claude CLI | Claude CLI |
| **Claude CLI path** | Claude CLI only. Blank auto-detects `~/.local/bin/claude`, then `claude` on Obsidian's PATH | |
| **API key** | For the selected LLM provider; not needed for Claude CLI | |
| **Model** | Overrides the provider default (`claude-sonnet-4-6`, `gpt-4o`, `gemini-2.5-flash`) | |
| **Max output tokens** | Cap per summary, controlling length and cost | 1024 |
| **Batch token budget** | Stops a batch once this many tokens are spent; 0 is unlimited. Not tracked for Claude CLI | 0 |
| **Summary prompt** | Replaces the built-in prompt. Supports `{title}`, `{authors}`, `{year}`; the PDF is attached automatically | |
| **Default download path** | Where PDFs are saved. Absolute, or starting with `~` | |

### How status colours are drawn

The colour is applied to the node's **border only**, a 3px frame at full strength with Obsidian's tinted interior removed, and the status is spelled out along the bottom edge in the same colour. Obsidian's default treatment (a 1px border at 40% opacity plus a 7% wash) is too weak to separate similar colours and tints the note's text for no benefit; at full strength on the border alone, the closest pair of statuses is roughly three times easier to tell apart.

The label is derived from the node's colour rather than stored alongside it, which keeps the `.canvas` file the single source of truth. One consequence: **two statuses sharing a colour cannot be told apart**, and the settings tab warns you when that happens.

Each colour is one of Obsidian's six presets, *No colour*, or a custom `#rrggbb` value. Presets follow your theme's `--color-*` variables; a hex value is fixed and will not adapt between light and dark mode, which is the trade-off for matching a theme that does not define those variables.

Notes on a canvas that are not papers are left alone entirely: they keep your colour, get no label, and the status commands skip them. A note counts as a paper when its frontmatter carries any of `doi`, `arxiv`, `citekey` or `semantic_scholar_id`.

## Literature notes

```yaml
---
title: "Attention Is All You Need"
authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]
year: 2017
doi: "10.48550/arXiv.1706.03762"
arxiv: "1706.03762"
citekey: "vaswani2017attention"
semantic_scholar_id: "204e3073870fae3d05bcbc2f6a8e263d9b72e776"
status: unread
cssclasses:
  - citation-graph-note
---
```

The body carries a title heading, an author/year/DOI/arXiv block, a `## Summary` section written by *Write summary*, and a `## Notes` section for you.

## How it works

The **Zotero local API** on `localhost:23119` reads collections and items, needing no authentication. **Semantic Scholar** resolves papers by DOI or arXiv ID and supplies citation relationships, with rate limiting and progress notices built in; **OpenAlex**, **arXiv** and **Crossref** cover papers it does not know. The **Zotero Web API** writes papers back and needs your API key. For summaries, Anthropic and Google take the PDF natively while OpenAI receives it as a file attachment.

## Limitations

- Papers with neither a DOI nor an arXiv ID cannot be resolved and are skipped.
- Citation edges are drawn only between papers both present on the canvas.
- Semantic Scholar's free tier allows roughly 100 requests per 5 minutes, so a large collection takes a few minutes.
- Only arXiv is configured as a PDF source, so papers without an arXiv version cannot be downloaded, and *Write summary* cannot reach their PDFs.

## Development

```bash
git clone https://github.com/TheR4iner/obsidian-citation-graph.git
cd obsidian-citation-graph
npm install
npm run build      # type-check, test, bundle
npm test           # tests alone
npm run test:watch
```

Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/citation-graph/` to try a build in your vault.

Tests run under [vitest](https://vitest.dev) over the plugin's pure logic: reading-status parsing and derivation, canvas colour validation, note-body inspection, canvas node IDs, summary placement, and the download path's source selection and failure reporting. `npm run build` runs them before bundling, so a failing test blocks a release. `obsidian` is a types-only dependency, so `vitest.config.mts` aliases it to a stub in `test/` at runtime while type-checking still uses the real declarations.

`npm install` also points `core.hooksPath` at `.githooks/`. Those hooks do nothing in a plain checkout; see `.githooks/README.md`.

## License

MIT
