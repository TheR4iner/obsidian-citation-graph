# Test runner

## Overview

**Status: implemented.** vitest is wired up, `npm test` runs 115 assertions across four files, and `npm run build` gates on them. What follows records the design and the reasoning; *How it is wired up* describes what is actually in the repo.

Before this, the project had **no test runner**. `package.json` has only `dev` and `build`; `build` is `tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`, which type-checks but asserts nothing about behaviour.

That gap matters more than it looks. A good share of the codebase is pure logic with no Obsidian dependency at all — frontmatter parsing, status derivation, colour validation, node-ID construction, scaffold detection. These are exactly the functions that break silently: they keep type-checking while returning the wrong answer, and the failure only surfaces as a paper rendering wrongly on somebody's canvas three steps later. Every one of them is trivially testable in isolation.

The work was to set up **vitest** and port an existing, already-validated body of assertions into the repo.

## Why nothing was committed before

The reading-list feature (PR #9) was verified with ~74 assertions across four throwaway harnesses written to a scratchpad directory, bundled with esbuild and run under plain node. They all passed, and they caught real defects — but they were never committed, because adding a test framework mid-feature was out of scope and the harnesses are gone with the scratchpad.

The assertion **inventory** survived in this note and has now been ported. Deciding what to test was the expensive part; re-deriving each assertion from its name was not.

## The one real obstacle: the `obsidian` module

`obsidian` is a devDependency that ships **types only**. At runtime the real implementation is injected by the Obsidian app, so any module importing from `"obsidian"` will fail with `Cannot find module 'obsidian'` when run under node. `esbuild.config.mjs` already treats it as external for exactly this reason.

Two consequences for the test setup:

1. Test runs need an alias mapping `obsidian` to a stub. The throwaway harnesses used `--alias:obsidian=./obsidian-stub.js` with a three-line stub, and that was sufficient for everything tested:

   ```js
   export class App {}
   export class TFile {}
   export const normalizePath = (p) => p;
   ```

   Under vitest this is a `resolve.alias` entry in `vitest.config.mts`. Crucially the alias is **not** mirrored into `tsconfig.json`: `tsc` keeps checking `src/` against the real Obsidian declarations, so the stub only has to satisfy runtime references (`extends`, `instanceof`, calls) and never becomes the thing the code is type-checked against.

2. Anything needing `App` behaviour (`metadataCache`, `vault`, `fileManager`) is faked with a plain object literal, not a mock library. `LiteratureNoteManager` takes `App` in its constructor, so a hand-rolled fake is enough:

   ```ts
   const makeApp = (note: { fm: Record<string, unknown>; body: string }) => ({
     metadataCache: { getFileCache: () => ({ frontmatter: note.fm }) },
     vault: { cachedRead: async () => note.body, getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
     fileManager: {
       processFrontMatter: async (_f: unknown, cb: (fm: Record<string, unknown>) => void) => cb(note.fm),
     },
   });
   ```

   Note this fake makes `processFrontMatter` mutate `note.fm` synchronously, so assertions can read the written frontmatter straight back off the object. That is what makes the `setStatus` tests readable.

## How it is wired up

- `vitest.config.mts` at the repo root. `.mts` rather than `.ts` because the package is CommonJS and Vite's native config loader warns about ESM syntax in a `.ts` config; the extension sidesteps it, at the cost of `__dirname` (use `fileURLToPath(new URL(..., import.meta.url))`).
- `test/obsidian-stub.ts` — the three-export stub, unchanged from the plan.
- `test/fakes.ts` — `makeVault()` / `makeNote()` build the fake `App`. A single `as unknown as App` cast lives here and nowhere else, so tests elsewhere see the real `App` type and a misspelled method still fails to compile.
- Tests sit next to their subjects as `src/**/*.test.ts`: `src/types.test.ts`, `src/notes/literature.test.ts`, `src/notes/summary-text.test.ts`, `src/canvas/layout.test.ts`.
- `tsconfig.json` now includes `test/**/*.ts` so the stub and fakes are type-checked too. Test files were already covered by `src/**/*.ts`.
- Scripts: `npm test` (`vitest run`), `npm run test:watch`, and `build` is now `tsc -noEmit -skipLibCheck && vitest run && node esbuild.config.mjs production`. This settles the open question below in the affirmative: a failing test blocks the bundle, and since `release.yml` runs `npm run build`, it blocks a release too.
- `.github/workflows/ci.yml` runs type-check, tests and the bundle on pushes to `main`/`develop` and on every PR, with actions pinned to SHAs to match `release.yml`.
- `esbuild` was bumped `^0.20.0` → `^0.28.2` while setting this up. 0.20 carries GHSA-67mh-4wv8-2f99 (any website can make its dev server serve responses to a cross-origin request); this project never starts that server, so it was never exploitable here, but `npm audit` is clean now and stays a usable signal. `esbuild.config.mjs` uses only `context`/`rebuild`/`watch`, none of which changed across the bump, and the bundle came out 2KB smaller.
- `main.js` grew 229,913 → 230,071 bytes under esbuild 0.20, all of it the refactor below; then dropped to 228,025 with esbuild 0.28. `grep` confirms no vitest or `describe(` in the bundle. esbuild builds from `src/main.ts` only, so test files are never reachable.

## Refactors the tests required

Three pure helpers were unreachable from a test because they lived in `src/main.ts`, whose module graph pulls in every modal and API client. Importing that under a stub would have forced the stub to grow `Plugin`, `Modal`, `FuzzySuggestModal` and more — exactly the fat stub the plan warns against. They were extracted instead:

- `insertSummaryText` / `hasSummarySection` → new `src/notes/summary-text.ts`. `estimatePdfPages` stayed behind, since it needs `fs`.
- `readFrontmatterArxiv` → exported from `src/notes/literature.ts`.
- The inline status-cycle expression in `cycleReadingStatus` → `nextStatusInCycle()` in `src/types.ts`.

All three are re-imported by `main.ts`; behaviour is unchanged apart from the bug fix below.

## What the first run found

Two things, both from tests that failed on their first execution:

1. **A real off-by-one in `insertSummaryText` mode `append`.** It emitted `"\n" + noteContent.substring(nextHeading)` where `nextHeading` points *at* a newline, so every append inserted a stray blank line before the following heading. The `replace` branch beside it already did `nextHeading + 1`. Fixed, and the two branches now agree.

2. **An undocumented design decision in `bodyHasUserContent`.** A note whose `## Notes` heading has been *renamed* (say to `## Reading log`) counts as annotated immediately, before anything is written under it — only the exact generated heading is treated as scaffold. The plan's inventory listed "`## Notes` replaced by a custom heading" and "custom heading with content" as two separate assertions, which is the tell: they pin this deliberately.

   **Decided (2026-08-21): keep the behaviour.** Editing the scaffold is itself engagement with the paper, and the alternative is a heuristic guessing which of the user's headings are "really" theirs. It now says so in the `bodyHasUserContent` docstring rather than only in the test, and `literature.test.ts` pins it so a refactor has to argue with the comment instead of changing it quietly.

## What to test, and the assertions to port

Ported names are grouped by subject. Each was a real passing assertion; the name states the expected behaviour.

### `bodyHasUserContent` in `src/notes/literature.ts`

Decides whether a paper counts as **read + notes written**. The subtlest logic in the codebase, and the most valuable to test: it must not anchor on the `## Notes` heading, because users rename or delete it.

- untouched generated note
- no DOI/arXiv lines (blank slots)
- content under `## Notes`
- `## Notes` replaced by a custom heading
- custom heading with content
- an LLM-written `## Summary` counts
- `## Notes` deleted entirely, nothing written
- checkbox list only
- blockquote only
- note with no frontmatter at all
- CRLF line endings, untouched
- CRLF line endings, with notes
- title heading only, no metadata
- a second `#` heading counts as content
- whitespace-only additions
- frontmatter containing `---` inside a value

### Status parsing and derivation (`src/types.ts`, `src/notes/literature.ts`)

- parses a valid status
- is case/space tolerant
- rejects `annotated` (derived, never stored)
- rejects junk, a boolean, undefined
- legacy `read: true` reads as read; `read: false` reads as unread; missing frontmatter reads as unread
- `status` wins over legacy `read`
- `setStatus` writes status and drops legacy `read`
- no per-status class is written (status now comes from the node colour — see *Reading status rendering*)
- stale `citation-graph-status-*` class stripped, user class kept
- adopted note gains the marker class
- string `cssclasses` normalized and preserved
- `syncNoteClass` is a no-op when already clean; rewrites a note carrying a stale class; leaves only the marker
- read + empty note stays read
- read + notes becomes annotated
- unread + notes also becomes annotated
- **abandoned + notes stays abandoned**
- cycle order: unread → reading → read → unread, and abandoned re-enters at unread

### Colour parsing (`src/types.ts`)

`parseStatusColor` is a security boundary as much as a correctness one: its output is written into `.canvas` files, so an invalid value corrupts user data.

- preset passes through; empty means no colour
- full hex accepted; uppercase normalized; surrounding space trimmed
- 3-digit and 8-digit hex rejected; missing hash rejected; non-hex letters rejected
- partial typing rejected (matters — the settings field validates on every keystroke)
- out-of-range preset rejected
- **CSS injection rejected** (`"red; --x:1"`)
- number and null rejected
- `isCustomColor` for hex / preset / empty
- `statusColor` returns hex, returns none for unread, and falls back to none for a corrupt stored value

### `isPaperNote` in `src/notes/literature.ts`

Guards every write the plugin makes to a note. A regression here caused the plugin to stamp a user's own note with a status it could not change, and would have wiped a colour they set by hand.

- plugin-created note (null id fields present)
- adopted note with a real DOI / only an arXiv id / only a citekey
- the user's own note (no id fields)
- a note with unrelated frontmatter
- a note with no frontmatter at all
- a note titled like a paper but with no ids

### Covered here for the first time

These three had never been tested before this note was implemented:

- `paperNodeId` / `resolvePaperNodeId` / `hasPaperNode` in `src/canvas/layout.ts`, including the legacy-ID fallback that stops `expandCanvas` duplicating a whole canvas.
- `insertSummaryText`, since moved to `src/notes/summary-text.ts`, for its three modes (`new`, `append`, `replace`), especially `replace` when `## Summary` is the last section.
- `readFrontmatterArxiv` — it exists because YAML parses a bare arXiv ID like `2108.07909` as a float.

## Not worth testing this way

Rendering. The reading-list appearance depends on Obsidian's canvas DOM and on CSS features (`@property`, `@container style()`, `:has()`), none of which a node-based runner can exercise. That was verified by serving a replica of the real canvas DOM plus the shipped `styles.css` on localhost and reading `getComputedStyle` through a browser. If this needs to be repeatable, it is a Playwright job, not a vitest one — and probably not worth it until the CSS stops changing.

Anything hitting Semantic Scholar, OpenAlex, Crossref or Zotero. Test the pure transforms around them instead.

## Open questions

- ~~Should `npm run build` depend on `npm test`?~~ Yes; done. Reversible by dropping `vitest run` from the `build` script if the coupling ever gets in the way locally.
- Coverage thresholds: probably not worth enforcing while most of the codebase is Obsidian-coupled and untestable without a browser.
- Nothing covers `layoutPapers` / `layoutNewPapers` positioning yet, only the node IDs. The column-shifting logic in `layoutNewPapers` is the kind of arithmetic that breaks quietly.

## History

**2026-08-21** — This note became public. `project-kb/` is tracked by design so contributors get the same context; only `project-kb/private/` stays gitignored.

**2026-08-21** — Bumped esbuild to 0.28 to clear the dev-server advisory, and settled the renamed-heading question in favour of keeping the behaviour (now documented in the `bodyHasUserContent` docstring).

**2026-08-21** — Implemented. vitest wired up per the plan; 115 assertions across four files, all passing. Extracted three pure helpers out of `main.ts` to make them reachable (see *Refactors the tests required*). Fixed an off-by-one in `insertSummaryText` append mode that the tests caught on their first run. Added `.github/workflows/ci.yml`; `npm run build` now gates on the suite.

**2026-08-21** — Note created. No runner exists yet; this records the assertion inventory from PR #9's throwaway harnesses before it is lost, along with the `obsidian`-module aliasing problem that any setup has to solve first.
