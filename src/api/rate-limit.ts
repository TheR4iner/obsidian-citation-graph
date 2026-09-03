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

  /** @param minInterval Minimum milliseconds between two calls. */
  constructor(private readonly minInterval: number) {}

  /** Run `fn` no sooner than `minInterval` after the previous call started. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      // `sleep` is a global supplied by Obsidian's runtime (obsidian.d.ts).
      await sleep(this.minInterval - elapsed);
    }
    this.lastRequestTime = Date.now();
    return fn();
  }
}
