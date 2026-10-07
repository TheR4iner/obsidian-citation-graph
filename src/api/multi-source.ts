import type { SemanticScholarClient } from "./semantic-scholar";
import type { OpenAlexClient } from "./openalex";
import { papersIn } from "./crossref";
import type { CrossRefClient, CrossRefReference } from "./crossref";
import type { ArxivMetadataClient } from "./arxiv-metadata";
import type { S2Paper, CitationGraphSettings } from "../types";

export interface MultiSourceResult {
  references: S2Paper[];
  citations: S2Paper[];
  /** Which sources contributed data */
  sources: string[];
  /**
   * Display names of the sources whose request failed, so the lists lack
   * whatever those sources would have added. Such a result should not be
   * cached, or the gap outlives the outage.
   */
  failed: string[];
}

type SourceId = "s2" | "openalex" | "crossref";

const SOURCE_NAMES: Record<SourceId, string> = {
  s2: "Semantic Scholar",
  openalex: "OpenAlex",
  crossref: "Crossref",
};

interface SourceResult {
  source: SourceId;
  references: S2Paper[];
  citations: S2Paper[];
  failed: boolean;
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
      clients.crossref.getReferenceList(effectiveDoi).then(papersIn).catch(() => [] as S2Paper[]),
    ]);
    if (oaRefs.length || oaCites.length) refSources.push("openalex");
    if (crRefs.length) refSources.push("crossref");
    allRefs.push(...oaRefs, ...crRefs);
    allCites.push(...oaCites);
  }

  return {
    paper,
    references: deduplicatePapers(allRefs),
    citations: deduplicatePapers(allCites),
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
  if (!s2ExternalId) return null;

  const tasks: Promise<SourceResult>[] = [];
  let bibliography: CrossRefReference[] = [];

  tasks.push(
    fromSource("s2", async () => {
      const paper = await clients.s2.getPaperWithRefs(s2ExternalId);
      return { references: paper?.references || [], citations: paper?.citations || [] };
    })
  );

  if (doi && settings.enableOpenAlex) {
    tasks.push(
      fromSource("openalex", async () => {
        const [references, citations] = await Promise.all([
          clients.openalex.getReferencesForDoi(doi),
          clients.openalex.getCitationsForDoi(doi),
        ]);
        return { references, citations };
      })
    );
  }

  // References only: CrossRef has no public citation API.
  if (doi && settings.enableCrossRef) {
    tasks.push(
      fromSource("crossref", async () => {
        bibliography = await clients.crossref.getReferenceList(doi);
        return { references: papersIn(bibliography), citations: [] };
      })
    );
  }

  const results = await Promise.all(tasks);

  const sources = results
    .filter((r) => r.references.length > 0 || r.citations.length > 0)
    .map((r) => r.source);
  const failed = results.filter((r) => r.failed).map((r) => SOURCE_NAMES[r.source]);

  // Merged in task order, so Semantic Scholar's entry wins a tie.
  const references = numberByBibliography(
    deduplicatePapers(results.flatMap((r) => r.references)),
    bibliography
  );
  const citations = deduplicatePapers(results.flatMap((r) => r.citations));

  if (references.length === 0 && citations.length === 0 && failed.length === 0) return null;

  return { references, citations, sources, failed };
}

/** Run one source's requests, turning a failure into an empty, flagged result. */
async function fromSource(
  source: SourceId,
  fetch: () => Promise<{ references: S2Paper[]; citations: S2Paper[] }>
): Promise<SourceResult> {
  try {
    return { source, ...(await fetch()), failed: false };
  } catch (e) {
    console.error(`Citation Graph: ${SOURCE_NAMES[source]} request failed`, e);
    return { source, references: [], citations: [], failed: true };
  }
}

/** Titles shorter than this, once normalized, are too generic to match on. */
const MIN_TITLE_KEY = 20;

/** A title reduced to lowercase letters and digits, for comparing across sources. */
function titleKey(title: string): string {
  return title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Number each reference by its place in the citing paper's bibliography.
 *
 * Crossref's list is the only one in that order. An entry is matched to the
 * paper with its DOI when the entry's own text contains that paper's title,
 * else to the longest title its text contains, else to its DOI unconfirmed
 * (some entries name only the book or the journal). The title check matters:
 * publishers sometimes deposit the DOI of a different paper, and entries
 * without a DOI can still be placed by title.
 */
function numberByBibliography(papers: S2Paper[], bibliography: CrossRefReference[]): S2Paper[] {
  const byDoi = new Map<string, S2Paper>();
  for (const paper of papers) {
    const doi = normalizeDoi(paper);
    if (doi) byDoi.set(doi, paper);
  }
  // ponytail: substring scan, entries x titles; fine for bibliographies of a few hundred.
  const titled = papers
    .map((paper) => ({ paper, key: titleKey(paper.title) }))
    .filter(({ key }) => key.length >= MIN_TITLE_KEY)
    .sort((a, b) => b.key.length - a.key.length);

  const entries = bibliography.map((ref) => {
    const doi = ref.paper ? normalizeDoi(ref.paper) : null;
    return { text: titleKey(ref.text), doiMatch: doi ? byDoi.get(doi) : undefined, placed: false };
  });
  const position = new Map<S2Paper, number>();
  const place = (index: number, paper: S2Paper | undefined) => {
    const entry = entries[index];
    if (!paper || entry.placed || position.has(paper)) return;
    position.set(paper, index);
    entry.placed = true;
  };

  entries.forEach((entry, i) => {
    if (entry.doiMatch && entry.text.includes(titleKey(entry.doiMatch.title))) {
      place(i, entry.doiMatch);
    }
  });
  entries.forEach((entry, i) => {
    if (entry.placed) return;
    place(i, titled.find(({ paper, key }) => !position.has(paper) && entry.text.includes(key))?.paper);
  });
  entries.forEach((entry, i) => place(i, entry.doiMatch));

  return papers.map((paper) => {
    const index = position.get(paper);
    return index === undefined ? paper : { ...paper, referenceIndex: index };
  });
}

/**
 * Deduplicate papers by normalized DOI, then fold each DOI-less paper into
 * the DOI entry with the same title: sources disagree on whether a book or
 * preprint has a DOI, and listing it twice would offer it twice.
 * When two entries share a DOI, keep the one with richer metadata
 * (prefer entries with real S2 paperId > synthetic ID, and with more fields filled).
 */
function deduplicatePapers(papers: S2Paper[]): S2Paper[] {
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

  const doiByTitle = new Map<string, string>();
  for (const [doi, paper] of byDoi) {
    const key = titleKey(paper.title);
    if (key.length >= MIN_TITLE_KEY && !doiByTitle.has(key)) doiByTitle.set(key, doi);
  }
  const unmatched: S2Paper[] = [];
  for (const paper of noDoi) {
    const doi = doiByTitle.get(titleKey(paper.title));
    const existing = doi === undefined ? undefined : byDoi.get(doi);
    if (doi !== undefined && existing) byDoi.set(doi, mergePapers(existing, paper));
    else unmatched.push(paper);
  }

  // Deduplicate the rest by paperId
  const seenIds = new Set<string>();
  // Mark DOI-based entries' paperIds as seen
  for (const paper of byDoi.values()) {
    seenIds.add(paper.paperId);
  }
  const uniqueNoDoi = unmatched.filter((p) => {
    if (seenIds.has(p.paperId)) return false;
    seenIds.add(p.paperId);
    return true;
  });

  return [...byDoi.values(), ...uniqueNoDoi];
}

/**
 * Extract and normalize a DOI from an S2Paper. A preprint known only by its
 * arXiv ID gets arXiv's DataCite DOI, which is how Crossref entries cite it.
 */
function normalizeDoi(paper: S2Paper): string | null {
  const arxiv = paper.externalIds?.ArXiv;
  const doi = paper.externalIds?.DOI || (arxiv ? `10.48550/arXiv.${arxiv}` : null);
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
