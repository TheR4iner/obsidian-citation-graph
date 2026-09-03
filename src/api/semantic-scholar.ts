import { requestUrl, Notice } from "obsidian";
import type { S2Paper } from "../types";
import { asString, pick } from "./json";

const BASE = "https://api.semanticscholar.org/graph/v1";

/**
 * How long to wait after each rejected request before trying again. Semantic
 * Scholar throttles a shared pool for unauthenticated traffic, so a 429 often
 * means somebody else is busy rather than that this client misbehaved: waiting
 * and retrying usually succeeds, where giving up loses the paper entirely.
 */
const RETRY_DELAYS_MS = [5000, 15000, 45000];

/** Thrown when Semantic Scholar is still refusing after every retry. */
export class S2RateLimitError extends Error {
  constructor(context: string) {
    super(
      `Semantic Scholar rate limit hit while ${context}. Wait a minute and try again, ` +
      "or add a Semantic Scholar API key in the plugin settings."
    );
    this.name = "S2RateLimitError";
  }
}

/** The HTTP status behind a failed requestUrl call, if it carried one. */
function statusOf(e: unknown): number | undefined {
  const err = e as { status?: number; response?: { status?: number } };
  return err?.status ?? err?.response?.status;
}

/** Rate-limited Semantic Scholar API client */
export class SemanticScholarClient {
  /**
   * Tail of the in-flight request chain. Every call queues behind it, so two
   * commands running at once cannot both decide the interval has elapsed and
   * fire together.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestTime = 0;

  /**
   * Called before each backoff wait, so a long-running command can tell the
   * user why it has stalled instead of appearing to hang.
   */
  onRateLimitWait: ((seconds: number, context: string) => void) | null = null;

  constructor(private apiKey: string = "") {}

  /**
   * Adopt a key entered after the client was created.
   *
   * The client is long-lived so its rate-limit spacing survives across
   * commands, which means a key added in settings would otherwise not take
   * effect until Obsidian restarted -- and the user would keep hitting the
   * unauthenticated limit they had just paid to escape.
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Minimum ms between requests. An API key buys a private 1 req/s allowance;
   * without one, requests share a pool that permits roughly 100 per 5 minutes.
   */
  private get minInterval(): number {
    return this.apiKey ? 1100 : 3000;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  /**
   * Execute a request serialized against every other call on this client,
   * spaced by minInterval, retrying a 429 with backoff.
   *
   * Throws S2RateLimitError once the retries are exhausted. That is deliberate:
   * returning null there would be indistinguishable from "no such paper", and
   * callers act on that difference.
   */
  private rateLimitedRequest<T>(fn: () => Promise<T>, context: string): Promise<T> {
    const run = this.chain.then(() => this.attemptWithRetries(fn, context));
    // Keep the chain alive after a failure, or every later call inherits it.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async attemptWithRetries<T>(fn: () => Promise<T>, context: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.minInterval - (Date.now() - this.lastRequestTime);
      if (wait > 0) await sleep(wait);
      this.lastRequestTime = Date.now();

      try {
        return await fn();
      } catch (e) {
        if (statusOf(e) !== 429) throw e;
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.warn(`Citation Graph: S2 rate limit not cleared while ${context}`);
          throw new S2RateLimitError(context);
        }
        const delay = RETRY_DELAYS_MS[attempt];
        console.warn(
          `Citation Graph: S2 rate limited while ${context}; retrying in ${delay / 1000}s`
        );
        this.onRateLimitWait?.(delay / 1000, context);
        await sleep(delay);
      }
    }
  }

  /** Resolve a DOI or arXiv ID to a Semantic Scholar paper with basic fields */
  async getPaper(externalId: string): Promise<S2Paper | null> {
    return this.rateLimitedRequest(async () => {
      try {
        const url = `${BASE}/paper/${encodeURIComponent(externalId)}?fields=paperId,externalIds,title,year,authors,abstract,citationCount`;
        const response = await requestUrl({
          url,
          headers: this.getHeaders(),
        });
        const data: unknown = response.json;
        if (!asString(pick(data, "paperId"))) return null;
        return data as S2Paper;
      } catch (e) {
        // Hand a rate limit back to the retry layer; anything else is this
        // paper's problem alone and should not fail the whole command.
        if (statusOf(e) === 429) throw e;
        console.error(`Citation Graph: S2 getPaper failed for "${externalId}"`, e);
        return null;
      }
    }, `looking up ${externalId}`);
  }

  /**
   * Batch resolve multiple paper IDs at once.
   * S2 batch endpoint accepts up to 500 IDs.
   * Set `includeRefs` to true to also fetch each paper's reference list
   * (as `paperId`s only), so callers can build the citation edge graph
   * without a follow-up round of per-paper requests.
   */
  async getPaperBatch(
    ids: string[],
    onProgress?: (done: number, total: number) => void,
    includeRefs = false
  ): Promise<Map<string, S2Paper>> {
    const result = new Map<string, S2Paper>();
    const batchSize = 500;

    const fields = [
      "paperId",
      "externalIds",
      "title",
      "year",
      "authors",
      "abstract",
      "citationCount",
    ];
    if (includeRefs) fields.push("references.paperId");

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      // Unlike the single-paper methods, a rate limit here is swallowed rather
      // than thrown: the remaining batches may still succeed, and the caller
      // reports how many papers it managed to resolve.
      let papers: (S2Paper | null)[] = [];
      try {
        papers = await this.rateLimitedRequest(async () => {
          const response = await requestUrl({
            url: `${BASE}/paper/batch?fields=${fields.join(",")}`,
            method: "POST",
            headers: {
              ...this.getHeaders(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ids: batch }),
          });
          return response.json as (S2Paper | null)[];
        }, `resolving ${batch.length} papers`);
      } catch (e) {
        if (e instanceof S2RateLimitError) {
          new Notice(
            "Semantic Scholar rate limit hit; some papers could not be resolved. " +
            "Wait a minute and run the command again."
          );
        } else {
          console.error("Citation Graph: S2 batch request failed", e);
        }
      }

      for (let j = 0; j < papers.length; j++) {
        const paper = papers[j];
        if (paper && paper.paperId) {
          result.set(paper.paperId, paper);
          // Also index by DOI and arXiv for easy lookup
          if (paper.externalIds?.DOI) {
            result.set(paper.externalIds.DOI.toLowerCase(), paper);
          }
          if (paper.externalIds?.ArXiv) {
            result.set(paper.externalIds.ArXiv, paper);
          }
        }
      }

      if (onProgress) onProgress(Math.min(i + batchSize, ids.length), ids.length);
    }

    return result;
  }

  /**
   * Build citation edges from an already-fetched batch (papers carry their
   * references via `getPaperBatch(..., includeRefs=true)`). No additional
   * network calls are made. Only edges where both endpoints are in the
   * provided paper set are returned.
   */
  static buildCitationEdgesFromBatch(
    papers: Map<string, S2Paper>
  ): Array<{ fromId: string; toId: string }> {
    const edges: Array<{ fromId: string; toId: string }> = [];
    const knownIds = new Set<string>();
    for (const paper of papers.values()) knownIds.add(paper.paperId);

    const seen = new Set<S2Paper>();
    for (const paper of papers.values()) {
      if (seen.has(paper)) continue;
      seen.add(paper);
      if (!paper.references) continue;
      for (const ref of paper.references) {
        if (ref?.paperId && knownIds.has(ref.paperId)) {
          edges.push({ fromId: paper.paperId, toId: ref.paperId });
        }
      }
    }
    return edges;
  }

  /**
   * Find the paper whose title best matches `title`.
   *
   * This is the last resort for a suggestion that arrived without a DOI or
   * arXiv ID. S2 answers 404 when nothing matches closely enough, which is a
   * normal outcome here rather than an error: callers treat null as "no such
   * paper" and drop the suggestion.
   */
  async matchTitle(title: string): Promise<S2Paper | null> {
    const query = title.trim();
    if (!query) return null;
    return this.rateLimitedRequest(async () => {
      try {
        const fields = "paperId,externalIds,title,year,authors,abstract,citationCount";
        const url =
          `${BASE}/paper/search/match?query=${encodeURIComponent(query)}&fields=${fields}`;
        const response = await requestUrl({ url, headers: this.getHeaders() });
        const match = pick(response.json, "data", "0");
        if (!asString(pick(match, "paperId"))) return null;
        return match as S2Paper;
      } catch (e) {
        if (statusOf(e) === 429) throw e;
        if (statusOf(e) === 404) return null;
        console.error(`Citation Graph: S2 title match failed for "${query}"`, e);
        return null;
      }
    }, `searching for "${query.slice(0, 60)}"`);
  }

  /**
   * Get a paper with its references and citations (for Expand mode).
   * Returns full metadata for related papers.
   */
  async getPaperWithRefs(externalId: string): Promise<S2Paper | null> {
    return this.rateLimitedRequest(async () => {
      try {
        const fields = [
          "paperId",
          "externalIds",
          "title",
          "year",
          "authors",
          "abstract",
          "citationCount",
          "references.paperId",
          "references.externalIds",
          "references.title",
          "references.year",
          "references.authors",
          "references.abstract",
          "references.citationCount",
          "citations.paperId",
          "citations.externalIds",
          "citations.title",
          "citations.year",
          "citations.authors",
          "citations.abstract",
          "citations.citationCount",
        ].join(",");

        const response = await requestUrl({
          url: `${BASE}/paper/${encodeURIComponent(externalId)}?fields=${fields}`,
          headers: this.getHeaders(),
        });
        const data: unknown = response.json;
        if (!asString(pick(data, "paperId"))) return null;
        return data as S2Paper;
      } catch (e) {
        if (statusOf(e) === 429) throw e;
        console.error(`Citation Graph: S2 getPaperWithRefs failed for "${externalId}"`, e);
        return null;
      }
    }, `fetching references for ${externalId}`);
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
