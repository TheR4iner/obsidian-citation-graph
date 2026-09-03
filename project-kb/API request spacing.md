# API request spacing

## Overview

OpenAlex, CrossRef and arXiv ask only that requests be spread out. Each has its own interval (150 ms, 200 ms, 3 s), and each client used to carry its own copy of the same twelve lines. This note records the shared limiter and the concurrency bug that all three copies shared.

## Current solution

`src/api/rate-limit.ts` holds `RateLimiter`, constructed with a minimum interval and used as `limiter.run(fn)`. `ArxivMetadataClient`, `CrossRefClient` and `OpenAlexClient` each own one instance.

Semantic Scholar is deliberately not built on it. Its limiter also serializes calls and retries a 429 with backoff, which is a different mechanism rather than a longer interval, and folding the two together would make both harder to reason about.

## The bug the shared version fixes

The three original copies, and the first extraction of them, spaced calls with a bare timestamp:

```ts
const elapsed = Date.now() - this.lastRequestTime;
if (elapsed < this.minInterval) await sleep(this.minInterval - elapsed);
this.lastRequestTime = Date.now();
return fn();
```

Two callers arriving inside the interval both read the same `lastRequestTime`, both sleep the same amount, and both fire at the same instant. The limiter does nothing at all under exactly the load it exists for.

That is not hypothetical: `resolvePaperWithRefs` in `multi-source.ts` asks OpenAlex for references and citations through one client in a single `Promise.all`, and `fetchRefsAndCitations` does the same. Every expansion of a paper with a DOI hit the collapsed path.

The fix chains each caller behind the previous one's *slot claim*:

```ts
const claimed = this.slot.then(async () => { /* wait, then stamp */ });
this.slot = claimed;
return claimed.then(fn);
```

The distinction that matters: the queue advances when a slot is claimed, not when `fn` settles. Chaining on `fn` instead would serialize the requests end to end, so a slow OpenAlex response would delay the CrossRef call behind it and an expansion would take as long as the sum of its sources rather than the longest one.

## Open questions

- The interval is measured from call *start*. A source that objects to concurrent requests rather than to their rate would need the other chaining, on `fn`, and none of the three currently does.
- `sleep` is Obsidian's runtime global, not Node's. `test/setup.ts` installs it for vitest; without that the limiter throws a `ReferenceError` under test instead of behaving as it does in the app.

## History

### 2026-09-03

Added the two concurrency tests in `rate-limit.test.ts` and the slot chain. The first test fails against the timestamp-only version with the two calls released 0 ms apart instead of 100. The second pins the "slow call must not hold the queue" half, which is the mistake the obvious fix makes.

### 2026-09-01

Extracted during the over-engineering audit: three near-identical `rateLimitedRequest` methods and four copies of a local `sleep` helper collapsed into one class. The extraction was faithful, which means it carried the concurrency bug across unchanged.
