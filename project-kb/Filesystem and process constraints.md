# Filesystem and process constraints

## Overview

The plugin reaches outside Obsidian in exactly two ways, and Obsidian's directory scan flags both as behaviours worth declaring: **Direct Filesystem Access** and **Shell Execution**. Neither can be removed, because PDFs are not notes and the Claude CLI is a program. Both are confined to one module apiece so the answer to "what can this reach?" is enforced rather than described.

A third, **Vault Enumeration**, is a Recommendation rather than a Warning and is left as is; see below.

## Current solution

### Filesystem: `src/paper-files.ts`

Every path outside the vault is built here. Four functions, all pure and unit-tested:

- `expandTilde` and `resolveFolder` turn what the user typed into an absolute path. Nothing downstream accepts a relative one, which would otherwise resolve against Obsidian's working directory rather than anywhere the user meant.
- `fileInFolder(folder, name)` places a filename directly inside a folder and **throws** if the result is not a direct child. A separator, a `..`, or an absolute root is refused rather than stripped: a caller passing one has a bug, and silently writing to a different file is the worse outcome.
- `assertInsideFolders(target, folders)` is the last gate before a read. `summarizePapersWithPdfs` in `main.ts` holds the list (the canvas's download folder and the `defaultDownloadPath` setting) and checks each PDF against it before opening.

The reason all of this exists: paper titles, author names and arXiv IDs arrive from remote services and end up in filenames. `sanitizeFilename` is necessary but is the kind of thing that quietly stops being sufficient; asserting containment afterwards is what actually holds.

`isInside` uses `path.relative` rather than a string prefix, because `/srv/papers-private` starts with `/srv/papers` and is a different folder. There is a test for that.

### Process: the Claude CLI section of `src/api/llm.ts`

The only program the plugin runs. Three constraints, all tested:

- **`shell: false`** with an argument array. The arguments carry a prompt and a paper title, both arbitrary remote text; passed this way they are inert.
- **`isUsableCliPath`** gates the configured path: an absolute path, or the bare name `claude`. A relative path, another bare name, or anything carrying a shell operator or control character is refused, and an absolute path must name a file that exists. `resolveClaudeCliPath` **throws** rather than falling back, because quietly running a different binary than the settings name is the surprise the whole section exists to avoid.
- **`cliEnvironment()`** builds the child's environment from an allow-list instead of inheriting. This is the one with real teeth: without it the CLI received every secret exported into the shell Obsidian was launched from, including the user's Zotero and OpenAI keys, which have nothing to do with it.

`windowsHide: true` is set as well, to avoid a console flash on Windows.

## Vault Enumeration, deliberately kept

`vault.getMarkdownFiles()` builds the identifier index in `LiteratureNoteManager`; `vault.getFiles()` finds other canvases in *Send papers to canvas* and in the banned-papers manager. Neither has a narrower API: finding a note by a DOI in its frontmatter is a search, not a lookup, and Obsidian offers no "all canvases" call. Scoping the note search to the collections folder would change documented behaviour (a literature note is matched anywhere in the vault). Left alone, and disclosed in the README.

## Open questions

- `assertInsideFolders` is enforced on the summary path, which is where a PDF is read and shipped to a third party. The download path builds every destination through `fileInFolder` instead, which is containment by construction rather than a check. Both are sound; they are not the same mechanism, and a reader could reasonably expect one.
- The environment allow-list is a guess at what the CLI needs across three platforms. Too narrow and the CLI stops finding its config; there is no test that can catch that, only a user reporting it.

## History

**2026-09-01 — introduced**, after the community directory's scan flagged Direct Filesystem Access and Shell Execution as behaviours. Both were already narrow in practice; what changed is that the narrowness is now enforced in one place per behaviour, tested, and written down in the README where a reviewer and a user can both find it. See [[Community plugin submission]].

The environment allow-list was the only finding with a concrete leak behind it rather than a shape objection.
