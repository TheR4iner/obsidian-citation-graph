# Filesystem and process constraints

## Overview

Obsidian's directory scan flags two behaviours as Warnings: **Direct Filesystem Access** (any import of Node's `fs`) and **Shell Execution** (any use of `child_process`). Since 2026-10-07 the plugin carries only the second. PDFs moved into the vault, so nothing imports `fs`; the Claude CLI provider is kept on purpose, which keeps the Shell Execution flag.

A third, **Vault Enumeration**, is a Recommendation rather than a Warning and is left as is; see below.

## Current solution

### Files: vault only, through the adapter

PDFs live in a vault folder (the canvas's `lastDownloadPath`, or the `defaultDownloadPath` setting), read and written through `FileSystemAdapter` (`stat`, `mkdir`, `writeBinary`, `readBinary`, `rename`, `exists`) with vault-relative paths. `src/paper-files.ts` holds the path logic, all pure and unit-tested:

- `vaultFolder(raw, vaultBasePath)` turns what the user typed into a vault-relative folder. A relative path is read against the vault root; `..` is refused. An absolute or `~` path, which settings and canvases from 0.6.x and earlier carry, is converted when it lies inside the vault and refused with a migration message when it does not. `isInside` (via `path.relative`, not a string prefix, so `research-old` is not inside `research`) decides that.
- `fileInFolder(folder, name)` refuses a name carrying a separator, `.`, `..` or nothing, so a remote-sourced title can never place a file anywhere but directly in the folder. Containment is now by construction; the old `assertInsideFolders` read-time check went away because every path is built here from a validated folder, and inside the vault there is nothing the plugin could not read anyway.
- `estimatePdfPages(bytes)` counts `/Type /Page` markers; the caller skips files over 64 MB using `adapter.stat` before reading.

The arXiv download still uses Node's `https` (not flagged): redirects are followed by hand so only `arxiv.org` and `cloudfront.net` are trusted, which `requestUrl` cannot do since it follows redirects itself. The body is collected in memory (cap 200 MB), checked for `%PDF-`, and written with `writeBinary`.

A download fallback (see [[Download sources]]) runs outside Obsidian, so it gets `adapter.getFullPath(folder)` and returns an absolute path; `moveIntoPlace` in `download-picker.ts` requires that path to be directly inside the folder before renaming it through the adapter.

The LLM layer takes a `PdfAttachment` (`name`, `fullPath`, lazy `size()` and `read()`): the HTTP providers read bytes and base64 them with Obsidian's `arrayBufferToBase64`; the Claude CLI gets `fullPath` and reads the file itself.

Users who do not want PDFs in git or Sync are told to `.gitignore` the folder or add it to Sync's excluded folders: in the setting's description, the README, and the changelog.

### Process: the Claude CLI section of `src/api/llm.ts`

The only program the plugin runs, kept deliberately (user decision, 2026-10-07): it bills to the user's Claude subscription instead of an API key, and it is the only provider that streams progress. It is also the default provider, but nothing runs until *Write summary* or *Recommend papers* is invoked. The README states the choice and that picking an API provider means no program is ever started.

- **`shell: false`** with an argument array. The arguments carry a prompt and a paper title, both arbitrary remote text; passed this way they are inert.
- **`isUsableCliPath`** gates the configured path: an absolute path, or the bare name `claude`. A relative path, another bare name, or anything carrying a shell operator or control character is refused. `resolveClaudeCliPath` **throws** rather than falling back. The old existence check (`fs.statSync`) is gone with `fs`; spawn's ENOENT is reported with the path it tried.
- **`cliSearchPath`** builds the child's PATH as `~/.local/bin` first, then the inherited PATH. spawn resolves the command through `options.env.PATH`, so this finds the official installer's binary first, which the old code did by probing the file.
- **`cliEnvironment()`** builds the child's environment from an allow-list instead of inheriting. Without it the CLI received every secret exported into the shell Obsidian was launched from.

`windowsHide: true` is set as well, to avoid a console flash on Windows.

## Vault Enumeration, deliberately kept

`vault.getMarkdownFiles()` builds the identifier index in `LiteratureNoteManager`; `vault.getFiles()` finds other canvases in *Send papers to canvas* and in the banned-papers manager. Neither has a narrower API: finding a note by a DOI in its frontmatter is a search, not a lookup, and Obsidian offers no "all canvases" call. Scoping the note search to the collections folder would change documented behaviour (a literature note is matched anywhere in the vault). Left alone, and disclosed in the README.

## Open questions

- A user with many PDFs in an outside folder has to move them by hand; there is no migration command. Add one if anyone asks.
- The environment allow-list is a guess at what the CLI needs across three platforms. Too narrow and the CLI stops finding its config; there is no test that can catch that, only a user reporting it.

## History

**2026-10-07 -- PDFs into the vault; `fs` removed.** To clear the Direct Filesystem Access warning, the download folder became a vault folder and every file operation moved to the vault adapter. Old absolute folders inside the vault are converted, outside ones refused with instructions. The Claude CLI was kept (Shell Execution stays), and its `~/.local/bin` probe became a PATH entry so `llm.ts` needs no `fs` either. Verified in an isolated Obsidian 1.14.4 (separate `XDG_CONFIG_HOME`, `xvfb-run`, driven over `--remote-debugging-port`): real arXiv download into `Papers/PDFs`, picker marks it downloaded, *Write summary* with a fake CLI script received the PDF's absolute path. That harness is worth reusing; see [[Community plugin submission]].

**2026-09-01 — introduced**, after the community directory's scan flagged Direct Filesystem Access and Shell Execution as behaviours. Both were already narrow in practice; what changed is that the narrowness is now enforced in one place per behaviour, tested, and written down in the README where a reviewer and a user can both find it. See [[Community plugin submission]].

The environment allow-list was the only finding with a concrete leak behind it rather than a shape objection.
