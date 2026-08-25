# Citation Graph

An Obsidian plugin that creates **Litmaps-style citation graph canvases** from your Zotero collections. Visualize how papers cite each other on a timeline, expand the graph by discovering new references, download PDFs, generate AI-powered summaries, and sync everything back to Zotero.

---

[Features](#features) · [Prerequisites](#prerequisites) · [Installation](#installation) · [Configuration](#configuration) · [Commands](#commands) · [Literature note format](#literature-note-format) · [How it works](#how-it-works) · [Limitations](#limitations)

---

## Features

- **Create from Collection**: Pick a Zotero collection and generate an Obsidian canvas with papers as nodes and citations as directed edges, laid out on a timeline by publication year
- **Create from Tag**: Pick one or more Zotero tags (multiple tags = intersection) and generate the same kind of canvas. Toggle whether automatic importer-added tags are shown alongside your manual tags.
- **Literature notes**: Each paper gets its own markdown note with structured frontmatter (title, authors, year, DOI, arXiv, citekey, Semantic Scholar ID) and a personal notes section
- **Expand mode**: Select any paper, discover its references and citing papers via Semantic Scholar, pick which ones to add, and the plugin creates notes, nodes, edges, and optionally syncs to Zotero
- **Write Summary**: Feed a paper's PDF to an LLM (Anthropic, OpenAI, Google Gemini, or local Claude CLI) and write a structured summary directly into the literature note, with a progress bar and token budget tracking
- **Download PDFs**: Fetch paper PDFs from arXiv over HTTPS, with an extension point for plugging in a second source
- **Reading list**: Track each paper as to read, reading, read, read with notes written, or abandoned, with the status shown as a canvas node color so a canvas doubles as a reading list for a topic
- **Relayout Canvas**: Re-sort all nodes chronologically by year
- **Sync to Zotero**: Push new papers from a canvas back to your Zotero collection
- **Send Papers to Canvas**: Copy or move selected papers (with their citation edges) from one citation graph canvas to another
- **Add Paper by DOI or arXiv**: Add a single paper to the canvas by DOI or arXiv ID
- **Delete Paper**: Remove selected papers from the canvas and move their literature notes to trash in one shot

## Prerequisites

1. **Zotero** (desktop app, running)
2. **Zotero local API enabled**: In Zotero: Edit → Settings → Advanced → Check *"Allow other applications on this computer to communicate with Zotero"*
3. **Better BibTeX** (Zotero plugin, recommended): provides citekeys used for note filenames and matching
4. **LLM for Write Summary**: one of: an API key for Anthropic, OpenAI, or Google Gemini; or Claude Code CLI installed locally (legacy option)

## Installation

This plugin is not yet listed in the Obsidian community marketplace, so it must be installed manually.

1. Go to the [latest release](https://github.com/TheR4iner/obsidian-citation-graph/releases) and download `main.js`, `manifest.json`, and `styles.css`
2. In your vault, create the folder `.obsidian/plugins/citation-graph/`
3. Move the three downloaded files into that folder
4. In Obsidian: Settings → Community Plugins → enable **Citation Graph**

> **Tip:** You may need to turn on Community Plugins first (Settings → Community Plugins → Turn on community plugins).

### Build from source

```bash
git clone https://github.com/TheR4iner/obsidian-citation-graph.git
cd obsidian-citation-graph
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/citation-graph/` inside your vault, then enable the plugin as above.

`npm install` also points `core.hooksPath` at `.githooks/` for this clone. Those hooks are no-ops in a plain checkout; see `.githooks/README.md` for what they do in a fork that carries content it must not push upstream.

### Tests

```bash
npm test        # run once
npm run test:watch
```

The suite runs under [vitest](https://vitest.dev) and covers the plugin's pure logic: reading-status parsing and derivation, canvas colour validation, note-body inspection, canvas node IDs, summary placement, and the download path's source selection and failure reporting. `npm run build` runs it before bundling, so a failing test blocks a release.

`obsidian` is a types-only dependency (the app injects the implementation at runtime), so `vitest.config.mts` aliases it to a small stub in `test/`. Type-checking still uses the real Obsidian declarations.

## Configuration

Open Settings → Citation Graph to configure:

| Setting | Description | Default |
|---------|-------------|---------|
| **Collections folder** | Root folder for canvases. Each canvas (built from a Zotero collection or a tag intersection) gets its own subdirectory containing both the canvas and literature notes. | `collections` |
| **Zotero API key** | Required for syncing back to Zotero. Get one at [zotero.org/settings/keys](https://www.zotero.org/settings/keys) | |
| **Zotero user ID** | Numeric ID from the same keys page | |
| **Semantic Scholar API key** | Optional, for higher rate limits (free tier: 100 req/5min) | |
| **Node width / height** | Canvas node dimensions in pixels | 600 / 800 |
| **To read** | Canvas node color for papers not started yet | No color |
| **Reading** | Canvas node color for papers you are part-way through | Yellow |
| **Read** | Canvas node color for papers finished but not written up | Cyan |
| **Read + notes written** | Canvas node color applied automatically once the note contains anything beyond the generated template | Green |
| **Abandoned** | Canvas node color for papers you started and decided not to finish. These nodes are also dimmed and given a dashed border | Red |

The status color is applied to the canvas node's **border only**: a 3px frame at the full color, with Obsidian's default tinted interior removed. The status is also spelled out along the bottom edge of the node, in the same color.

The label is derived from the node's color rather than stored separately, so the `.canvas` file is the single source of truth for how a paper appears. A consequence: **two statuses set to the same color cannot be told apart on the canvas**, and the settings tab warns when that happens.

Notes on a canvas that are **not papers** are ignored entirely: they keep whatever color you gave them, get no status label, and are skipped by the status commands. A note counts as a paper when its frontmatter carries any of `doi`, `arxiv`, `citekey`, or `semantic_scholar_id`. Obsidian normally draws a colored node as a 1px border at 40% of the color plus a 7% wash across the interior, which is too weak to distinguish similar colors and tints the note's own text for no benefit. Drawn at full strength on the border alone, the closest pair of statuses is roughly three times easier to tell apart.

Each status color is one of Obsidian's six presets, **No color**, or **Custom hex...** with a `#rrggbb` value. Presets follow your theme's `--color-*` variables; a hex value is fixed and does not adapt between light and dark mode, which is the tradeoff for matching a theme that does not define those variables.
| **LLM Provider** | LLM service for Write Summary: Anthropic API, OpenAI API, Google Gemini API, or Claude CLI (local) | Claude CLI |
| **Claude CLI path** | Only shown when Provider is Claude CLI. Leave blank to auto-detect: the plugin first checks `~/.local/bin/claude` (the official installer's location) then falls back to `claude` on Obsidian's PATH. Set an absolute path only if auto-detection fails or you want to override it. | |
| **API key** | API key for the selected LLM provider (not needed for Claude CLI) | -- |
| **Model** | Model name override, applied to every provider including Claude CLI (leave empty for the provider default: claude-sonnet-4-6 / gpt-4o / gemini-2.5-flash / claude-sonnet-4-6) | -- |
| **Max output tokens** | Maximum tokens per summary response (controls length and cost) | 1024 |
| **Batch token budget** | Stop batch summarization after this many total tokens; 0 = unlimited. Not tracked with Claude CLI. | 0 |
| **Summary prompt** | Custom prompt for Write Summary. Leave blank for the built-in default. Supports placeholders `{title}`, `{authors}`, `{year}`; the PDF is attached by the provider automatically. | |
| **Default download path** | Filesystem path where PDFs are saved by default (used as the download target by Write Summary). Use an absolute path, or start with `~` for your home directory. | |

## Commands

All commands are available via the command palette (`Ctrl/Cmd + P`) under the "Citation Graph:" prefix.

### Create from Collection

Creates a new citation graph canvas from a Zotero collection.

1. Make sure Zotero is running
2. Run **Citation Graph: Create from Collection**
3. Select a Zotero collection
4. The plugin fetches items from Zotero, resolves them on Semantic Scholar, discovers citation relationships between papers in the collection, creates literature notes, and opens the canvas

Both the canvas and literature notes are placed in `<collections folder>/<collection name>/`.

### Create from Tag

Creates a citation graph canvas from items that share one or more Zotero tags.

1. Make sure Zotero is running
2. Run **Citation Graph: Create from Tag**
3. The modal lists every tag in your library with the number of items carrying it
   - **Show automatic tags** toggles tags added by importers (Better BibTeX, OAI imports, etc.) on or off. Off by default so the list is dominated by your own tags.
   - Type in the search box to filter the tag list
4. Click one or more tags. Multiple selections are an **intersection**: items must carry every selected tag to be included
5. The header line shows how many items currently match the intersection
6. Click **Create canvas** to fetch the matching items, resolve them on Semantic Scholar, build the canvas, and write literature notes

The canvas folder is named from the joined tag list (e.g. `attention + transformers`). Tag-built canvases are not linked to any Zotero collection; running Sync to Zotero on one will prompt you to pick or create a target collection.

### Expand Paper

Discovers references and citing papers for a selected paper and optionally adds them to the canvas.

1. Open a citation graph canvas
2. Select a paper node (or run without a selection to use the fuzzy picker)
3. Run **Citation Graph: Expand Paper**
4. Browse discovered papers filtered by "Cites", "Cited by", or "Both"
   - Papers already on the canvas are greyed out
   - Results are sorted by citation count
   - Use the keyword search and year filter to narrow results
5. Select papers to add and click "Add selected papers"
   - Optionally use "Add selected & ban rest" to hide the unselected papers from future expand results
6. New notes, nodes, and edges are added; if Zotero credentials are configured, new papers are also added to the Zotero collection

**Citation Graph: Expand Paper (Force Refresh)** bypasses the local cache and re-fetches from Semantic Scholar.

### Write Summary

Generates an AI-powered summary of a paper from its PDF and writes it into the literature note under a `## Summary` section.

1. Select a paper node on the canvas (or use the fuzzy picker)
2. Run **Citation Graph: Write Summary**
3. The plugin resolves the PDF by looking for the expected filename (`Title (Author) (Year).pdf`) in:
   - The canvas's last download directory (from a previous Download command)
   - The **Default download path** from settings
4. If the PDF is not found, you are offered to download it automatically (saves to Default download path)
5. If the paper appears to be more than 10 pages, a warning is shown before proceeding
6. If a `## Summary` section already exists, you choose to **Append** (adds a `---` separator before the new summary) or **Replace** (requires a second confirmation)
7. The configured LLM provider processes the PDF and the summary is written into the note
8. When summarizing multiple papers, a progress modal shows a progress bar, per-paper status, and running token count. You can cancel at any time.

The summary includes subsections for Main Contribution, Key Ideas, Results, and Limitations, with MathJax equations where appropriate.

If a **batch token budget** is configured, the batch stops automatically when the budget is reached.

### Download

Downloads PDFs for papers on the current canvas.

1. Open a citation graph canvas
2. Run **Citation Graph: Download**
3. Select a download directory (remembered per canvas for next time)
4. Check the papers to download
5. The plugin fetches each paper's PDF from arXiv over HTTPS

PDFs are saved as `Title (FirstAuthor) (Year).pdf`. Papers already present in the download directory are marked `downloaded` and left unchecked, and papers no configured source can supply are marked `no source` and cannot be selected.

Only arXiv is configured out of the box, so papers without an arXiv version cannot be downloaded. The download path is written against a `DownloadFallback` interface (`src/api/download-fallback.ts`) that is consulted whenever arXiv has nothing: implement it in your own module, return an instance from `src/api/fallback-source.ts`, and the picker, progress reporting and error messages pick the new source up with no further changes.

### Set Paper Status

Sets the reading status of the selected papers, so a citation graph canvas doubles as a reading list. Each status paints its node a different color (all five are configurable in settings).

1. Select one or more paper nodes on the canvas (or use the fuzzy picker for single selection)
2. Run **Citation Graph: Set Paper Status**
3. Pick one of **To read**, **Reading**, **Read**, or **Abandoned**

**Read + notes written** is not in the picker because it is not stored: the plugin derives it from the note itself. As soon as a note contains anything beyond the generated template, the paper is painted as annotated. That includes your own prose, a heading you added, a checkbox list, or a summary written by the **Write Summary** command, and it does not depend on the `## Notes` heading still being there. Abandoned papers are the exception and stay abandoned even once annotated, since notes on them are usually a record of why you dropped the paper.

The status lives in the literature note's `status` frontmatter field, so it follows the paper across every canvas it appears on, and is queryable from Dataview. Notes created before this feature carry `read: true` instead; they are read as **Read** and upgraded the next time their status is set.

### Refresh Reading Status

Repaints every paper on the active canvas from its literature note. Use it after writing notes on several papers, or once on a canvas built before reading statuses existed.

1. Open a citation graph canvas
2. Run **Citation Graph: Refresh Reading Status**

The other status commands keep a paper current as you change it, but two things drift without this: **Read + notes written** is derived from the note body, so writing notes changes a paper's appearance with no command involved, and papers whose notes predate this feature carry no status label until something writes one.

### Cycle Reading Status

Advances the selected papers one step through **To read** to **Reading** to **Read**, for marking progress without opening the picker. Bind it to a hotkey for fast passes over a canvas. Abandoned papers re-enter the cycle at the start, and **Read + notes written** is skipped because it is derived rather than set.

1. Select one or more paper nodes on the canvas (or use the fuzzy picker for single selection)
2. Run **Citation Graph: Cycle Reading Status**

### Relayout Canvas

Resets all node positions, re-sorting papers chronologically by publication year.

1. Open a citation graph canvas
2. Run **Citation Graph: Relayout Canvas**
3. Confirm the dialog (existing custom positioning will be lost)

### Sync Canvas to Zotero

Syncs papers from the current canvas back to Zotero.

1. Open a citation graph canvas
2. Run **Citation Graph: Sync Canvas to Zotero**
3. If the canvas is linked to an existing Zotero collection, papers are updated in place
4. If no collection is linked, you are prompted to select an existing collection or create a new one

Requires Zotero API key and user ID in settings.

### Send Papers to Canvas

Copies or moves selected papers (with their citation edges) from the current citation graph canvas to another one.

1. Open a citation graph canvas
2. Run **Citation Graph: Send Papers to Canvas**
3. Check the papers to transfer
4. Choose **Copy** (papers stay on the source canvas) or **Move** (papers and any wholly-internal edges are removed from the source)
5. Pick the target canvas from the list of other citation graph canvases in the vault

Edges are carried over wherever both endpoints exist on the target. Cross-canvas edges that were not present on the source are not auto-discovered; run Expand Paper on the target if you want to find them.

### Add Paper by DOI or arXiv

Adds a single paper to the current canvas by DOI or arXiv ID.

1. Open a citation graph canvas
2. Run **Citation Graph: Add Paper by DOI or arXiv**
3. Enter a DOI (e.g. `10.48550/arXiv.1706.03762`), arXiv ID (e.g. `1706.03762`), or a URL containing either
4. The paper is resolved via Semantic Scholar; if Semantic Scholar doesn't know the paper, the plugin falls back to OpenAlex, arXiv, and CrossRef in turn so the paper is still added with whatever metadata is available. A literature note is created and the node is added to the canvas
5. References and citations are pulled from any source that has them. If none of the sources expose citation edges for the paper, it is still added — you'll see a warning notice and the paper simply has no edges yet
6. If LLM settings are configured, you will be asked whether to generate an automatic summary

### Delete Paper

Removes selected papers from the canvas and moves their literature notes to trash. Obsidian's default *Delete file* command only removes the canvas node, leaving the note file orphaned (and vice versa) — this command does both in one shot.

1. Open a citation graph canvas
2. Select one or more paper nodes (or run without a selection to use the fuzzy picker for a single paper)
3. Run **Citation Graph: Delete Paper**
4. Confirm the dialog

The canvas node, all citation edges touching it, and the literature note are removed. Notes go to trash according to your Obsidian setting (system trash, vault `.trash`, or permanent), so deletions are recoverable unless you've configured permanent delete.

### Clear Semantic Scholar Cache

Clears the local cache of Semantic Scholar reference data. Use this if you suspect stale data is affecting expand results.

## Literature note format

Each note is created with YAML frontmatter:

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

# Attention Is All You Need

**Authors**: Ashish Vaswani, Noam Shazeer, Niki Parmar
**Year**: 2017
**DOI**: [10.48550/arXiv.1706.03762](https://doi.org/10.48550/arXiv.1706.03762)
**arXiv**: [1706.03762](https://arxiv.org/abs/1706.03762)

## Summary

(written by Write Summary command)

## Notes

(your personal notes)
```

## How it works

- **Zotero local API** (`localhost:23119`) reads collections and items; no authentication needed for reading
- **Semantic Scholar API** resolves papers by DOI/arXiv and discovers citation relationships
- **Zotero Web API** (`api.zotero.org`) writes new papers and read status back to Zotero; requires an API key
- **LLM providers**: Write Summary sends the PDF to the configured provider (Anthropic, OpenAI, or Google Gemini via their HTTP APIs, or the local Claude CLI). Anthropic and Google support native PDF input; OpenAI sends the PDF as a file attachment.
- Rate limiting is built in for Semantic Scholar with progress notifications

## Limitations

- Papers without a DOI or arXiv ID cannot be resolved on Semantic Scholar and will be skipped
- Citation edges are only drawn between papers that are both on the canvas
- Semantic Scholar's free tier allows ~100 requests per 5 minutes, so large collections may take a few minutes to process
- Write Summary requires an LLM provider configured in settings (API key for Anthropic/OpenAI/Google, or Claude Code CLI installed locally); PDF must be downloadable from a configured source (arXiv out of the box)

## License

MIT
