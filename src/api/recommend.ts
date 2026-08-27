import type { CitationGraphSettings, LlmResponse, S2Paper } from "../types";
import type { ResolvedPaper, ResolverClients } from "./multi-source";
import { resolvePaperWithRefs } from "./multi-source";
import { S2RateLimitError } from "./semantic-scholar";
import { callLlm } from "./llm";

/** One paper already on the canvas, as described to the model. */
export interface CanvasPaperSummary {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxiv: string | null;
  /** Only populated when the user opted into sending abstracts. */
  abstract?: string | null;
}

/** One paper the model suggested adding. */
export interface Recommendation {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxiv: string | null;
  /** The model's one-line justification, shown in the picker. */
  reason: string;
}

/** A suggestion that turned out to name a real, resolvable paper. */
export interface VerifiedRecommendation {
  recommendation: Recommendation;
  resolved: ResolvedPaper;
}

/**
 * Why a suggestion was discarded.
 * `unknown`  -- no source could find it, so it probably does not exist.
 * `mismatch` -- the identifier it gave belongs to a different paper.
 */
export type DropReason = "unknown" | "mismatch";

export interface VerificationResult {
  verified: VerifiedRecommendation[];
  dropped: Array<{ recommendation: Recommendation; reason: DropReason }>;
  /**
   * Suggestions verification never reached, because the source stopped
   * answering. These are explicitly not dropped: nothing was learned about
   * them, and saying otherwise would report a rate limit as a fake paper.
   */
  unchecked: Recommendation[];
  /** Why verification stopped early, when it did. */
  stoppedReason: string | null;
}

// ─── Prompt ────────────────────────────────────────────────────

/** Abstracts are truncated at this many characters each before being sent. */
const ABSTRACT_CHAR_LIMIT = 1200;

/**
 * The instruction block used when neither the settings prompt nor the
 * invocation prompt supplies one. The canvas listing and the JSON contract are
 * appended separately, so replacing this text never breaks parsing.
 */
export function defaultRecommendInstructions(
  count: number,
  webSearch: boolean,
): string {
  const lines = [
    "You are helping a researcher extend a citation graph canvas in Obsidian.",
    "",
    `Suggest ${count} further papers that would fit the collection listed below: foundational work it is clearly building on, closely related work it is missing, and important newer work in the same line of research.`,
    "",
    "Rules:",
    "- Never suggest a paper that is already on the canvas.",
    "- Suggest real, published papers only. If you are not certain a paper exists, leave it out rather than guessing.",
    "- Prefer papers you can identify by DOI or arXiv ID, and reproduce the identifier exactly. Use null when you do not know it.",
    "- Favour papers central to the collection's topic over tangential ones.",
    "- Give each suggestion a one-sentence reason tied to what is actually on this canvas.",
  ];
  if (webSearch) {
    lines.push(
      "- Search the web to confirm each paper exists and to catch recent work; do not rely on memory alone.",
    );
  }
  return lines.join("\n");
}

/** Render the canvas as a numbered list for the prompt. */
export function formatCanvasPapers(papers: CanvasPaperSummary[]): string {
  return papers
    .map((p, i) => {
      const authors = p.authors.length ? p.authors.join(", ") : "unknown authors";
      const year = p.year ? String(p.year) : "n.d.";
      const ids: string[] = [];
      if (p.doi) ids.push(`DOI ${p.doi}`);
      if (p.arxiv) ids.push(`arXiv ${p.arxiv}`);
      const idPart = ids.length ? ` [${ids.join("; ")}]` : "";
      let line = `${i + 1}. "${p.title || "Untitled"}" -- ${authors} (${year})${idPart}`;
      const abstract = p.abstract?.trim();
      if (abstract) {
        const trimmed =
          abstract.length > ABSTRACT_CHAR_LIMIT
            ? `${abstract.slice(0, ABSTRACT_CHAR_LIMIT)}...`
            : abstract;
        line += `\n   Abstract: ${trimmed}`;
      }
      return line;
    })
    .join("\n");
}

/** The output contract, appended to every prompt whether custom or default. */
const JSON_CONTRACT = `Reply with JSON and nothing else: no prose before or after it, no code fences. The JSON is an array of objects shaped like this:

[
  {
    "title": "exact paper title",
    "authors": ["First Author", "Second Author"],
    "year": 2020,
    "doi": "10.1000/example or null if unknown",
    "arxiv": "2101.00001 or null if unknown",
    "reason": "one sentence on why this paper fits this canvas"
  }
]`;

export interface RecommendPromptOptions {
  papers: CanvasPaperSummary[];
  count: number;
  /** Replaces the built-in instruction block. Blank falls back to the default. */
  custom?: string;
  webSearch: boolean;
}

/**
 * Assemble the full prompt: instructions (custom or built-in), the canvas
 * listing, then the JSON contract. The last two are always ours, so a custom
 * prompt can change what is asked for without breaking how the answer is read.
 */
export function buildRecommendPrompt(opts: RecommendPromptOptions): string {
  const instructions =
    opts.custom?.trim() || defaultRecommendInstructions(opts.count, opts.webSearch);
  return [
    instructions,
    "",
    "Papers currently on the canvas:",
    formatCanvasPapers(opts.papers),
    "",
    JSON_CONTRACT,
  ].join("\n");
}

// ─── Parsing ───────────────────────────────────────────────────

/** Strip a `https://doi.org/` or `doi:` wrapper and surrounding whitespace. */
export function normalizeDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  if (!cleaned || cleaned.toLowerCase() === "null") return null;
  return /^10\.\d{4,9}\//.test(cleaned) ? cleaned : null;
}

/** Strip an `arXiv:` prefix or abs/pdf URL, keeping the bare identifier. */
export function normalizeArxiv(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^arxiv:\s*/i, "")
    .trim();
  if (!cleaned || cleaned.toLowerCase() === "null") return null;
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(cleaned) || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(cleaned)
    ? cleaned
    : null;
}

/** Pull the outermost JSON array out of a model reply that may wrap it in prose. */
function extractJsonArray(text: string): string | null {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("[");
  const end = withoutFences.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return withoutFences.slice(start, end + 1);
}

/**
 * Read the model's reply into recommendations.
 *
 * Deliberately lenient about packaging (code fences, a wrapper object, stray
 * prose) and strict about content: an entry without a usable title is dropped,
 * because nothing downstream can verify it.
 */
export function parseRecommendations(text: string): Recommendation[] {
  if (!text?.trim()) return [];

  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    const slice = extractJsonArray(text);
    if (!slice) return [];
    try {
      raw = JSON.parse(slice);
    } catch {
      return [];
    }
  }

  // Some models wrap the array in {"recommendations": [...]} despite the contract.
  if (raw && !Array.isArray(raw) && typeof raw === "object") {
    const values = Object.values(raw as Record<string, unknown>);
    raw = values.find((v) => Array.isArray(v)) ?? null;
  }
  if (!Array.isArray(raw)) return [];

  const out: Recommendation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === "string" ? e.title.trim() : "";
    if (!title) continue;
    const authors = Array.isArray(e.authors)
      ? e.authors.filter((a): a is string => typeof a === "string").map((a) => a.trim())
      : [];
    const yearValue = typeof e.year === "string" ? parseInt(e.year, 10) : e.year;
    out.push({
      title,
      authors,
      year: typeof yearValue === "number" && Number.isFinite(yearValue) ? yearValue : null,
      doi: normalizeDoi(e.doi),
      arxiv: normalizeArxiv(e.arxiv),
      reason: typeof e.reason === "string" ? e.reason.trim() : "",
    });
  }
  return out;
}

// ─── Title matching ────────────────────────────────────────────

/** Words carrying no discriminating power in a paper title. */
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "and", "or", "on", "in", "to", "with", "via", "using", "at", "by", "from",
]);

/** Lowercase, drop punctuation and stopwords, and split into tokens. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !TITLE_STOPWORDS.has(t));
}

/**
 * Overlap between two titles, 0 to 1: the shared token count over the smaller
 * token set. Asymmetric on purpose -- a subtitle dropped from one side should
 * not push a genuine match below threshold.
 */
export function titleSimilarity(a: string, b: string): number {
  const setA = new Set(titleTokens(a));
  const setB = new Set(titleTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

/** Whether two titles are close enough to be the same paper. */
export function titlesMatch(a: string, b: string): boolean {
  return titleSimilarity(a, b) >= 0.7;
}

/** Whether a suggestion names a paper the canvas already holds. */
export function isAlreadyOnCanvas(
  rec: Recommendation,
  canvas: CanvasPaperSummary[],
): boolean {
  const doi = rec.doi?.toLowerCase();
  const arxiv = rec.arxiv?.toLowerCase();
  return canvas.some((p) => {
    if (doi && p.doi && p.doi.toLowerCase() === doi) return true;
    if (arxiv && p.arxiv && p.arxiv.toLowerCase() === arxiv) return true;
    return titlesMatch(rec.title, p.title || "");
  });
}

// ─── Calling the model ─────────────────────────────────────────

export interface RecommendCallOptions extends RecommendPromptOptions {
  /** Wall-clock limit for the Claude CLI provider; web search makes runs long. */
  timeoutMs?: number;
  /** Progress line from providers that can report what they are doing. */
  onActivity?: (activity: string) => void;
}

/** Ask the configured provider for recommendations and parse its reply. */
export async function requestRecommendations(
  opts: RecommendCallOptions,
  settings: CitationGraphSettings,
): Promise<{ recommendations: Recommendation[]; response: LlmResponse }> {
  const response = await callLlm(
    {
      prompt: buildRecommendPrompt(opts),
      webSearch: opts.webSearch,
      maxOutputTokens: settings.recommendMaxOutputTokens,
      timeoutMs: opts.timeoutMs,
      onActivity: opts.onActivity,
    },
    settings,
  );
  return { recommendations: parseRecommendations(response.text), response };
}

// ─── Verification ──────────────────────────────────────────────

/** The S2 lookup key for a paper we already resolved. */
function s2QueryFor(paper: S2Paper): string {
  if (paper.externalIds?.DOI) return `DOI:${paper.externalIds.DOI}`;
  if (paper.externalIds?.ArXiv) return `ARXIV:${paper.externalIds.ArXiv}`;
  return paper.paperId;
}

/**
 * Check every suggestion against the citation sources and keep only those that
 * name a real paper.
 *
 * Two failure modes are caught here, and both are common with LLM output: a
 * paper that simply does not exist, and a real identifier attached to the wrong
 * title. For the second, the title is re-searched before the suggestion is
 * dropped, since a stale DOI on an otherwise real paper is recoverable.
 *
 * Each check costs at least one rate-limited Semantic Scholar request, so
 * onProgress exists to keep the UI honest about the wait.
 */
export async function verifyRecommendations(
  recommendations: Recommendation[],
  clients: ResolverClients,
  onProgress?: (done: number, total: number, title: string) => void,
): Promise<VerificationResult> {
  const verified: VerifiedRecommendation[] = [];
  const dropped: VerificationResult["dropped"] = [];
  const seen = new Set<string>();

  for (let i = 0; i < recommendations.length; i++) {
    const rec = recommendations[i];
    onProgress?.(i + 1, recommendations.length, rec.title);

    let resolved: ResolvedPaper | null = null;
    let reason: DropReason = "unknown";

    try {
      if (rec.doi) {
        resolved = await resolvePaperWithRefs(
          { doi: rec.doi, arxiv: rec.arxiv, s2Query: `DOI:${rec.doi}` },
          clients,
        );
      } else if (rec.arxiv) {
        resolved = await resolvePaperWithRefs(
          { doi: null, arxiv: rec.arxiv, s2Query: `ARXIV:${rec.arxiv}` },
          clients,
        );
      }

      // An identifier that resolves to a different paper is worse than none:
      // trusting it would put a paper on the canvas that nobody asked for.
      if (resolved && !titlesMatch(resolved.paper.title || "", rec.title)) {
        resolved = null;
        reason = "mismatch";
      }

      if (!resolved) {
        const match = await clients.s2.matchTitle(rec.title);
        if (match && titlesMatch(match.title || "", rec.title)) {
          resolved = await resolvePaperWithRefs(
            {
              doi: match.externalIds?.DOI ?? null,
              arxiv: match.externalIds?.ArXiv ?? null,
              s2Query: s2QueryFor(match),
            },
            clients,
          );
          // The search already proved the paper exists, so a failed follow-up
          // lookup costs edges, not the paper itself.
          resolved ??= {
            paper: match,
            references: [],
            citations: [],
            metadataSource: "s2",
            refSources: [],
          };
        }
      }

    } catch (e) {
      // A source that has stopped answering tells us nothing about this paper
      // or the ones after it, so stop rather than discarding them all.
      if (e instanceof S2RateLimitError) {
        return {
          verified,
          dropped,
          unchecked: recommendations.slice(i),
          stoppedReason: e.message,
        };
      }
      throw e;
    }

    if (!resolved) {
      dropped.push({ recommendation: rec, reason });
      continue;
    }

    // The model can name the same paper twice, or two suggestions can resolve
    // to one record through different identifiers.
    const key =
      resolved.paper.externalIds?.DOI?.toLowerCase() ||
      resolved.paper.paperId ||
      resolved.paper.title;
    if (seen.has(key)) continue;
    seen.add(key);

    verified.push({ recommendation: rec, resolved });
  }

  return { verified, dropped, unchecked: [], stoppedReason: null };
}
