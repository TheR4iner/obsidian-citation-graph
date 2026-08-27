# LLM paper recommendations

## Overview

**Status: implemented.** The *Recommend papers* command describes the current canvas to the configured LLM, asks which further papers belong on it, verifies every suggestion against the citation sources, and offers the survivors in the same checkbox picker *Expand paper* uses.

It reuses the summarization provider settings (provider, key, model, CLI path) rather than introducing a second LLM configuration, and adds only what is specific to recommending: how many papers to ask for, whether to search the web, an output-token cap, and a standing prompt.

## Design decisions

### Verification is mandatory, and it is the whole point

A model will produce a plausible title, plausible authors and a plausible DOI for a paper that does not exist. Two failure modes matter here and both are handled in `verifyRecommendations` (`src/api/recommend.ts`):

- **The paper does not exist.** No source can resolve the identifier and no title match comes back. Dropped, counted, and logged.
- **The identifier belongs to a different paper.** This is the dangerous one: the DOI resolves, so a naive implementation puts a real but unrelated paper on the canvas under the suggested title. The resolved title is therefore compared against the suggested title, and on a mismatch the suggestion is re-searched by title before being dropped.

Both drops are reported as counts in a notice and by title in `citation-graph.log`. The user asked for silent dropping over showing unverified rows: the picker only ever contains papers that can actually become nodes.

Title comparison is `titleSimilarity`: token-set overlap over the smaller set, after lowercasing, stripping punctuation and dropping stopwords, with a 0.7 threshold. The asymmetry is deliberate, so a dropped subtitle does not sink a genuine match.

### Web search is per-provider, not universal

The plugin talks to raw provider endpoints, so search had to be wired per provider:

- **Anthropic**: the `web_search` server tool. Model families from Opus 4.6 / Sonnet 4.6 onward take `web_search_20260209`; anything else gets `web_search_20250305`, since the model name is a free-text setting and an unknown name must not fail the request.
- **Google**: `google_search` for 2.x and later, `google_search_retrieval` for 1.5 models. Sending the wrong one is a 400.
- **Claude CLI**: `--allowedTools WebSearch,WebFetch`. In print mode an unlisted tool is auto-denied rather than prompted for, so without the flag the CLI silently answers from training data.
- **OpenAI**: the chat/completions endpoint has no search tool. `providerSupportsWebSearch()` returns false and the prompt modal says so, rather than the plugin pretending it searched.

Enabling search brought two latent bugs in the summary path into scope, both now fixed in `src/api/llm.ts`: the Anthropic reader took `content[0].text`, which is wrong as soon as a response carries tool-use blocks, and the Gemini reader took `parts[0].text`, which truncates a grounded answer at its first citation boundary. Both now concatenate every text block. Anthropic's `pause_turn` is also handled, by handing the partial assistant turn back up to four times: a truncated reply is not merely short here, it is unparseable JSON.

### JSON by prompt, not by structured output

Every provider is asked for JSON in the prompt text and parsed leniently, rather than using Anthropic's `output_config.format` or Gemini's `responseMimeType`. Structured output and server-side tools do not combine cleanly on either provider, and the Claude CLI has neither. One tolerant parser (`parseRecommendations`) that copes with code fences, surrounding prose and a `{"recommendations": [...]}` wrapper is simpler than three provider-specific paths.

### The prompt is in three parts

Instructions, then the canvas listing, then the JSON contract. Only the first is user-replaceable, by the *Recommendation prompt* setting or the prompt box at invocation (the box wins for that run). The listing and the contract are always appended by the plugin, so a custom prompt can change what is asked for without breaking how the answer is read.

### Abstracts are opt-in per run

The canvas is described by title, authors, year and identifiers. Abstracts are a checkbox in the prompt modal, off by default and not remembered, with the cost stated inline (roughly 250 extra input tokens per paper). On a large canvas they dominate the prompt and tend to pull the model toward whatever the longest abstracts discuss. They are not in frontmatter, so ticking the box costs one extra Semantic Scholar batch request.

### Edges come free

Verification already fetches each paper's references and citations through `resolvePaperWithRefs`, so edges to the rest of the canvas, and among the accepted papers, cost no extra requests.

### Progress reporting, and why only the CLI streams

A recommendation run takes minutes; a static notice is indistinguishable from a hang. `ProgressNotice` (`src/progress-notice.ts`) keeps a notice up with a running clock and a replaceable status line.

Only the Claude CLI can say what it is doing. It is invoked with `--output-format stream-json --verbose` and `spawn` rather than `execFile`, and its line-delimited events are decoded by `describeCliEvent`: `system/thinking_tokens` becomes "Thinking (N tokens)", an `assistant` message carrying a `tool_use` block becomes "Searching the web: <query>", and a text block becomes "Writing the answer". The final text now comes from the `result` event rather than raw stdout, and the event shapes were captured from a real run rather than recalled. Moving to `spawn` also dropped `execFile`'s 1 MB output cap, which a long summary could have hit.

The three HTTP providers go through Obsidian's `requestUrl`, which returns a response whole. Streaming them would mean `fetch` from the renderer, which needs per-provider CORS opt-ins, so they get the clock and nothing more.

### Rate limits are retried, and never reported as a missing paper

The Semantic Scholar client used to catch a 429, show a notice and return null. Two things were wrong with that: null is also how "no such paper" is reported, so a throttled suggestion was discarded as invented; and the throttle was never waited out, so a single busy minute could empty a whole run.

It now serializes every call through a promise chain (the previous `lastRequestTime` check let concurrent callers all decide the interval had elapsed and fire together), spaces requests by 3 seconds without an API key and 1.1 with one, and retries a 429 after 5, 15 and 45 seconds. Only when those are exhausted does it throw `S2RateLimitError`, which `verifyRecommendations` catches to stop cleanly and return the remaining suggestions as `unchecked`.

The other half of the same problem was that the key never reached the client. All three API clients are built once in `onload` so their spacing survives across commands, which meant a key typed into settings did nothing until Obsidian restarted, and the user kept hitting the unauthenticated limit they had just escaped. `applyApiCredentials()` now pushes the resolved key and contact email into the live clients from `saveSettings()`.

`getPaperBatch` is the deliberate exception: it swallows the error and carries on, because the later batches may still succeed and its callers already report how many papers they resolved.

## Refactors this required

- `llm.ts` grew a single `callLlm(request, settings)` entry point taking an optional PDF, an optional web-search flag, and per-call token and timeout overrides. `summarizePaper` is now a thin wrapper over it. Without this, recommending would have meant a second copy of all four provider calls.
- `expand-picker.ts` was split: everything shared (search box, year range, count, ban buttons, list rendering, result plumbing) moved to `PaperPickerModal` in `src/modals/paper-picker.ts`, with hooks for per-row decoration and extra filters. `ExpandPickerModal` keeps its cited/citing filter; `RecommendPickerModal` shows the model's justification in the same slot.
- `main.ts` had three copies of "read every canvas node's frontmatter back into a `Paper`" and two of the citation-edge matcher. They are now `canvasPapers`, `indexPapers`, `canvasPaperIds` and `buildCitationEdges`, used by *Expand paper*, *Add paper by DOI* and *Recommend papers* alike.
- `log.ts` gained `logOnly()`, for detail that belongs in the log but not in a notice: the raw reply when parsing fails, and the title of every discarded suggestion.

## Open questions

- **The Claude CLI inherits Obsidian's working directory.** It therefore picks up whatever `CLAUDE.md`, hooks and settings live there, which adds latency and can steer the answer. Passing a neutral `cwd` would isolate it, but that changes the existing summary path too, so it is left alone for now.
- **Prompt injection through paper metadata.** Titles and abstracts from remote sources go into the prompt verbatim. A hostile abstract could ask the model to recommend a particular paper. The blast radius is small (the paper still has to exist, and the user still picks from a list), so nothing guards it today.
- Recommendations are not cached. Running the command twice pays the model twice, and there is no record of what was suggested last time beyond the ban list.
- The ban list is shared with *Expand paper*. Banning a recommendation stops it being suggested again, but there is no way to review or unban from within the recommendation flow.
- Verification is serial by necessity (Semantic Scholar's free tier is roughly one request every three seconds), so ten suggestions take around half a minute. A user with an S2 API key could go faster; the client does not currently vary its interval by key.

## History

**2026-08-27** — Review pass before the PR: the API clients now adopt a key or contact email entered after load (a Semantic Scholar key was doing nothing until restart), a reply cut off at the token cap says so instead of reporting no recommendations, the suggestion count is capped at 50, and the CLI's stderr retention is bounded.

**2026-08-27** — Added live progress and rate-limit handling. The Claude CLI now streams its activity through `spawn` + `stream-json`; every provider gets an elapsed clock; Semantic Scholar retries a 429 with backoff and reports unchecked suggestions instead of discarding them. Verified the CLI stream end to end against the real binary, not just in tests.

**2026-08-27** — Fixed the Claude CLI invocation: `--allowedTools` is variadic and swallowed the prompt, leaving the CLI waiting on stdin. A `--` separator ends the flags.

**2026-08-27** — Implemented. Command, prompt modal, picker, verification, settings, README, and 68 new assertions across `src/api/recommend.test.ts` (parsing, identifier normalization, title matching, prompt assembly) and `src/api/verify-recommendations.test.ts` (the hallucination guards, driven by a fake Semantic Scholar client rather than a mocked module).
