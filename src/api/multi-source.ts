import type { SemanticScholarClient } from "./semantic-scholar";
import type { OpenAlexClient } from "./openalex";
import type { CrossRefClient } from "./crossref";
import type { ArxivMetadataClient } from "./arxiv-metadata";
import type { S2Paper, CitationGraphSettings } from "../types";

export interface MultiSourceResult {
  references: S2Paper[];
  citations: S2Paper[];
  /** Which sources contributed data */
  sources: string[];
}

export interface MultiSourceClients {
  s2: SemanticScholarClient;
  openalex: OpenAlexClient;
  crossref: CrossRefClient;
}

/** Clients needed by resolvePaperWithRefs (a superset of MultiSourceClients) */
export interface ResolverClients extends MultiSourceClients {
  arxiv: ArxivMetadataClient;
}

export interface ResolvedPaper {
  /** S2Paper-shaped metadata for the resolved paper */
  paper: S2Paper;
  references: S2Paper[];
  citations: S2Paper[];
  /** Which source provided the paper metadata: "s2" | "openalex" | "arxiv" | "crossref" */
  metadataSource: string;
  /** Which sources contributed any references or citations */
  refSources: string[];
}

/**
 * Resolve a paper's metadata AND its references/citations with fallback.
 *
 * Strategy:
 *   1. Try Semantic Scholar first (one request returns everything).
 *   2. If S2 returns null, fall back to OpenAlex (DOI), arXiv (arXiv ID),
 *      then CrossRef (DOI) for metadata. First non-null wins.
 *   3. Once we have metadata from a fallback source, also pull references
 *      and citations from OpenAlex/CrossRef so the canvas can still draw
 *      edges. References may be empty if no source has them — that's fine,
 *      the caller can add the paper without edges.
 *
 * Returns null only when no source can identify the paper at all.
 */
export async function resolvePaperWithRefs(
  input: { doi: string | null; arxiv: string | null; s2Query: string },
  clients: ResolverClients
): Promise<ResolvedPaper | null> {
  // 1. Try S2 first — happy path returns metadata + refs + citations in one call
  const s2Paper = await clients.s2.getPaperWithRefs(input.s2Query);
  if (s2Paper) {
    const references = (s2Paper.references || []).filter(Boolean);
    const citations = (s2Paper.citations || []).filter(Boolean);
    return {
      paper: s2Paper,
      references,
      citations,
      metadataSource: "s2",
      refSources: references.length || citations.length ? ["s2"] : [],
    };
  }

  // 2. S2 didn't find it — try fallbacks for metadata
  let paper: S2Paper | null = null;
  let metadataSource = "";

  if (input.doi) {
    paper = await clients.openalex.getMetadataForDoi(input.doi).catch(() => null);
    if (paper) metadataSource = "openalex";
  }
  if (!paper && input.arxiv) {
    paper = await clients.arxiv.getMetadata(input.arxiv).catch(() => null);
    if (paper) metadataSource = "arxiv";
  }
  if (!paper && input.doi) {
    paper = await clients.crossref.getMetadataForDoi(input.doi).catch(() => null);
    if (paper) metadataSource = "crossref";
  }

  if (!paper) return null;

  // If arXiv gave us a DOI, that DOI may also work for refs/citations
  const effectiveDoi = input.doi || paper.externalIds?.DOI || null;

  // 3. Pull refs/citations from any source that has them
  const refSources: string[] = [];
  const allRefs: S2Paper[] = [];
  const allCites: S2Paper[] = [];

  if (effectiveDoi) {
    const [oaRefs, oaCites, crRefs] = await Promise.all([
      clients.openalex.getReferencesForDoi(effectiveDoi).catch(() => [] as S2Paper[]),
      clients.openalex.getCitationsForDoi(effectiveDoi).catch(() => [] as S2Paper[]),
      clients.crossref.getReferencesForDoi(effectiveDoi).catch(() => [] as S2Paper[]),
    ]);
    if (oaRefs.length || oaCites.length) refSources.push("openalex");
    if (crRefs.length) refSources.push("crossref");
    allRefs.push(...oaRefs, ...crRefs);
    allCites.push(...oaCites);
  }

  return {
    paper,
    references: deduplicateByDoi(allRefs),
    citations: deduplicateByDoi(allCites),
    metadataSource,
    refSources,
  };
}

/**
 * Fetch references and citations from all enabled sources in parallel,
 * then merge and deduplicate by DOI. Clients are injected so rate-limit
 * state is preserved across calls in the same session.
 */
export async function fetchRefsAndCitations(
  doi: string | null,
  arxivId: string | null,
  s2Id: string | null,
  settings: CitationGraphSettings,
  clients: MultiSourceClients
): Promise<MultiSourceResult | null> {
  const s2ExternalId = doi ? `DOI:${doi}` : arxivId ? `ARXIV:${arxivId}` : s2Id;
  if (!s2ExternalId && !doi) return null;

  const tasks: Promise<{ source: string; references: S2Paper[]; citations: S2Paper[] }>[] = [];

  // Always query Semantic Scholar
  tasks.push(
    (async () => {
      const paper = await clients.s2.getPaperWithRefs(s2ExternalId!);
      return {
        source: "s2",
        references: paper?.references || [],
        citations: paper?.citations || [],
      };
    })().catch(() => ({ source: "s2", references: [], citations: [] }))
  );

  // OpenAlex (requires DOI)
  if (doi && settings.enableOpenAlex) {
    tasks.push(
      (async () => {
        const [references, citations] = await Promise.all([
          clients.openalex.getReferencesForDoi(doi),
          clients.openalex.getCitationsForDoi(doi),
        ]);
        return { source: "openalex", references, citations };
      })().catch(() => ({ source: "openalex", references: [], citations: [] }))
    );
  }

  // CrossRef (requires DOI, references only)
  if (doi && settings.enableCrossRef) {
    tasks.push(
      (async () => {
        const references = await clients.crossref.getReferencesForDoi(doi);
        return { source: "crossref", references, citations: [] as S2Paper[] };
      })().catch(() => ({ source: "crossref", references: [], citations: [] }))
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error("Citation Graph: multi-source task rejected:", r.reason);
    }
  }
  const fulfilled = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

  if (fulfilled.length === 0) return null;

  const sources = fulfilled
    .filter((r) => r.references.length > 0 || r.citations.length > 0)
    .map((r) => r.source);

  // Merge references: S2 first (highest priority), then OpenAlex, then CrossRef
  const allRefs = fulfilled.flatMap((r) => r.references);
  const mergedRefs = deduplicateByDoi(allRefs);

  // Merge citations: S2 first, then OpenAlex (CrossRef doesn't provide citations)
  const allCitations = fulfilled.flatMap((r) => r.citations);
  const mergedCitations = deduplicateByDoi(allCitations);

  if (mergedRefs.length === 0 && mergedCitations.length === 0) return null;

  return { references: mergedRefs, citations: mergedCitations, sources };
}

/**
 * Deduplicate papers by normalized DOI.
 * When two entries share a DOI, keep the one with richer metadata
 * (prefer entries with real S2 paperId > synthetic ID, and with more fields filled).
 */
function deduplicateByDoi(papers: S2Paper[]): S2Paper[] {
  const byDoi = new Map<string, S2Paper>();
  const noDoi: S2Paper[] = [];

  for (const paper of papers) {
    const doi = normalizeDoi(paper);
    if (!doi) {
      // Keep DOI-less papers as-is (can't dedup)
      if (paper.paperId) noDoi.push(paper);
      continue;
    }

    const existing = byDoi.get(doi);
    if (!existing) {
      byDoi.set(doi, paper);
    } else {
      // Merge: prefer the entry with richer metadata
      byDoi.set(doi, mergePapers(existing, paper));
    }
  }

  // Deduplicate noDoi papers by paperId
  const seenIds = new Set<string>();
  // Mark DOI-based entries' paperIds as seen
  for (const paper of byDoi.values()) {
    seenIds.add(paper.paperId);
  }
  const uniqueNoDoi = noDoi.filter((p) => {
    if (seenIds.has(p.paperId)) return false;
    seenIds.add(p.paperId);
    return true;
  });

  return [...byDoi.values(), ...uniqueNoDoi];
}

/** Extract and normalize a DOI from an S2Paper */
function normalizeDoi(paper: S2Paper): string | null {
  const doi = paper.externalIds?.DOI;
  if (!doi) return null;
  return doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, "");
}

/**
 * Merge two papers with the same DOI. Prefer fields from the entry that
 * has a "real" S2 paperId (not synthetic) and more complete metadata.
 */
function mergePapers(a: S2Paper, b: S2Paper): S2Paper {
  // Prefer real S2 paperId over synthetic ones
  const aIsReal = !a.paperId.startsWith("doi:") && !a.paperId.startsWith("openalex:");
  const bIsReal = !b.paperId.startsWith("doi:") && !b.paperId.startsWith("openalex:");

  // Score metadata richness
  const score = (p: S2Paper) =>
    (p.title ? 1 : 0) +
    (p.abstract ? 2 : 0) +
    (p.citationCount != null ? 1 : 0) +
    (p.authors.length > 0 ? 1 : 0) +
    (p.year != null ? 1 : 0);

  let primary: S2Paper;
  let secondary: S2Paper;

  if (aIsReal && !bIsReal) {
    primary = a;
    secondary = b;
  } else if (bIsReal && !aIsReal) {
    primary = b;
    secondary = a;
  } else {
    // Both real or both synthetic: prefer richer metadata
    primary = score(a) >= score(b) ? a : b;
    secondary = score(a) >= score(b) ? b : a;
  }

  // Fill in gaps from secondary
  return {
    paperId: primary.paperId,
    externalIds: {
      ...secondary.externalIds,
      ...primary.externalIds,
    },
    title: primary.title || secondary.title,
    year: primary.year ?? secondary.year,
    authors: primary.authors.length > 0 ? primary.authors : secondary.authors,
    abstract: primary.abstract ?? secondary.abstract,
    citationCount: primary.citationCount ?? secondary.citationCount,
  };
}
