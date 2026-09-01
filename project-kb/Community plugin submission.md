# Community plugin submission

## Overview

What it takes to get Citation Graph into Obsidian's community plugin list, and which parts of this codebase the reviewers were likely to object to.

The submission itself is one pull request against [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases): fork it, add one entry to `community-plugins.json` (`id`, `name`, `author`, `description`, `repo: "TheR4iner/obsidian-citation-graph"`), and fill in their checklist template. A bot comments within minutes with hard failures; a human review follows weeks later.

## Mechanics, verified 2026-09-01

- `id` `citation-graph` and name `Citation Graph` are both unused in the official list (there are "Citations", "Citation Callouts", "Simple Citations").
- Release `0.3.0` carries `main.js`, `manifest.json` and `styles.css` as assets, and the tag is `0.3.0` with no `v` prefix, matching the manifest version. Both are required.
- `versions.json` and `manifest.json` agree; `main.js` is gitignored, so the repository holds no build output.
- MIT `LICENSE` present.

## Current solution

Fixed ahead of submission, in the order a reviewer would have hit them:

- **Undocumented API through a cast.** `(vault.adapter as any).basePath` was used in three places. Absolute paths now come from `absolutePluginDir()` in `main.ts`, which goes through `instanceof FileSystemAdapter` and `getBasePath()`, and returns null rather than building a broken path. Only the download helpers need an absolute path at all, because they hand it to code running outside Obsidian; everything else uses the vault-relative `pluginDir` getter.
- **Node `fs` for a vault-internal file.** The log file is written through `DataAdapter` (`append`/`stat`/`rename`/`exists`/`remove`), mirroring what `S2RefCache` already did. Appends are chained on a promise so two log calls in one tick cannot lose a line, and a write failure reaches the console instead of an empty callback.
- **`Vault.modify` on read-modify-write.** Every canvas and note write goes through `Vault.process`, which re-reads under the write lock. See [[Atomic canvas writes]].
- **Dynamic stylesheet.** Still injected, because the colour-to-status mapping is user configuration and cannot be static, but it now assigns custom properties only. See [[Reading status on canvas nodes]].
- **Full-vault scan per paper.** `LiteratureNoteManager.findExistingNote` indexes the vault once per manager instead of walking `getMarkdownFiles()` twice for every paper.
- **`as any` elsewhere.** The canvas view is reached through a documented `CanvasViewInternals` interface rather than `as any`. Obsidian exposes no public canvas API, so the access itself is unavoidable; what changed is that the assumption is now typed and commented.

Added `authorUrl` to the manifest. `fundingUrl` is deliberately absent.

## Open questions

- `manifest.json` says `author: "landaus"` while `authorUrl` points at `github.com/TheR4iner`. Harmless, but inconsistent if anyone looks.
- Two things a reviewer may still ask about, both disclosed in the README and both gated behind `isDesktopOnly`: the plugin spawns a user-configured `claude` binary via `child_process`, and it reads and writes PDFs at arbitrary paths outside the vault.
- `minAppVersion` is 1.4.0. `Vault.getFileByPath` (1.5.7) would replace ~25 `getAbstractFileByPath` + `instanceof TFile` pairs, but is not worth a floor bump on its own.

## History

**2026-09-01 — pre-submission audit and cleanup.** Audited the repository against the community plugin requirements, found the six items above, and fixed all of them. Build stayed green throughout (250 tests).
