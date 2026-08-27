import { requestUrl } from "obsidian";
import type { S2Paper } from "../types";

const BASE = "https://api.crossref.org";

/** Rate-limited CrossRef API client (references only, no public citation API) */
export class CrossRefClient {
  private lastRequestTime = 0;
  /** 200ms between requests */
  private readonly minInterval = 200;

  constructor(private email: string = "") {}

  /** Adopt a contact email entered after the client was created. */
  setEmail(email: string): void {
    this.email = email;
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
   * Get references (works cited BY this paper) from CrossRef metadata.
   * Only returns entries where the publisher deposited a DOI for the reference.
   */
  async getReferencesForDoi(doi: string): Promise<S2Paper[]> {
    const message = await this.fetchWork(doi);
    if (!message?.reference) return [];
    return message.reference
      .filter((ref: any) => ref.DOI)
      .map((ref: any) => mapCrossRefToS2Paper(ref));
  }

  /**
   * Get S2Paper-shaped metadata for a DOI from CrossRef.
   * Used as a last-resort fallback when neither S2 nor OpenAlex knows the paper.
   */
  async getMetadataForDoi(doi: string): Promise<S2Paper | null> {
    const message = await this.fetchWork(doi);
    if (!message) return null;
    return mapCrossRefWorkToS2Paper(message, doi);
  }

  private async fetchWork(doi: string): Promise<any | null> {
    return this.rateLimitedRequest(async () => {
      try {
        let url = `${BASE}/works/${encodeURIComponent(doi)}`;
        if (this.email) url += `?mailto=${encodeURIComponent(this.email)}`;
        const response = await requestUrl({ url });
        return response.json?.message || null;
      } catch {
        return null;
      }
    });
  }
}

/** Convert a CrossRef work record (top-level paper) to S2Paper format */
function mapCrossRefWorkToS2Paper(work: any, doi: string): S2Paper {
  const titleArr = work.title;
  const title = Array.isArray(titleArr) ? titleArr[0] : titleArr || "";

  const dateParts =
    work.issued?.["date-parts"]?.[0] ||
    work.published?.["date-parts"]?.[0] ||
    work["published-print"]?.["date-parts"]?.[0] ||
    work["published-online"]?.["date-parts"]?.[0];
  const year = dateParts && dateParts[0] ? parseInt(dateParts[0], 10) : null;

  const authors = Array.isArray(work.author)
    ? work.author.map((a: any) => ({
        name: [a.given, a.family].filter(Boolean).join(" ").trim() ||
          a.name ||
          "",
      })).filter((a: { name: string }) => a.name)
    : [];

  // CrossRef abstract is sometimes JATS XML; strip tags for plain text
  const rawAbstract: string | undefined = work.abstract;
  const abstract = rawAbstract
    ? rawAbstract.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null
    : null;

  return {
    paperId: `doi:${doi.toLowerCase()}`,
    externalIds: { DOI: doi },
    title: title || "",
    year: year && !isNaN(year) ? year : null,
    authors,
    abstract,
    citationCount: work["is-referenced-by-count"] ?? null,
  };
}

/** Convert a CrossRef reference entry to S2Paper format */
function mapCrossRefToS2Paper(ref: any): S2Paper {
  const doi = ref.DOI;
  // CrossRef reference entries have limited metadata
  const title =
    ref["article-title"] || ref["volume-title"] || ref.unstructured || "";
  const year = ref.year ? parseInt(ref.year, 10) : null;
  const author = ref.author
    ? [{ name: ref.author }]
    : [];

  return {
    paperId: `doi:${doi.toLowerCase()}`,
    externalIds: { DOI: doi },
    title,
    year: year && !isNaN(year) ? year : null,
    authors: author,
    abstract: null,
    citationCount: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
