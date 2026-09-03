/**
 * Spacing between requests to one API.
 *
 * Three of the citation sources ask only that calls be spread out, with no
 * retry or queueing beyond that, and each carries its own idea of how far
 * apart. Keeping the arithmetic in one place is what stops those three copies
 * from drifting: an off-by-one in a duplicated version shows up as a source
 * that intermittently 429s, months later and only under load.
 *
 * Semantic Scholar is deliberately not built on this. Its limiter also
 * serializes calls and retries a 429 with backoff, which is a different
 * mechanism rather than a longer interval.
 */
export class RateLimiter {
  private lastRequestTime = 0;
  /**
   * Resolves once the previous caller has claimed its slot.
   *
   * Without it, two callers arriving inside the interval both read the same
   * `lastRequestTime`, both sleep the same amount and both fire at the same
   * instant, which is precisely what the limiter exists to prevent. That is
   * not hypothetical here: `resolvePaperWithRefs` asks OpenAlex for references
   * and citations through one client in a single `Promise.all`.
   */
  private slot: Promise<void> = Promise.resolve();

  /** @param minInterval Minimum milliseconds between two calls. */
  constructor(private readonly minInterval: number) {}

  /** Run `fn` no sooner than `minInterval` after the previous call started. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    // The queue advances when a slot is claimed, not when `fn` settles, so
    // calls start `minInterval` apart but are still in flight together. A slow
    // request must not hold up the next one.
    const claimed = this.slot.then(async () => {
      const elapsed = Date.now() - this.lastRequestTime;
      // `sleep` is a global supplied by Obsidian's runtime (obsidian.d.ts).
      if (elapsed < this.minInterval) await sleep(this.minInterval - elapsed);
      this.lastRequestTime = Date.now();
    });
    this.slot = claimed;
    return claimed.then(fn);
  }
}
