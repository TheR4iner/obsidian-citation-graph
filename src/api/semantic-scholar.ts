import { requestUrl, Notice } from "obsidian";
import type { S2Paper } from "../types";

const BASE = "https://api.semanticscholar.org/graph/v1";

/** Rate-limited Semantic Scholar API client */
export class SemanticScholarClient {
  private requestQueue: Array<() => Promise<void>> = [];
  private processing = false;
  private lastRequestTime = 0;
  /** Minimum ms between requests (free tier: 100 req/5min ≈ 1 per 3s) */
  private readonly minInterval = 3000;

  constructor(private apiKey: string = "") {}

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  /** Execute a request with rate limiting */
  private async rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await sleep(this.minInterval - elapsed);
    }
    this.lastRequestTime = Date.now();
    return fn();
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
        const data = response.json;
        if (!data?.paperId) return null;
        return data as S2Paper;
      } catch (e: any) {
        const status = e?.status || e?.response?.status;
        if (status === 429) {
          console.warn(`Citation Graph: S2 rate limited for "${externalId}"`);
          new Notice("Semantic Scholar rate limit hit. Please wait a moment and try again.");
        } else {
          console.error(`Citation Graph: S2 getPaper failed for "${externalId}"`, e);
        }
        return null;
      }
    });
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
      const papers = await this.rateLimitedRequest(async () => {
        try {
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
        } catch (e: any) {
          const status = e?.status || e?.response?.status;
          if (status === 429) {
            console.warn("Citation Graph: S2 rate limited during batch request");
            new Notice("Semantic Scholar rate limit hit. Please wait a moment and try again.");
          } else {
            console.error("Citation Graph: S2 batch request failed", e);
          }
          return [] as (S2Paper | null)[];
        }
      });

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
        const data = response.json;
        if (!data?.paperId) return null;
        return data as S2Paper;
      } catch (e: any) {
        const status = e?.status || e?.response?.status;
        if (status === 429) {
          console.warn(`Citation Graph: S2 rate limited for "${externalId}"`);
          new Notice("Semantic Scholar rate limit hit. Please wait a moment and try again.");
        } else {
          console.error(`Citation Graph: S2 getPaperWithRefs failed for "${externalId}"`, e);
        }
        return null;
      }
    });
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
