import type { Paper } from "../types";
import type { ArxivMetadataClient } from "./arxiv-metadata";
import type { OpenAlexClient } from "./openalex";
import { normalizeArxiv } from "./recommend";

/**
 * Find the arXiv ID of a paper that does not already carry one.
 *
 * A paper added by the DOI of its published version routinely has no arXiv ID
 * in its frontmatter: Semantic Scholar files the preprint and the journal
 * article as two unrelated records more often than not, so nothing along the
 * way ever learns the two are the same work. The preprint is still on arXiv,
 * and telling the user the paper has no source is simply wrong.
 *
 * Three routes, cheapest first. Each returns null rather than guessing, so a
 * paper genuinely absent from arXiv still comes back as unavailable.
 */

/** Pull the arXiv ID out of an arXiv-minted DOI (`10.48550/arXiv.2301.01234`). */
export function arxivIdFromDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  const match = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
  return match ? normalizeArxiv(match[1]) : null;
}

/** Pull the arXiv ID out of an abs/ or pdf/ URL, ignoring anything else. */
export function arxivIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i);
  return match ? normalizeArxiv(match[1]) : null;
}

/**
 * Whether two titles name the same paper.
 *
 * Compared on letters and digits alone: arXiv, OpenAlex and Zotero disagree
 * about capitalisation, hyphenation and trailing punctuation for the same
 * title often enough that an exact match would reject most real pairs. A
 * title-only match is the weakest evidence this module accepts, so it has to
 * be the whole title, not a prefix.
 */
export function titlesMatch(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const left = normalize(a);
  const right = normalize(b);
  return left !== "" && left === right;
}

export interface ArxivLookupClients {
  arxiv: ArxivMetadataClient;
  openalex: OpenAlexClient;
}

/**
 * Resolve a paper's arXiv ID, or null when arXiv does not have it.
 *
 * Order matters: the first two routes are exact, and the title search is a
 * guess that has to be confirmed against the returned title before it is
 * believed. The search also costs a rate-limited round trip, so it runs only
 * once the free routes have come up empty.
 */
export async function findArxivId(
  paper: Paper,
  clients: ArxivLookupClients
): Promise<string | null> {
  const known = normalizeArxiv(paper.arxiv);
  if (known) return known;

  const minted = arxivIdFromDoi(paper.doi);
  if (minted) return minted;

  if (paper.doi) {
    for (const url of await clients.openalex.getLocationUrlsForDoi(paper.doi)) {
      const fromUrl = arxivIdFromUrl(url);
      if (fromUrl) return fromUrl;
    }
  }

  if (paper.title) {
    const candidates = await clients.arxiv.searchByTitle(paper.title);
    for (const candidate of candidates) {
      if (!titlesMatch(candidate.title, paper.title)) continue;
      const id = normalizeArxiv(candidate.externalIds?.ArXiv);
      if (id) return id;
    }
  }

  return null;
}
