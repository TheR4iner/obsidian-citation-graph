# Typing the untyped boundaries

## Overview

Obsidian's directory scan reported roughly seven hundred `@typescript-eslint/no-unsafe-*` warnings. They all trace to three places where a value enters the plugin as `any`, and from there `any` spreads through everything it touches.

- `requestUrl(...).json` and `JSON.parse` return `any`.
- `metadataCache.getFileCache(file)?.frontmatter` is `any`.
- The callback of `FileManager.processFrontMatter` receives `any`.

None of these is a defect in Obsidian: the values genuinely are unknown at those points. The defect is accepting `any` rather than `unknown` and narrowing.

## Current solution

`src/api/json.ts` holds narrowing helpers used by every API client: `pick` (a path walk), `asRecord`, `asString`, `asNumber`, `asArray`, `asRecordArray`, `asStringArray` and `parseJson`. They are forgiving about the container and strict about the value: a missing object reads as empty, but a number where a string was expected reads as null rather than being coerced.

This is not only a lint exercise. Before it, a shape change from Semantic Scholar, OpenAlex or an LLM provider crashed a command several frames from the response; now it produces a missing field, which every caller already handles.

For frontmatter:

- `paperFromFrontmatter(fm, fallbackId, notePath)` in `main.ts` is the single reader. It replaced **six** near-identical blocks that each built a `Paper` out of `fm.doi || fm.semantic_scholar_id || node.id` and friends, differing only in whether a missing title read as `""` or `"Untitled"`. They now all read `"Untitled"`.
- `frontmatterOf` on the plugin and in `literature.ts` returns `Record<string, unknown> | null`.
- `editFrontmatter(app, file, edit)` in `literature.ts` wraps `processFrontMatter` with the callback parameter typed. TypeScript accepts the narrower parameter, so this costs nothing and states the fact once.

Elsewhere, `localGet` in `zotero.ts` returns `Promise<unknown>` and each caller asserts the shape it expects. The assertion is a claim about Zotero's API that the function cannot check; making it visible at the call site is the point, and it is honest where a `Promise<any>` was not.

Result: 271 findings locally, then zero.

## Node types in the scanner

The 0.6.1 scan still reported about three hundred `no-unsafe-*` warnings, every one on a Node built-in: `fs`, `path`, `os`, `http`, `child_process`, `process`, `Buffer`. Obsidian's own API resolved fine there, so the scanner installs dev dependencies but does not load the ambient `@types/node` package (its TypeScript project evidently restricts `types`). Locally, `tsconfig.json` has no `types` field, so `@types/node` is loaded implicitly and lint is clean.

Reproduced by linting `src` against a copy of `tsconfig.json` with `"types": []`: same files, same rules, same counts as the scan. Fixed with `/// <reference types="node" />` at the top of each non-test file that uses Node (`llm.ts`, `zotero.ts`, `main.ts`, `download-picker.ts`, `paper-files.ts`, `types.ts`, `settings.ts`). A triple-slash reference loads the types whatever the project's `types` setting, and it states a true fact: these files run on Node. Under the reproduction this left zero `no-unsafe-*` and zero `prefer-promise-reject-errors`. A new file that uses Node needs the same line, or the warnings return.

## Open questions

- `test/fakes.ts` keeps three `as TFile` casts flagged by `obsidianmd/no-tfile-tfolder-cast`. A fake file cannot satisfy `instanceof TFile`, and the scanner ignores `test/` anyway.

## History

**2026-10-06 -- Node types reference.** The 0.6.1 scan's remaining unsafe-any warnings traced to `@types/node` not loading in the scanner; see "Node types in the scanner" above. This also settles the earlier open question: the 0.5.0 scan's warnings on Obsidian calls were the same kind of type-resolution gap, not code defects.

**2026-09-01 — introduced**, working through the community directory's first scan. See [[Community plugin submission]]. The frontmatter extraction was the largest single win, and the six duplicated blocks it removed were worth removing on their own account.
