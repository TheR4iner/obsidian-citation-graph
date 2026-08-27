# Contributing

Bug reports, feature ideas and pull requests are all welcome. This page covers how the repository is organised and what a change is expected to bring with it, so that a first pull request does not bounce on process.

## Reporting a bug

Open an issue with:

- What you did, what you expected, and what happened instead.
- Your Obsidian version and the plugin version from `manifest.json`.
- The relevant lines from `citation-graph.log`, which lives in the plugin's own directory inside your vault (`.obsidian/plugins/citation-graph/`).

The log records paper titles, note paths and error messages. It does not record API keys, but skim what you paste anyway, since paper titles and vault paths can be personal.

## Setting up

```bash
git clone https://github.com/TheR4iner/obsidian-citation-graph.git
cd obsidian-citation-graph
npm install
npm run build      # type-check, test, bundle
```

Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/citation-graph/` in a test vault, then reload Obsidian to try a build. `npm run dev` rebuilds on change; you still have to reload the plugin in Obsidian to pick up a new bundle.

Use a scratch vault rather than your real one. Several commands write literature notes, move files to trash and rewrite canvas JSON.

## Branches

- `main` holds released code only. Never open a pull request against it, and never push to it.
- `develop` is the integration branch. Every pull request targets `develop`.
- Work on a branch off `develop`, named for what it does: `feat/…`, `fix/…`, `docs/…`.

Releases are cut by promoting `develop` to `main` and tagging, which is a maintainer job.

## Before you open a pull request

Run the same three checks CI runs:

```bash
npx tsc -noEmit -skipLibCheck
npm test
node esbuild.config.mjs production
```

`npm run build` runs all three in that order, so it is the single command to remember.

Type errors are not negotiable, including ones you inherited from a file you happened to touch. Do not silence them with `any`, `as unknown as` or a blanket ignore; if a fix is genuinely larger than your change, say so in the pull request instead.

## What a change should bring with it

**Tests**, for anything that can be tested without Obsidian running. `obsidian` is a types-only dependency: `vitest.config.mts` aliases it at runtime to a stub in `test/`, while type-checking still uses the real declarations. That makes pure logic (parsing, layout, formatting, filtering, request building) cheap to test and UI code impractical to. Extract the pure part and test that.

**A README update**, whenever you add, remove or change a command or a setting. The README is the reference users actually read: check the Features list, the Commands table, the Settings tables, and Requirements if you added an external dependency.

**A changelog entry**, in the same pass, under `## [Unreleased]` in `CHANGELOG.md`, in whichever of `Added`, `Changed`, `Fixed`, `Removed` or `Deprecated` fits. Write what the plugin now does for a user, not which code changed: the reader has never seen your diff. Skip only refactors, tests and internal notes that no user could observe.

## Code conventions

**Match the file you are editing.** Indentation is not uniform across the codebase: some modules use tabs, others two spaces. Consistency within a file beats a repository-wide sweep, and a reformatting diff buries the change it ships with.

**Comments explain why, not what.** The existing comments are mostly there to record a decision or a trap (why a lookup is repeated, why a colour is deleted rather than blanked). Follow that: a comment restating the line below it is noise.

**Errors must be visible.** No fire-and-forget async calls and no silently swallowed exceptions. Report failures to the user through a notice, or to `citation-graph.log`, or both.

**Keep source-specific knowledge behind its interface.** The download path is the worked example: see *Adding a PDF download source* in the README.

## Repository layout

| Path | What lives there |
|---|---|
| `src/api/` | External services: Zotero, Semantic Scholar, OpenAlex, Crossref, arXiv, the LLM providers |
| `src/canvas/` | Canvas JSON: building, layout, status colours, the node context menu |
| `src/modals/` | Everything the user clicks: pickers, prompts, progress dialogs |
| `src/notes/` | Literature notes: frontmatter, body, summary placement |
| `project-kb/` | One markdown note per topic, accumulated over time rather than logged per session |
| `docs/images/` | README screenshots |

`project-kb/` is worth reading before starting on an area: a note there records the approaches already tried and why the current one won. If your change has a history worth preserving, add to the matching note or start one.

## Git hooks

`npm install` points `core.hooksPath` at `.githooks/`. In a plain clone those hooks are no-ops: they guard content that this repository does not contain. See `.githooks/README.md` if you are curious.

## License

By contributing you agree that your contribution is licensed under the MIT License, the same as the rest of the project.
