# Semantic Scholar rate-limit feedback

## Overview

`SemanticScholarClient` serializes every call on one chain and retries a 429 with 5 s, 15 s and 45 s backoff before throwing `S2RateLimitError`. A lookup that hits the limit can therefore sit for over a minute and still succeed. Any command that does not show that wait looks dead, and a user who reruns it just queues a second request behind the first.

## Current solution

- The client exposes `onRateLimitWait(listener)`, which returns an unsubscribe function. Listeners live in a set, not a single slot, because two commands can share the request chain and the one that finishes first must not unhook the other's listener.
- `onload` registers a permanent listener that writes each wait to `citation-graph.log` via `logOnly`, so the log shows why a command stalled.
- `withS2Progress(progress, fn)` in `main.ts` shows the wait as the hint on a command's `ProgressNotice` for the duration of `fn`. Used by add-by-DOI, expand paper (uncached fetch), resolve missing edges, and recommendation verification.
- `src/api/semantic-scholar.test.ts` pins the overlapping-listener case.

## Open questions

- When S2 exhausts its retries, `resolvePaperWithRefs` throws instead of falling back to OpenAlex/arXiv/CrossRef for metadata. Falling back would add the paper without S2 edges instead of failing after a minute.
- A 429 happened with an API key configured; unclear whether that was the key's own 1 req/s allowance or S2-side throttling.

## History

### 2026-09-24

Report: adding `10.1103/PhysRevA.108.062413` to a canvas "failed silently". The log showed `Looking up ARXIV:2209.14278...` at 12:11:27 and `Looking up DOI:...` at 12:11:47 (the same paper), then nothing until the paper was added at 12:12:35, about 65 s later, which matches the full retry schedule. The paper was added; only the feedback was missing, since add-by-DOI used a transient "Looking up" notice and only the recommend command had wired the rate-limit hint. Replaced the single `onRateLimitWait` callback slot with a listener set and added the progress notice to the three silent commands.
