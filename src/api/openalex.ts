import { requestUrl } from "obsidian";
import type { S2Paper } from "../types";

const BASE = "https://api.openalex.org";

/** Rate-limited OpenAlex API client */
export class OpenAlexClient {
  private lastRequestTime = 0;
  /** 150ms between requests (safely under 10 req/s limit) */
  private readonly minInterval = 150;

  constructor(private email: string = "") {}

  private buildUrl(path: string, params: Record<string, string> = {}): string {
    if (this.email) params["mailto"] = this.email;
    const qs = new URLSearchParams(params).toString();
    return `${BASE}${path}${qs ? "?" + qs : ""}`;
  }

  private async rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await sleep(this.minInterval - elapsed);
    }
    this.lastRequestTime = Date.now();
    return fn();
  }

  /**
   * Get references (works cited BY this paper) for a DOI.
   * Returns S2Paper[] for compatibility with the existing pipeline.
   */
  async getReferencesForDoi(doi: string): Promise<S2Paper[]> {
    // Step 1: look up the work to get its referenced_works list
    const work = await this.fetchWork(doi);
    if (!work || !work.referenced_works?.length) return [];

    // Step 2: fetch metadata for referenced works in batches
    return this.resolveOpenAlexIds(work.referenced_works);
  }

  /**
   * Get S2Paper-shaped metadata for a DOI from OpenAlex.
   * Used as a fallback when Semantic Scholar doesn't know the paper.
   */
  async getMetadataForDoi(doi: string): Promise<S2Paper | null> {
    const work = await this.fetchWork(doi);
    if (!work) return null;
    const paper = mapOpenAlexToS2Paper(work);
    return paper.paperId ? paper : null;
  }

  /**
   * Get citations (works that cite this paper) for a DOI.
   * Returns S2Paper[] for compatibility.
   */
  async getCitationsForDoi(doi: string): Promise<S2Paper[]> {
    const work = await this.fetchWork(doi);
    if (!work?.id) return [];

    // Use the cites filter: works whose referenced_works include this work
    const oaId = work.id.replace("https://openalex.org/", "");
    return this.rateLimitedRequest(async () => {
      try {
        const url = this.buildUrl("/works", {
          filter: `cites:${oaId}`,
          per_page: "200",
          select: "id,doi,display_name,publication_year,authorships,cited_by_count,abstract_inverted_index",
        });
        const response = await requestUrl({ url });
        const results = response.json?.results || [];
        return results.map(mapOpenAlexToS2Paper).filter((p: S2Paper) => p.paperId);
      } catch {
        return [];
      }
    });
  }

  private async fetchWork(doi: string): Promise<any | null> {
    return this.rateLimitedRequest(async () => {
      try {
        const url = this.buildUrl(`/works/https://doi.org/${encodeDoiPath(doi)}`, {
          select: "id,doi,display_name,publication_year,authorships,cited_by_count,abstract_inverted_index,referenced_works",
        });
        const response = await requestUrl({ url });
        return response.json;
      } catch {
        return null;
      }
    });
  }

  /**
   * Resolve a list of OpenAlex work IDs to full metadata.
   * Uses the filter endpoint to batch-fetch up to 50 at a time.
   */
  private async resolveOpenAlexIds(oaIds: string[]): Promise<S2Paper[]> {
    const results: S2Paper[] = [];
    const batchSize = 50; // OpenAlex OR filter limit

    for (let i = 0; i < oaIds.length; i += batchSize) {
      const batch = oaIds.slice(i, i + batchSize);
      // Strip full URL prefix to get bare IDs
      const bareIds = batch.map((id) => id.replace("https://openalex.org/", ""));
      const filterValue = bareIds.join("|");

      const papers = await this.rateLimitedRequest(async () => {
        try {
          const url = this.buildUrl("/works", {
            filter: `openalex:${filterValue}`,
            per_page: String(batchSize),
            select: "id,doi,display_name,publication_year,authorships,cited_by_count,abstract_inverted_index",
          });
          const response = await requestUrl({ url });
          return response.json?.results || [];
        } catch {
          return [];
        }
      });

      for (const work of papers) {
        const paper = mapOpenAlexToS2Paper(work);
        if (paper.paperId) results.push(paper);
      }
    }

    return results;
  }
}

/**
 * Percent-encode a DOI for interpolation into a URL path.
 *
 * DOIs reach us from Zotero and from third-party APIs, so they are not
 * guaranteed to be path-safe: an unencoded "?" or "#" would restructure the
 * request, and "../" would retarget it at a different OpenAlex endpoint. "/"
 * stays literal because OpenAlex's `/works/https://doi.org/<doi>` form needs
 * it, so each segment is encoded separately and dot-segments are dropped.
 */
function encodeDoiPath(doi: string): string {
  return doi
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
}

/** Convert an OpenAlex work object to S2Paper format */
function mapOpenAlexToS2Paper(work: any): S2Paper {
  const doi = work.doi
    ? work.doi.replace("https://doi.org/", "")
    : null;
  const oaId = work.id
    ? work.id.replace("https://openalex.org/", "")
    : null;

  return {
    paperId: doi ? `doi:${doi.toLowerCase()}` : oaId ? `openalex:${oaId}` : "",
    externalIds: doi ? { DOI: doi } : null,
    title: work.display_name || "",
    year: work.publication_year || null,
    authors: (work.authorships || []).map((a: any) => ({
      name: a.author?.display_name || "",
    })),
    abstract: reconstructAbstract(work.abstract_inverted_index),
    citationCount: work.cited_by_count ?? null,
  };
}

/**
 * OpenAlex stores abstracts as inverted indexes: { "word": [pos1, pos2], ... }
 * Reconstruct into plain text.
 */
function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined
): string | null {
  if (!invertedIndex) return null;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map((w) => w[1]).join(" ") || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
