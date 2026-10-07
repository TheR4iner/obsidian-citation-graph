import { requestUrl } from "obsidian";
import type { S2Paper } from "../types";
import { asNumber, asRecord, asRecordArray, asString, pick } from "./json";
import { RateLimiter } from "./rate-limit";

const BASE = "https://api.crossref.org";

/** One entry of a paper's reference list. */
export interface CrossRefReference {
  /** The cited work, when the entry names a DOI. */
  paper: S2Paper | null;
  /** The entry's deposited title and citation text, for matching by title. */
  text: string;
}

/** The cited works that have a DOI, in bibliography order. */
export function papersIn(references: CrossRefReference[]): S2Paper[] {
  return references.flatMap((ref) => (ref.paper ? [ref.paper] : []));
}

/**
 * A DOI written into a free-text citation, typically inside a publisher URL
 * such as `https://link.springer.com/article/10.1007/...`.
 */
function doiInText(text: string | null): string | null {
  const match = text?.match(/\b10\.\d{4,9}\/[^\s?#]+/);
  return match ? match[0].replace(/[.,;)\]]+$/, "") : null;
}

/** Rate-limited CrossRef API client (references only, no public citation API) */
export class CrossRefClient {
  /** 200ms between requests */
  private readonly limiter = new RateLimiter(200);

  constructor(private email: string = "") {}

  /** Adopt a contact email entered after the client was created. */
  setEmail(email: string): void {
    this.email = email;
  }

  /**
   * The paper's reference list as the publisher deposited it, in bibliography
   * order, including the entries that carry no DOI.
   */
  async getReferenceList(doi: string): Promise<CrossRefReference[]> {
    const message = await this.fetchWork(doi);
    if (!message) return [];
    return asRecordArray(message.reference).map((ref) => {
      const refDoi = asString(ref.DOI) ?? doiInText(asString(ref.unstructured));
      return {
        paper: refDoi ? mapCrossRefToS2Paper(ref, refDoi) : null,
        text: [ref["article-title"], ref["volume-title"], ref.unstructured]
          .map(asString)
          .filter((part): part is string => part !== null)
          .join(" "),
      };
    });
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

  private async fetchWork(doi: string): Promise<Record<string, unknown> | null> {
    return this.limiter.run(async () => {
      try {
        let url = `${BASE}/works/${encodeURIComponent(doi)}`;
        if (this.email) url += `?mailto=${encodeURIComponent(this.email)}`;
        const response = await requestUrl({ url });
        return asRecord(pick(response.json, "message"));
      } catch {
        return null;
      }
    });
  }
}

/**
 * The first year CrossRef gives for a work.
 *
 * The date lives under whichever of four keys the publisher deposited, each
 * holding `date-parts: [[year, month, day]]`, so all four are tried in the
 * order that puts the publication date ahead of the online-first one.
 */
function crossRefYear(work: Record<string, unknown>): number | null {
  for (const key of ["issued", "published", "published-print", "published-online"]) {
    const year = asNumber(pick(work, key, "date-parts", "0", "0"));
    if (year !== null) return year;
  }
  return null;
}

/** Convert a CrossRef work record (top-level paper) to S2Paper format */
function mapCrossRefWorkToS2Paper(work: Record<string, unknown>, doi: string): S2Paper {
  // CrossRef gives a title as a list, one entry per title variant.
  const title =
    asString(pick(work, "title", "0")) ?? asString(work.title) ?? "";

  const authors = asRecordArray(work.author)
    .map((author) => ({
      name:
        [asString(author.given), asString(author.family)]
          .filter((part): part is string => part !== null)
          .join(" ")
          .trim() ||
        asString(author.name) ||
        "",
    }))
    .filter((author) => author.name !== "");

  // CrossRef abstracts are sometimes JATS XML; strip tags for plain text.
  const rawAbstract = asString(work.abstract);
  const abstract = rawAbstract
    ? rawAbstract.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null
    : null;

  return {
    paperId: `doi:${doi.toLowerCase()}`,
    externalIds: { DOI: doi },
    title,
    year: crossRefYear(work),
    authors,
    abstract,
    citationCount: asNumber(work["is-referenced-by-count"]),
  };
}

/** Convert a CrossRef reference entry to S2Paper format */
function mapCrossRefToS2Paper(ref: Record<string, unknown>, doi: string): S2Paper {
  // CrossRef reference entries have limited metadata
  const title =
    asString(ref["article-title"]) ??
    asString(ref["volume-title"]) ??
    asString(ref.unstructured) ??
    "";
  const author = asString(ref.author);

  return {
    paperId: `doi:${doi.toLowerCase()}`,
    externalIds: { DOI: doi },
    title,
    year: asNumber(ref.year),
    authors: author ? [{ name: author }] : [],
    abstract: null,
    citationCount: null,
  };
}
