import { requestUrl } from "obsidian";
import type { S2Paper } from "../types";

const BASE = "https://export.arxiv.org/api/query";

/** Rate-limited arXiv metadata client (Atom API) */
export class ArxivMetadataClient {
  private lastRequestTime = 0;
  /** arXiv asks for >=3s between requests to be polite */
  private readonly minInterval = 3000;

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
   * Look up an arXiv ID (e.g. "1706.03762" or "1706.03762v5") and return
   * S2Paper-shaped metadata. Returns null if the ID isn't found.
   */
  async getMetadata(arxivId: string): Promise<S2Paper | null> {
    return this.rateLimitedRequest(async () => {
      try {
        const url = `${BASE}?id_list=${encodeURIComponent(arxivId)}`;
        const response = await requestUrl({ url });
        return parseArxivAtom(response.text, arxivId);
      } catch (e) {
        console.error(`Citation Graph: arXiv metadata fetch failed for "${arxivId}"`, e);
        return null;
      }
    });
  }
}

function parseArxivAtom(xml: string, requestedId: string): S2Paper | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const entry = doc.querySelector("entry");
  if (!entry) return null;

  // arXiv returns an empty <entry> with an error <title>Error</title> for
  // unknown IDs in some cases. Detect that and bail.
  const idEl = entry.querySelector("id");
  const idText = idEl?.textContent || "";
  if (idText.includes("api/errors") || !idText) return null;

  const title = (entry.querySelector("title")?.textContent || "").trim().replace(/\s+/g, " ");
  const summary = (entry.querySelector("summary")?.textContent || "").trim().replace(/\s+/g, " ");
  const published = entry.querySelector("published")?.textContent || "";
  const yearMatch = published.match(/^(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  const authors: Array<{ name: string }> = [];
  for (const authorEl of Array.from(entry.querySelectorAll("author > name"))) {
    const name = (authorEl.textContent || "").trim();
    if (name) authors.push({ name });
  }

  // Extract canonical arXiv ID (with version stripped) from the entry id URL
  // e.g. "http://arxiv.org/abs/1706.03762v7" → "1706.03762"
  const absMatch = idText.match(/arxiv\.org\/abs\/(.+?)(?:v\d+)?$/i);
  const canonicalArxiv = absMatch ? absMatch[1] : requestedId.replace(/v\d+$/i, "");

  // DOI: prefer arxiv:doi element if present, otherwise synthesize the arXiv-minted DOI
  let doi: string | null = null;
  for (const el of Array.from(entry.children)) {
    if (el.localName === "doi") {
      doi = (el.textContent || "").trim() || null;
      break;
    }
  }
  if (!doi) {
    doi = `10.48550/arXiv.${canonicalArxiv}`;
  }

  if (!title) return null;

  return {
    paperId: `arxiv:${canonicalArxiv}`,
    externalIds: {
      ArXiv: canonicalArxiv,
      DOI: doi,
    },
    title,
    year,
    authors,
    abstract: summary || null,
    citationCount: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
