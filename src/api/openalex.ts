import { requestUrl } from "obsidian";
import type { S2Paper } from "../types";
import { asNumber, asRecord, asRecordArray, asString, asStringArray, pick } from "./json";

const BASE = "https://api.openalex.org";

/** Rate-limited OpenAlex API client */
export class OpenAlexClient {
  private lastRequestTime = 0;
  /** 150ms between requests (safely under 10 req/s limit) */
  private readonly minInterval = 150;

  constructor(private email: string = "") {}

  /** Adopt a contact email entered after the client was created. */
  setEmail(email: string): void {
    this.email = email;
  }

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
    const referenced = asStringArray(work?.referenced_works);
    if (referenced.length === 0) return [];

    // Step 2: fetch metadata for referenced works in batches
    return this.resolveOpenAlexIds(referenced);
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
    const workId = asString(work?.id);
    if (!workId) return [];

    // Use the cites filter: works whose referenced_works include this work
    const oaId = workId.replace("https://openalex.org/", "");
    return this.rateLimitedRequest(async () => {
      try {
        const url = this.buildUrl("/works", {
          filter: `cites:${oaId}`,
          per_page: "200",
          select: "id,doi,display_name,publication_year,authorships,cited_by_count,abstract_inverted_index",
        });
        const response = await requestUrl({ url });
        return asRecordArray(pick(response.json, "results"))
          .map(mapOpenAlexToS2Paper)
          .filter((paper) => paper.paperId !== "");
      } catch {
        return [];
      }
    });
  }

  /**
   * Every URL OpenAlex knows this DOI is hosted at.
   *
   * Used to find the arXiv preprint of a paper held under the DOI of its
   * published version. OpenAlex records each place a work appears, so the
   * arXiv copy shows up as a location even when Semantic Scholar files the
   * preprint and the journal article as two unrelated records.
   */
  async getLocationUrlsForDoi(doi: string): Promise<string[]> {
    return this.rateLimitedRequest(async () => {
      try {
        const url = this.buildUrl(`/works/https://doi.org/${encodeDoiPath(doi)}`, {
          select: "locations,best_oa_location",
        });
        const response = await requestUrl({ url });
        const work: unknown = response.json;
        const locations = [
          ...asRecordArray(pick(work, "locations")),
          ...asRecordArray([pick(work, "best_oa_location")]),
        ];
        const urls: string[] = [];
        for (const location of locations) {
          for (const key of ["landing_page_url", "pdf_url"]) {
            const value = asString(location[key]);
            if (value) urls.push(value);
          }
        }
        return urls;
      } catch {
        return [];
      }
    });
  }

  private async fetchWork(doi: string): Promise<Record<string, unknown> | null> {
    return this.rateLimitedRequest(async () => {
      try {
        const url = this.buildUrl(`/works/https://doi.org/${encodeDoiPath(doi)}`, {
          select: "id,doi,display_name,publication_year,authorships,cited_by_count,abstract_inverted_index,referenced_works",
        });
        const response = await requestUrl({ url });
        return asRecord(response.json);
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
          return asRecordArray(pick(response.json, "results"));
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
function mapOpenAlexToS2Paper(work: Record<string, unknown>): S2Paper {
  const doi = asString(work.doi)?.replace("https://doi.org/", "") ?? null;
  const oaId = asString(work.id)?.replace("https://openalex.org/", "") ?? null;

  return {
    paperId: doi ? `doi:${doi.toLowerCase()}` : oaId ? `openalex:${oaId}` : "",
    externalIds: doi ? { DOI: doi } : null,
    title: asString(work.display_name) ?? "",
    year: asNumber(work.publication_year),
    authors: asRecordArray(work.authorships).map((authorship) => ({
      name: asString(pick(authorship, "author", "display_name")) ?? "",
    })),
    abstract: reconstructAbstract(work.abstract_inverted_index),
    citationCount: asNumber(work.cited_by_count),
  };
}

/**
 * OpenAlex stores abstracts as inverted indexes: { "word": [pos1, pos2], ... }
 * Reconstruct into plain text.
 */
function reconstructAbstract(invertedIndex: unknown): string | null {
  const index = asRecord(invertedIndex);
  if (!index) return null;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      const at = asNumber(position);
      if (at !== null) words.push([at, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(" ") || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
