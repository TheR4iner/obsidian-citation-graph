# Changelog

All notable changes to Citation Graph are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version here is also the body of the matching [GitHub release](https://github.com/TheR4iner/obsidian-citation-graph/releases).

## [Unreleased]

### Fixed

- Cycling the reading status of a paper that has a summary or notes in it now works. Such a paper was labelled *Read + notes written* whatever its actual status, so cycling it appeared to do nothing, or to flip between two labels at random. Two separate causes: *Read + notes written* was derived from the note's content alone, which meant the plugin's own *Write summary* silently marked papers as read; and the cycle read the current status from Obsidian's metadata cache, which lags behind writes, so a second press could decide from the status before the first press.
- *Read + notes written* now means both halves: a paper reaches it when it is marked *Read* **and** its note has content of its own. A paper you have never opened is no longer labelled as read because something was written into its note.

### Changed

- Reading status is now drawn entirely from the plugin's stylesheet, so a theme or a CSS snippet can restyle any status without the plugin's help. Nothing looks different: the same labels, the same thicker frame on a paper you have started, the same dashed and faded treatment for an abandoned one. The status reaches the canvas as a `citation-graph-status-*` class on the literature note instead of being inferred from the node's colour, which has two visible consequences. Two statuses sharing a colour now read differently, by their labels, where before they were indistinguishable. And a status you left on *No colour* is now labelled correctly, where before it fell back to "To read".

- **Citation Graph now requires Obsidian 1.7.2 or later.** The manifest previously claimed 1.4.0, which was never true: the settings tab has always needed 1.4.10, deleting a paper has needed 1.6.6, and the reference cache and log file need 1.7.2. On an older Obsidian the plugin failed to load rather than saying why. `versions.json` has been corrected for every past release for the same reason.
- The README now sets out, in one place, every remote service the plugin contacts and what is sent to it, why PDFs live outside your vault, that the `claude` binary is the one already on your machine and nothing is ever downloaded or installed for you, and which features bill to your own account. There is no telemetry of any kind.
- A few buttons and labels now read in sentence case: *Download all*, *Skip these*, *Proceed with all*, and the download picker's *Downloaded* and *No ID yet* badges.

## [0.4.0] - 2026-09-01

### Added

- *Download* now searches arXiv before telling you a paper has no source. A paper added by the DOI of its published version usually carries no arXiv ID, because Semantic Scholar files the preprint and the journal article as two unrelated records, and it used to be greyed out in the download window even when the preprint was sitting on arXiv. Such a paper is now shown as `no ID yet` and stays selectable; selecting it makes the download run look it up, through the arXiv-minted DOI, then OpenAlex's record of where the DOI is hosted, then a title search on arXiv itself. An ID found this way is written into the note's frontmatter, so the next run has it already. A title search hit whose title is not the same paper is rejected rather than downloaded.

### Changed

- Downloading a single paper no longer opens a window to ask which paper. Selecting one node and running *PDFs: download* downloads it, as long as a folder is already known from the canvas's last download or the *Default download path* setting. The picker still appears for several papers, or when no folder has been set yet.
- Reading-status colours, frame widths and the fade on abandoned papers are now defined in the plugin's stylesheet rather than generated in JavaScript, so a theme or a CSS snippet can restyle them. What the plugin generates at runtime is only the mapping from your chosen colours to the statuses they stand for.

### Fixed

- Long-running commands no longer discard work done while they ran. *Resolve missing citation edges*, *Expand paper*, *Recommend papers* and *Write summary* can each spend minutes waiting on Semantic Scholar or a language model, and each used to save a copy of the canvas or note taken before that wait: a node you added, moved or deleted in the meantime was silently reverted, and text typed into a note being summarised was overwritten. Every canvas and note write now re-reads the file and applies its change to what is actually there.
- Removing a paper from the banned list in the settings no longer restores bans added elsewhere while the manager was open.
- Building a canvas from a large collection is much faster in a large vault. Matching each paper against existing notes used to walk every note in the vault twice, once per paper.
- The plugin's log file is written through Obsidian rather than directly to disk, and a failure to write it is now reported in the developer console instead of passing unnoticed.

## [0.3.0] - 2026-09-01

### Added

- **Canvas: resolve missing citation edges**: re-checks every paper on the canvas against the citation sources and draws each edge whose two endpoints are both already present. Nodes are never moved, so hand-placed positions survive, and an edge already drawn is left alone, so the command is safe to re-run. It is the way to fill in arrows a canvas is missing between papers that arrived by separate routes, which *Expand paper* cannot do: it lists an already-present paper with its row disabled. **(force refresh)** re-queries every paper instead of reusing cached reference data. The closing notice reports edges added, papers served from the cache, papers no source had citation data for, and papers carrying no identifier to look up; the titles behind the last two go to `citation-graph.log`.

- Paper pickers now unfold a full abstract on request: rows still show the first 200 characters, and a **Show more** link next to the cut opens the rest in place (**Show less** folds it back). Every picker gains this, so the abstracts in *Expand paper*, *Recommend papers* and the rest can be read without leaving the dialog. An unfolded abstract stays open while you type in the search box or mark a paper uninteresting.

### Changed

- *Add paper by DOI or arXiv ID* no longer asks whether to write an LLM summary once the paper is on the canvas, and no longer suggests configuring an LLM when none is set up. Summarising is a paid call on a paper you may not have decided to read yet, so it now happens only when you ask for it: run *Write summary* from the command palette, or from a paper node's right-click menu.

### Fixed

- *Expand paper* now draws the citation edge for a paper whose metadata came from OpenAlex, arXiv or Crossref rather than Semantic Scholar. Such a paper was added to the canvas as a node and a note, but its arrow to the expanded paper was dropped without a word, so the two sat side by side unconnected.
- *Expand paper* now also connects the expanded paper to papers already on the canvas that cite it or that it cites. Previously an expansion only drew edges to the papers it added in that run, so a reference that arrived on an earlier run stayed unlinked with no way to link it: the picker lists it as already present and will not let you tick it again. Re-running *Expand paper* on a node now fills in its missing arrows.
- A citation edge that cannot be matched to a node is recorded in `citation-graph.log` with both of its endpoints instead of vanishing silently.
- Every canvas command now works on a canvas Obsidian has just created. Such a canvas is an empty file on disk, which the plugin could not read: *Add paper by DOI or arXiv ID*, *Send papers to another canvas* and the rest all failed with `Unexpected end of JSON input`. Adding a paper to a blank canvas now simply adds it, and the commands that need papers say so plainly instead of reporting a parse error. A canvas whose contents are genuinely corrupt still reports an error, now naming the file.
- A canvas populated only with *Add paper by DOI or arXiv ID*, never created from a Zotero collection or tag, is now recognised as a citation graph canvas: it takes its name from the file, so *Send papers to another canvas* and *Sync canvas to Zotero* accept it instead of refusing it.

## [0.2.1] - 2026-08-27

### Added

- The README now shows a canvas rather than only describing one: a close-up of six paper nodes, where the metadata, the status colours and the citation edges are all visible, and a wide shot of the same canvas showing the year-ordered layout.
- A contributing guide, `CONTRIBUTING.md`, covering the branch model, the checks a change has to pass, and what a pull request is expected to bring with it.

## [0.2.0] - 2026-08-27

### Added

- Right-clicking a paper node on a canvas now offers its per-paper commands directly: *Expand paper*, *Set paper status*, *Cycle reading status*, *Download*, *Write summary* and *Delete paper*. With several nodes selected the same entries appear, minus *Expand paper*, and each one says how many papers it will act on. Nodes that are not literature notes get no entries, and every command is still in the command palette.
- **Recommend papers**: describes the current canvas to the same LLM used for summaries, asks which further papers belong on it, and offers the answers in the checkbox list *Expand paper* uses. Accepted papers arrive with notes, nodes and citation edges to the rest of the canvas. A prompt box at invocation replaces the default instructions for one run, and *Include abstracts* there sends abstracts as well as titles, off by default.
- Every suggestion is checked against Semantic Scholar, OpenAlex, arXiv and Crossref before it is offered. A paper no source can find is discarded, as is one whose DOI turns out to belong to a different paper; both counts are reported and the titles go to `citation-graph.log`.
- Web search during recommendations, where the provider has it: the Anthropic API, Google Gemini and the Claude CLI. The OpenAI endpoint used here has no search tool, and the prompt box says so rather than implying otherwise.
- Settings for recommendations: how many papers to ask for, whether to search the web, an output-token cap, and a standing prompt.
- Long-running commands now show a clock and, with the Claude CLI, what the model is doing as it happens: thinking, searching the web for a given query, or writing its answer.

### Changed

- Commands are now grouped in the command palette by a second prefix: **Canvas**, **Papers**, **Reading**, **PDFs** and **Maintenance**. Typing the group name narrows the palette to that group. Existing hotkeys are unaffected.
- The thirteen commands that need an open canvas no longer appear in the command palette while none is open, so the palette stays short when you are reading a note. *Create from collection*, *Create from tag* and *Clear Semantic Scholar cache* are always available. Hotkeys are unaffected and every command is still listed under Settings, Hotkeys.
- Semantic Scholar requests are now retried after 5, 15 and 45 seconds when the service throttles them, with the wait shown in the notice, instead of failing on the spot. With an API key configured, requests are spaced 1 second apart rather than 3.
- The default model for the Anthropic API and the Claude CLI is now `claude-sonnet-5`.
- Clearing the **Collections folder** setting now keeps collection directories at the top of the vault instead of snapping back to `collections`. Leading and trailing slashes are stripped, so `/` and an empty value mean the same thing.

### Fixed

- A Semantic Scholar API key entered in settings now takes effect immediately. It was previously read only when the plugin loaded, so a newly added key did nothing until Obsidian restarted, and commands kept hitting the unauthenticated rate limit. The same applies to the contact email used for OpenAlex and Crossref.
- Answers from the Anthropic API and Google Gemini are no longer truncated when they arrive in several pieces, which happens whenever a response carries tool use or search citations. Summaries were affected as well as recommendations.
- Reading status is drawn correctly again when the status colours are Obsidian presets, which is the default. Every paper previously kept the *To read* label whatever its real status, and abandoned papers lost their dashed, dimmed frame. Only custom `#rrggbb` colours were unaffected.

## [0.1.0] - 2026-08-25

First public release.

### Added

- **Create from collection** and **Create from tag**: build a citation graph canvas from a Zotero collection or an intersection of Zotero tags, with papers resolved through Semantic Scholar, citation edges drawn between any two papers both present, and a literature note per paper.
- **Expand paper**: add a paper's references and citing works, filtered by direction, keyword and year, sorted by citation count, with the new papers optionally pushed to Zotero.
- **Add paper by DOI or arXiv**: add one paper from a DOI, an arXiv ID or a URL containing either, falling back to OpenAlex, arXiv and Crossref when Semantic Scholar does not know it.
- Reading status painted as node colour, in five states: *to read*, *reading*, *read*, *read with notes written*, and *abandoned*. Status lives in the note's `status` frontmatter field, so it follows a paper across canvases. **Set paper status**, **Cycle reading status** and **Refresh reading status** drive it.
- **Write summary**: send a paper's PDF to Anthropic, OpenAI, Google Gemini or a local Claude CLI and write a structured summary into the note, with a progress bar, a per-summary output cap and a batch token budget.
- **Download**: fetch PDFs from arXiv into a configurable directory.
- **Sync canvas to Zotero**, **Send papers to canvas**, **Relayout canvas**, **Delete paper**, and **Clear Semantic Scholar cache**.
- Settings for the collections folder, the Zotero and Semantic Scholar API keys, node size, the five status colours, and the full LLM configuration.

[Unreleased]: https://github.com/TheR4iner/obsidian-citation-graph/compare/0.4.0...HEAD
[0.4.0]: https://github.com/TheR4iner/obsidian-citation-graph/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/TheR4iner/obsidian-citation-graph/compare/0.2.1...0.3.0
[0.2.1]: https://github.com/TheR4iner/obsidian-citation-graph/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/TheR4iner/obsidian-citation-graph/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/TheR4iner/obsidian-citation-graph/releases/tag/0.1.0
