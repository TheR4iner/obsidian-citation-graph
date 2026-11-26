import type { S2Paper } from "../types";

export interface PaperLink {
  label: string;
  url: string;
}

/**
 * Where a reader can look a paper up: its arXiv abstract page when it has
 * one, else its DOI's publisher page, else the record of the source that
 * found it. The fallback sources encode their identifier in `paperId`
 * ("doi:", "arxiv:", "openalex:"); anything else is a Semantic Scholar ID.
 */
export function paperLink(paper: S2Paper): PaperLink | null {
  const id = paper.paperId ?? "";
  const arxiv = paper.externalIds?.ArXiv ?? (id.startsWith("arxiv:") ? id.slice(6) : null);
  if (arxiv) return { label: "arXiv", url: `https://arxiv.org/abs/${encodeURI(arxiv)}` };

  const doi = paper.externalIds?.DOI ?? (id.startsWith("doi:") ? id.slice(4) : null);
  if (doi) return { label: "DOI", url: `https://doi.org/${encodeURI(doi)}` };

  if (id.startsWith("openalex:")) {
    return { label: "OpenAlex", url: `https://openalex.org/${encodeURIComponent(id.slice(9))}` };
  }
  if (id && !id.includes(":")) {
    return {
      label: "Semantic Scholar",
      url: `https://www.semanticscholar.org/paper/${encodeURIComponent(id)}`,
    };
  }
  return null;
}
