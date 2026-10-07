# Citation Graph

Turn your literature into a citation graph on an Obsidian canvas: papers as nodes, citations as arrows, laid out on a timeline by year.

![Six paper nodes on a canvas, each with a coloured border and a reading-status label, connected by citation arrows.](https://raw.githubusercontent.com/TheR4iner/obsidian-citation-graph/main/docs/images/canvas-nodes.png)

## Features

- **Build a canvas** from a Zotero collection or tag, or add papers one at a time by DOI or arXiv ID. Each paper gets a literature note.
- **Grow it** with any paper's references and citing works, filtered by year and keyword and sorted by citation count.
- **Track your reading**: every paper shows its status (to read, reading, read, abandoned) as a coloured border.
- **Download PDFs** from arXiv into a vault folder.
- **Summarize papers** with an LLM, written straight into the note.
- **Get recommendations**: an LLM suggests papers that belong on the canvas, and each one is checked against a citation database before you see it.

Desktop only. Requires Obsidian 1.13.0 or later.

## Quick start

1. Install **Citation Graph** from Settings, Community plugins, and enable it.
2. Start Zotero and enable its local API: Edit, Settings, Advanced, tick *Allow other applications on this computer to communicate with Zotero*. ([Better BibTeX](https://retorque.re/zotero-better-bibtex/) is recommended for citekeys.)
3. Run **Citation Graph: Canvas: create from collection** from the command palette and pick a collection.
4. Select a paper and run **Papers: expand paper** to add its references and citing works.
5. Put **Reading: cycle reading status** on a hotkey to mark papers as you read them.

Every per-paper command is also on the right-click menu of a canvas node. No Zotero? Start from any canvas with **Papers: add by DOI or arXiv**.

## Optional setup

| To use | You need |
|---|---|
| Faster citation lookups | A free [Semantic Scholar API key](https://www.semanticscholar.org/product/api#api-key-form). Without one, a large collection takes minutes |
| Summaries and recommendations | A provider under Settings, Summaries (see below) |
| PDF downloads | A vault folder under *Default download folder*, or pick one when downloading |
| Syncing back to Zotero | A Zotero API key and user ID from [zotero.org/settings/keys](https://www.zotero.org/settings/keys) |

**LLM providers.**

- **Claude CLI** (default) uses your Claude subscription instead of an API key. Install Claude Code and sign in once by running `claude` in a terminal. The plugin finds it in `~/.local/bin` or on your PATH; otherwise set *Claude CLI path*.
- **Anthropic, OpenAI or Google Gemini API**: paste your API key. These bill you per call.

**Keeping PDFs out of git or Sync.** PDFs are stored in your vault. Add the download folder to your `.gitignore`, or to *Excluded folders* in Obsidian Sync's settings.

## Commands

| Command | What it does |
|---|---|
| Canvas: create from collection / from tag | Builds a canvas from Zotero |
| Canvas: resolve missing citation edges | Draws arrows still missing between papers on the canvas |
| Canvas: relayout | Re-sorts nodes by year |
| Canvas: sync to Zotero | Pushes the canvas's papers to a Zotero collection |
| Canvas: send papers to another canvas | Copies or moves papers with their arrows |
| Papers: expand paper | Adds a paper's references and citing works |
| Papers: add by DOI or arXiv | Adds one paper |
| Papers: recommend papers | Asks the LLM for papers that fit the canvas |
| Papers: delete paper | Deletes the node, its arrows and its note |
| Reading: set / cycle / refresh reading status | Sets or repaints reading status |
| PDFs: download | Fetches PDFs from arXiv |
| PDFs: write summary | Writes an LLM summary into the note |
| Maintenance: clear Semantic Scholar cache | Drops cached citation data |

## Privacy and costs

- **No telemetry.** Each service is contacted only by the command that needs it: the Zotero app on your computer, Semantic Scholar, OpenAlex, Crossref and arXiv for paper data, zotero.org for sync, and your chosen LLM provider for summaries and recommendations.
- **Vault only.** The plugin reads and writes files only inside your vault.
- **One local program.** With the Claude CLI provider, the plugin runs your installed `claude` binary, only for summaries and recommendations, without a shell, and with only the tools the request needs. Choose an API provider and no program is ever run.
- **Costs.** The plugin is free. Summaries and recommendations bill your LLM account or Claude subscription; everything else works without one.

## More

- [Full guide](https://github.com/TheR4iner/obsidian-citation-graph/blob/main/docs/guide.md): every command, setting and behaviour, exactly what is sent to each service, limitations, and development.
- [Changelog](https://github.com/TheR4iner/obsidian-citation-graph/blob/main/CHANGELOG.md) · [Contributing](https://github.com/TheR4iner/obsidian-citation-graph/blob/main/CONTRIBUTING.md) · License: MIT
