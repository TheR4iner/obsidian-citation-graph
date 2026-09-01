import { App, TFile, normalizePath } from "obsidian";
import type { Paper, PaperStatus, DisplayStatus } from "../types";
import { parsePaperStatus } from "../types";

/**
 * Byte budget for a note's filename, leaving room for the ".md" suffix and the
 * "-<n>" deduplication counter within the 255-byte limit common to ext4, APFS
 * and NTFS.
 */
const MAX_NOTE_NAME_BYTES = 200;

/** Truncate to at most `maxBytes` of UTF-8 without splitting a code point. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * Percent-encode the characters that are structurally significant inside a
 * Markdown link destination. DOIs and arXiv IDs come from third-party APIs and
 * are not guaranteed to be link-safe: a bare "(" or ")" truncates the target
 * and leaves the rest of the identifier as visible text, and whitespace turns
 * the tail into a link title.
 */
function encodeLinkTarget(value: string): string {
  return value.replace(/[()<>\s\\]/g, (ch) =>
    "%" + ch.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()
  );
}

/** cssclass every literature note in the reading list carries. */
const NOTE_CLASS = "citation-graph-note";
/** Prefix of the per-status cssclass, e.g. "citation-graph-status-reading". */
const STATUS_CLASS_PREFIX = "citation-graph-status-";

// Status is now read off the canvas node's colour, not a cssclass. The
// prefix remains only so stale per-status classes can be recognised and
// stripped from notes that still carry them.

/**
 * Frontmatter keys that identify a note as a paper. createNote always writes
 * all four (null when unknown), so their mere presence marks a note as the
 * plugin's, while a note adopted from the vault qualifies by carrying a real
 * identifier.
 */
const PAPER_ID_FIELDS = ["doi", "arxiv", "citekey", "semantic_scholar_id"] as const;

/**
 * Make a remote-sourced string safe to interpolate into a note body.
 *
 * Titles and author names arrive from Semantic Scholar, OpenAlex, CrossRef and
 * arXiv, and are written straight into Markdown. Unescaped they can:
 *   - break the note's structure, because an embedded newline ends the block
 *     the value sits in: a title carrying "## Summary" on a second line injects
 *     a heading that the summary writer will later treat as its own,
 *   - create vault artefacts the user never asked for, since Obsidian turns
 *     "[[X]]" into a real wikilink (adding a backlink on X) and "#x" into a
 *     real tag in the tag pane,
 *   - open raw HTML elements inside the rendered note.
 *
 * "<" is escaped only where it actually opens a tag, so ordinary titles
 * containing an inequality ("Bounds for n < m") are left untouched.
 */
export function escapeNoteText(value: string): string {
  return value
    // Any line break or whitespace run collapses to a single space. This is
    // what confines the value to the line it was interpolated into.
    .replace(/\s+/g, " ")
    .trim()
    // Backslash first: doing it later would double-escape the others.
    .replace(/\\/g, "\\\\")
    .replace(/</g, (m, offset: number, full: string) =>
      /[a-zA-Z/!?]/.test(full[offset + 1] ?? "") ? "&lt;" : m
    )
    .replace(/([[\]])/g, "\\$1")
    // Only a "#" Obsidian would read as a tag: start of string or after
    // whitespace, followed by non-space. "C#" and "F#" are unaffected.
    .replace(/(^|\s)#(?=\S)/g, "$1\\#");
}

/**
 * Lines of the generated note scaffold, which do not count as user notes.
 * Anything surviving these strips is treated as the user having engaged with
 * the paper -- including headings they wrote themselves and an LLM-written
 * `## Summary`. Deliberately not anchored on the `## Notes` heading, because
 * users routinely delete it and write their own headings in its place.
 */
const SCAFFOLD_FIELD_LINE = /^\*\*(?:Authors|Year|DOI|arXiv)\*\*:/;
const SCAFFOLD_NOTES_HEADING = /^##\s+Notes\s*$/;
const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Strip the generated scaffold from a note body and report whether any
 * content remains. See SCAFFOLD_FIELD_LINE for why headings are not used as
 * the anchor.
 *
 * One consequence is worth stating explicitly, because it looks like a bug
 * and is not: only the *exact* generated `## Notes` heading counts as
 * scaffold, so renaming it (to `## Reading log`, say) makes the note count as
 * annotated straight away, before a word has been written under it. That is
 * intended -- editing the scaffold is itself engagement with the paper, and
 * the alternative is a heuristic that guesses which of the user's headings
 * are "really" theirs. `literature.test.ts` pins this behaviour, so a
 * refactor that changes it will fail rather than change it silently.
 */
export function bodyHasUserContent(content: string): boolean {
  const withoutFrontmatter = content.replace(FRONTMATTER_BLOCK, "");
  let seenTitleHeading = false;

  for (const line of withoutFrontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // The generated `# <title>` heading, only the first one.
    if (!seenTitleHeading && /^#\s+/.test(trimmed)) {
      seenTitleHeading = true;
      continue;
    }
    if (SCAFFOLD_FIELD_LINE.test(trimmed)) continue;
    if (SCAFFOLD_NOTES_HEADING.test(trimmed)) continue;
    return true;
  }
  return false;
}

/**
 * Read the `arxiv` frontmatter field as a string. YAML parses bare arXiv IDs
 * like `2108.07909` as a float, so hand-edited or unquoted frontmatter can
 * hand us a number here instead of a string.
 */
export function readFrontmatterArxiv(
  fm: Record<string, unknown> | undefined | null
): string | null {
  const value = fm?.arxiv;
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

/** Create and find literature notes for papers */
export class LiteratureNoteManager {
  constructor(
    private app: App,
    private folder: string
  ) {}

  /** Generate a filename from the full paper title, sanitized for the filesystem */
  private getFilename(paper: Paper): string {
    // Strip characters illegal on Windows, control chars, and trailing dots/spaces
    // (Windows also rejects those). Preserve spaces and capitalization elsewhere.
    const clean = (value: string): string =>
      value
        // eslint-disable-next-line no-control-regex -- illegal in filenames, matched on purpose
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
        .replace(/\s+/g, " ")
        .replace(/^[. ]+/, "")
        .replace(/[. ]+$/g, "")
        .trim();

    // Truncate before the final clean: cutting mid-string can leave a new
    // trailing dot or space behind. Titles routinely exceed the 255-byte name
    // limit that ext4/APFS/NTFS enforce, and vault.create would then fail with
    // an opaque error for that one paper.
    const truncated = truncateToBytes(clean(paper.title || ""), MAX_NOTE_NAME_BYTES);
    // A title made only of stripped characters ("...", "??") sanitizes to the
    // empty string, which would produce a hidden ".md" file at the folder root.
    return clean(truncated) || "Untitled";
  }

  /**
   * Index every note in the vault by the identifiers a paper is matched on,
   * built on first use and then kept current as notes are created.
   *
   * Without it, importing a collection walked the whole vault and read the
   * metadata cache for every note, twice, once per paper: a hundred papers in
   * a five-thousand-note vault meant a million cache lookups before a single
   * note was written.
   */
  private noteIndex: NoteIndex | null = null;

  private buildNoteIndex(): NoteIndex {
    const index: NoteIndex = {
      byDoi: new Map(),
      byCitekey: new Map(),
      byS2: new Map(),
      byTitle: new Map(),
    };
    const files = this.app.vault.getMarkdownFiles();
    for (let rank = 0; rank < files.length; rank++) {
      const fm = this.app.metadataCache.getFileCache(files[rank])?.frontmatter;
      if (!fm) continue;
      indexNote(index, files[rank], rank, {
        doi: fm.doi,
        citekey: fm.citekey,
        semanticScholarId: fm.semantic_scholar_id,
        title: fm.title,
      });
    }
    return index;
  }

  /** Find an existing literature note for a paper anywhere in the vault */
  async findExistingNote(paper: Paper): Promise<TFile | null> {
    const index = (this.noteIndex ??= this.buildNoteIndex());

    // First pass: DOI, citekey or S2 ID, the identifiers strong enough to
    // settle it. When more than one matches, the note that comes first in the
    // vault wins, which is what the old linear scan did.
    const strong = [
      paper.doi ? index.byDoi.get(paper.doi) : undefined,
      paper.citekey ? index.byCitekey.get(paper.citekey) : undefined,
      paper.semanticScholarId ? index.byS2.get(paper.semanticScholarId) : undefined,
    ].filter((match): match is IndexedNote => match !== undefined);
    if (strong.length > 0) {
      return strong.reduce((a, b) => (a.rank <= b.rank ? a : b)).file;
    }

    // Second pass: match by title in frontmatter
    if (paper.title) {
      const byTitle = index.byTitle.get(paper.title);
      if (byTitle) return byTitle.file;
    }

    // Third pass: match by expected file path (handles notes without frontmatter)
    const expectedPath = normalizePath(`${this.folder}/${this.getFilename(paper)}.md`);
    const existing = this.app.vault.getAbstractFileByPath(expectedPath);
    if (existing instanceof TFile) return existing;

    return null;
  }

  /** Create a literature note for a paper, returning the vault path */
  async createNote(paper: Paper): Promise<string> {
    // Check for existing note first
    const existing = await this.findExistingNote(paper);
    if (existing) {
      paper.notePath = existing.path;
      await this.updateFrontmatter(existing, paper);
      return existing.path;
    }

    // Ensure folder exists (create parents recursively)
    const folderPath = normalizePath(this.folder);
    await this.ensureFolder(folderPath);

    const filename = this.getFilename(paper);
    let path = normalizePath(`${this.folder}/${filename}.md`);

    // Deduplicate filename if needed
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${this.folder}/${filename}-${counter}.md`);
      counter++;
    }

    // Create with a placeholder body, then let Obsidian build the frontmatter
    // via processFrontMatter so YAML escaping is handled correctly for any
    // title or author name (quotes, colons, unicode).
    const authors = (paper.authors || []).map(escapeNoteText).filter(Boolean).join(", ");
    const body = `# ${escapeNoteText(paper.title || "") || "Untitled"}

**Authors**: ${authors}
**Year**: ${paper.year || "Unknown"}
${paper.doi ? `**DOI**: [${escapeNoteText(paper.doi)}](https://doi.org/${encodeLinkTarget(paper.doi)})` : ""}
${paper.arxiv ? `**arXiv**: [${escapeNoteText(paper.arxiv)}](https://arxiv.org/abs/${encodeLinkTarget(paper.arxiv)})` : ""}

## Notes

`;

    const file = await this.app.vault.create(path, body);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.title = paper.title;
      fm.authors = paper.authors || [];
      fm.year = paper.year || null;
      fm.doi = paper.doi || null;
      fm.arxiv = paper.arxiv || null;
      fm.citekey = paper.citekey || null;
      fm.semantic_scholar_id = paper.semanticScholarId || null;
      fm.status = "unread" satisfies PaperStatus;
      fm.cssclasses = withNoteClass(fm.cssclasses, "unread");
    });
    paper.notePath = path;
    // Keep the index current so later papers in the same batch see this note
    // rather than creating a second copy of it. Ranked last, so a note that
    // was already in the vault still wins any tie.
    if (this.noteIndex) {
      indexNote(this.noteIndex, file, Number.MAX_SAFE_INTEGER, paper);
    }
    return path;
  }

  /** Update frontmatter fields on an existing note if we have new data */
  private async updateFrontmatter(file: TFile, paper: Paper): Promise<void> {
    // Let Obsidian handle YAML encoding and multi-line values correctly.
    let addedArxiv = false;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if ((fm.arxiv == null || fm.arxiv === "null") && paper.arxiv) {
        fm.arxiv = paper.arxiv;
        addedArxiv = true;
      }
      if ((fm.doi == null || fm.doi === "null") && paper.doi) fm.doi = paper.doi;
      if ((fm.semantic_scholar_id == null || fm.semantic_scholar_id === "null") && paper.semanticScholarId) {
        fm.semantic_scholar_id = paper.semanticScholarId;
      }
    });

    // If we just filled in an arXiv ID, also add the link to the note body
    // (below DOI or Year line) so it's clickable from the reader view.
    // Read and written together under the vault's write lock, so a note the
    // user is editing keeps their edits.
    const arxiv = paper.arxiv;
    if (addedArxiv && arxiv) {
      await this.app.vault.process(file, (content) => {
        if (content.includes("**arXiv**")) return content;
        const doiLine = content.match(/^\*\*DOI\*\*:.*$/m);
        const yearLine = content.match(/^\*\*Year\*\*:.*$/m);
        const anchor = doiLine?.[0] || yearLine?.[0];
        if (!anchor) return content;
        return content.replace(
          anchor,
          `${anchor}\n**arXiv**: [${escapeNoteText(arxiv)}](https://arxiv.org/abs/${encodeLinkTarget(arxiv)})`
        );
      });
    }
  }

  /** Recursively ensure a folder path exists */
  private async ensureFolder(folderPath: string): Promise<void> {
    // The vault root always exists and cannot be created: normalizePath maps
    // an empty collections folder (meaning "the vault root") to "/".
    if (!folderPath || folderPath === "/") return;
    if (this.app.vault.getAbstractFileByPath(folderPath)) return;
    // Ensure parent exists first
    const parent = folderPath.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    await this.app.vault.createFolder(folderPath);
  }

  /**
   * Ensure a note carries the plugin's cssclass, preserving any classes the
   * user added themselves. Notes the plugin adopted rather than created can
   * lack it, and the canvas styling keys off it.
   */
  async ensureNoteClass(file: TFile): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const classes = normalizeCssClasses(fm.cssclasses);
      if (classes.includes(NOTE_CLASS)) return;
      classes.unshift(NOTE_CLASS);
      fm.cssclasses = classes;
    });
  }

  /**
   * Whether a note is a paper the reading list should manage.
   *
   * Canvases legitimately hold the user's own notes alongside papers. Those
   * must be left alone entirely: not stamped with cssclasses, not given a
   * status, and not stripped of any colour the user set on them by hand.
   */
  isPaperNote(file: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return false;
    return PAPER_ID_FIELDS.some((key) => key in fm);
  }

  /**
   * Read a note's stored status. Notes written before the status field
   * existed carry a boolean `read`, which maps to "read"/"unread".
   */
  getStatus(file: TFile): PaperStatus {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const stored = parsePaperStatus(fm?.status);
    if (stored) return stored;
    return fm?.read === true ? "read" : "unread";
  }

  /**
   * Whether the user has written anything into the note beyond the generated
   * scaffold. Reads the file rather than the metadata cache, since this is a
   * property of the body, not the frontmatter.
   */
  async hasUserNotes(file: TFile): Promise<boolean> {
    const content = await this.app.vault.cachedRead(file);
    return bodyHasUserContent(content);
  }

  /**
   * How the paper should appear on a canvas. "annotated" is derived here and
   * never stored, so the plugin never persists a status the user did not
   * pick. An abandoned paper stays abandoned even once annotated: notes on it
   * are usually a record of why it was dropped.
   */
  async getDisplayStatus(file: TFile): Promise<DisplayStatus> {
    return this.displayStatusFor(file, this.getStatus(file));
  }

  /**
   * Derive the display status from a status the caller already knows.
   * Callers that have just written a status must use this rather than
   * getDisplayStatus: Obsidian refreshes the metadata cache asynchronously
   * after processFrontMatter, so re-reading it here would see the old value
   * and paint the wrong color.
   */
  async displayStatusFor(file: TFile, status: PaperStatus): Promise<DisplayStatus> {
    if (status === "abandoned") return status;
    return (await this.hasUserNotes(file)) ? "annotated" : status;
  }

  /**
   * Write a note's status, dropping the legacy `read` field so there is only
   * ever one source of truth, and keeping the abandoned cssclass in step.
   */
  async setStatus(file: TFile, status: PaperStatus): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.status = status;
      if ("read" in fm) delete fm.read;
      // The stored status, not the displayed one: "annotated" is derived from
      // the note body, which cannot be read from inside this callback. A
      // caller that needs the distinction follows up with syncNoteClass.
      fm.cssclasses = withNoteClass(fm.cssclasses, status);
    });
  }

  /**
   * Bring a note's cssclasses in step with the status it is being painted
   * with: the marker class that tells a paper from one of the user's own
   * notes, and one status class for the canvas stylesheet to key off.
   *
   * The comparison happens inside `processFrontMatter`, against the note as it
   * is on disk, and deliberately not against `metadataCache`. Obsidian
   * refreshes that cache asynchronously after a write, so a caller that has
   * just called `setStatus` would be compared against the classes from before
   * that call. When those happen to equal what this method wants to write, it
   * would skip the write and leave `setStatus`'s class in place: the note then
   * says one status and the canvas node is painted another.
   */
  async syncNoteClass(file: TFile, status?: DisplayStatus | null): Promise<boolean> {
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const current = normalizeCssClasses(fm.cssclasses);
      const next = withNoteClass(current, status);
      changed =
        current.length !== next.length || current.some((c, i) => c !== next[i]);
      if (changed) fm.cssclasses = next;
    });
    return changed;
  }

  /** Create notes for multiple papers, returning a map of paper ID -> note path */
  async createNotes(
    papers: Paper[],
    onProgress?: (done: number, total: number) => void
  ): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    for (let i = 0; i < papers.length; i++) {
      const path = await this.createNote(papers[i]);
      paths.set(papers[i].id, path);
      if (onProgress) onProgress(i + 1, papers.length);
    }
    return paths;
  }
}

/**
 * Rewrite a note's cssclasses so it carries exactly the marker class and, when
 * one is given, exactly one status class, preserving any classes the user
 * added themselves.
 *
 * NOTE_CLASS is ensured rather than assumed: a note the plugin adopted from
 * the vault rather than created would otherwise miss the canvas styling and
 * keep Obsidian's default washed rendering while every sibling shows a
 * status border.
 *
 * The status class is what `styles.css` reads to write the label along a
 * node's bottom edge and to dash and fade an abandoned paper. Colour is not
 * involved: that stays the canvas file's business, so the two are free to be
 * configured independently and a custom colour styles exactly like a preset.
 * Any stale status class is dropped, so a paper carries at most one.
 */
export function withNoteClass(
  existing: unknown,
  status?: DisplayStatus | null
): string[] {
  const others = normalizeCssClasses(existing).filter(
    (c) => c !== NOTE_CLASS && !c.startsWith(STATUS_CLASS_PREFIX)
  );
  const statusClass = status ? [`${STATUS_CLASS_PREFIX}${status}`] : [];
  return [NOTE_CLASS, ...statusClass, ...others];
}

/**
 * Read a note's `cssclasses` frontmatter as a list. Obsidian accepts either a
 * single string or a list, and hand-edited notes may carry either.
 */
function normalizeCssClasses(existing: unknown): string[] {
  if (Array.isArray(existing)) return existing.map(String).filter((c) => c.trim() !== "");
  if (typeof existing === "string" && existing.trim()) return [existing.trim()];
  return [];
}

/** One note in the identifier index, with its position in the vault. */
interface IndexedNote {
  file: TFile;
  rank: number;
}

/** Every note in the vault, keyed by each identifier it can be matched on. */
interface NoteIndex {
  byDoi: Map<string, IndexedNote>;
  byCitekey: Map<string, IndexedNote>;
  byS2: Map<string, IndexedNote>;
  byTitle: Map<string, IndexedNote>;
}

/**
 * Record one note under every identifier it carries. An identifier already
 * claimed by an earlier note stays with that note, so a lookup returns the
 * same match the old front-to-back scan did.
 */
function indexNote(
  index: NoteIndex,
  file: TFile,
  rank: number,
  ids: {
    doi?: unknown;
    citekey?: unknown;
    semanticScholarId?: unknown;
    title?: unknown;
  }
): void {
  const entry: IndexedNote = { file, rank };
  const add = (map: Map<string, IndexedNote>, key: unknown): void => {
    if (typeof key !== "string" || key === "") return;
    const claimed = map.get(key);
    if (!claimed || claimed.rank > rank) map.set(key, entry);
  };
  add(index.byDoi, ids.doi);
  add(index.byCitekey, ids.citekey);
  add(index.byS2, ids.semanticScholarId);
  add(index.byTitle, ids.title);
}
