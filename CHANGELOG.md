# Changelog

All notable changes to Citation Graph are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version here is also the body of the matching [GitHub release](https://github.com/TheR4iner/obsidian-citation-graph/releases).

## [Unreleased]

### Changed

- The default model for the Anthropic API and the Claude CLI is now `claude-sonnet-5`.
- Clearing the **Collections folder** setting now keeps collection directories at the top of the vault instead of snapping back to `collections`. Leading and trailing slashes are stripped, so `/` and an empty value mean the same thing.

### Fixed

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

[Unreleased]: https://github.com/TheR4iner/obsidian-citation-graph/compare/0.1.0...HEAD
[0.1.0]: https://github.com/TheR4iner/obsidian-citation-graph/releases/tag/0.1.0
