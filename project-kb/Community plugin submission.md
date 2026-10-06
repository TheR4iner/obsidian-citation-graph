# Community plugin submission

## Overview

What it takes to get Citation Graph into Obsidian's community directory, and which parts of this codebase the review objected to.

**Submission is no longer a pull request.** The `obsidianmd/obsidian-releases` repository has pull requests disabled; `community-plugins.json` is no longer edited by hand. Since 2026 the process is a form at [community.obsidian.md](https://community.obsidian.md): sign in with an Obsidian account, link the GitHub account that owns the repository, then **Plugins → New plugin** and give the repository URL and an owner. The directory reads `manifest.json` from the HEAD of the default branch and pulls files from the GitHub release whose tag matches its `version`.

Review is automatic and continuous, grouped into **Manifest**, **Releases**, **Source code** and **Build verification**, with results as Error, Warning, Recommendation or Pass. An entry can be published with warnings; **errors block installation from inside Obsidian**. Feedback is addressed by pushing a new release, not by editing a pull request.

## Run the review locally

The directory's checks are the [`eslint-plugin-obsidianmd`](https://github.com/obsidianmd/eslint-plugin) rules. `npm run lint` runs them here, with `eslint.config.mjs` in the repo. Treat `obsidianmd/*` errors as blocking.

The scanner runs the first of `build`, `build:plugin` or `compile` it finds in `package.json`, so `build` has to be the real production build. It ignores a fixed list of paths, which happens to cover everything here that should be ignored: `*.test.*`, `test/`, `docs/`, `esbuild.config.mjs`, `*.mjs`. `project-kb/` is **not** on that list and is scanned.

## Listing details, decided

- **Payment: Optional payment**, not Free. Their FAQ is explicit that relying on a third-party service which charges counts, and *Write summary* and *Recommend papers* call Anthropic, OpenAI or Google under the user's own account.
- `id` `citation-graph` and name `Citation Graph` are unused in the directory (there are "Citations", "Citation Callouts", "Simple Citations"). The `id` cannot be changed after publishing without resetting downloads.
- **No AI disclosure is required.** Neither the developer policies, the submission requirements, the plugin guidelines nor the submission form mentions AI, generated code or authorship. Checked 2026-09-01.

## What the review flagged, and what was done

- **`minAppVersion` was wrong and broke the plugin.** It claimed 1.4.0 while the settings tab extends `AbstractInputSuggest` (1.4.10), so on Obsidian 1.4.0 to 1.4.9 the module threw at import and nothing loaded, silently. `FileManager.trashFile` needs 1.6.6 and `DataAdapter` is documented since 1.7.2. Now 1.7.2, with `versions.json` corrected uniformly for every past release, which had the same defect.
- **Creating a `<style>` element is an outright error** (`obsidianmd/no-forbidden-elements`, no exceptions, `<link>` too). That was how reading status was drawn. Replaced with a static stylesheet keyed on a cssclass; see [[Reading status on canvas nodes]].
- **Mandatory README disclosures were missing.** The policies permit network use, access to files outside the vault, and reliance on a paid service *only if the README states them*. Added a section listing every host and what is sent to it, why PDFs live outside the vault, that the `claude` binary is the user's own and nothing is downloaded or installed, and which features cost money.
- Undocumented API through a cast: `(vault.adapter as any).basePath` replaced with `instanceof FileSystemAdapter` and `getBasePath()`. No `as any` remains in the plugin.
- Node `fs` for a vault-internal file: the log file goes through `DataAdapter`, like `S2RefCache` already did.
- `Vault.modify` on read-modify-write: everything uses `Vault.process`. See [[Atomic canvas writes]].
- A full-vault scan per paper in `findExistingNote`: indexed once per manager.
- Timers through `window.setTimeout`, a hardcoded `.obsidian` path removed, `builtin-modules` replaced with `node:module`'s own, control-character regexes annotated as deliberate.

## The first scan, 2026-09-01

The scan reported no errors. What it did report, and what was done:

**Behaviours** (declared on the listing, not defects):

- *Direct Filesystem Access* and *Shell Execution*: both unavoidable, both now confined to one module apiece and disclosed in the README. See [[Filesystem and process constraints]]. The environment allow-list for the Claude CLI was the one finding with a real leak behind it.
- *Vault Enumeration* (a Recommendation): kept, since neither the note index nor canvas discovery has a narrower API.
- *Vault Read* and *Vault Write*: pass.

**Source code**: about seven hundred `no-unsafe-*` warnings, all tracing to three `any` boundaries. Fixed to zero locally. See [[Typing the untyped boundaries]].

## The 0.6.2 scan, 2026-10-07

The unsafe-any warnings were gone (see [[Typing the untyped boundaries]]). What remained, and what was done:

- *Direct Filesystem Access*: removed by moving PDFs into the vault. See [[Filesystem and process constraints]].
- *Shell Execution*: kept. The Claude CLI provider is a deliberate feature; the README says why and how to avoid it.
- `prefer-setting-definitions`: done. The tab implements `getSettingDefinitions()` from one list of sections and rows; `minAppVersion` went to **1.13.0**, which also allowed `setWarning` to become `setDestructive`. A `display()` fallback was tried and dropped: the linter then flags `display` as deprecated, so keeping old-version support trades one warning for another. Obsidian keeps serving 0.6.2 to older apps through `versions.json`.
- CSS `!important` (7) and `:has` (9): kept by user decision. `:has` is the only way a status cssclass on the note reaches the canvas node frame, and `!important` overrides Obsidian's canvas styles. Redrawing inside the node content was offered and declined.

Gotcha found while testing: Obsidian 1.13+ calls `getSettingDefinitions()` inside `addSettingTab` to index search, so anything a row's description reads (here the reference cache size) must exist before `addSettingTab` runs. The plugin failed to load until `addSettingTab` moved after the cache load.

How to test in a real Obsidian without touching the user's: build, copy `main.js`/`manifest.json`/`styles.css` into a scratch vault's `.obsidian/plugins/citation-graph/`, write `community-plugins.json`, put an `obsidian.json` listing the vault (`open: true`) and a copy of the app asar into `$XDG_CONFIG_HOME/obsidian/`, then run `XDG_CONFIG_HOME=<scratch> xvfb-run -a obsidian --remote-debugging-port=9333` and evaluate JS over CDP against the `app://obsidian.md` page. The trust-author dialog has to be clicked once. Settings open in a separate window in 1.14, and `app.setting.openTab(tab)` with the tab object from `pluginTabs` is what switches tabs.

## Deliberately not done

- **Sentence case on proper nouns.** The linter wants "arxiv", "Pdfs", "Semantic scholar", "Openalex", "Sk-...". The submission requirements explicitly ask for correct capitalisation of acronyms, proper nouns and trademarks, so the requirement wins and those warnings stay.
- **`no-tfile-tfolder-cast` in `test/fakes.ts`.** The scanner ignores `test/`.
- **typescript-eslint's `no-unsafe-*` rules**, which fire on every read of Obsidian's `frontmatter` (typed `any` upstream). Generic type strictness, not an Obsidian rule; this is why `npm run lint` is not wired into CI.

## Verified clean

No telemetry, no ads, no self-install or dependency download, no obfuscation (the build is not even minified), no runtime dependencies to attribute, MIT recognised by GitHub, no sample code, no `console.log`, description within 250 characters and ending in a period, `isDesktopOnly` set, no plugin ID in any command ID, release carries `main.js`, `manifest.json` and `styles.css` under a tag matching the manifest.

## Open questions

- `manifest.json` says `author: "landaus"` while `authorUrl` points at `github.com/TheR4iner`. Harmless, but inconsistent.
- Two things a reviewer may still ask about, both disclosed and both gated behind `isDesktopOnly`: the plugin spawns a user-configured `claude` binary, and it reads and writes PDFs at arbitrary paths outside the vault.

## History

**2026-10-07 -- clearing the 0.6.2 scan.** Filesystem warning removed, settings search adopted with `minAppVersion` 1.13.0, CLI and CSS warnings kept by decision. Details in the section above.

**2026-09-01 — audit against the real rules.** The first pass worked from memory of the old pull-request process and found six issues. Fetching the current policies and running the official linter found four more that mattered, two of them serious: `minAppVersion` was wrong in a way that stopped the plugin loading, and the injected stylesheet was a hard error rather than the grey area it had been judged to be. Ended at zero `obsidianmd/*` errors.
