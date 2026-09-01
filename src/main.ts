import {
  Plugin,
  Notice,
  TFile,
  FileSystemAdapter,
  normalizePath,
  FuzzySuggestModal,
  Modal,
  ButtonComponent,
  type WorkspaceLeaf,
} from "obsidian";
import { initLog, logNotice, logOnly } from "./log";
import { ProgressNotice } from "./progress-notice";
import type {
  CitationGraphSettings,
  Paper,
  CitationEdge,
  CitationGraph,
  CanvasData,
  CanvasNode,
  CanvasEdge,
  ZoteroItem,
  S2Paper,
  PaperStatus,
  DisplayStatus,
} from "./types";
import {
  DEFAULT_SETTINGS,
  isLlmConfigured,
  resolveApiKeys,
  statusColor,
  nextStatusInCycle,
  wasTruncated,
  STATUS_LABELS,
} from "./types";
import { statusStyleRules } from "./canvas/status-styles";
import { CitationGraphSettingTab } from "./settings";
import { ZoteroClient } from "./api/zotero";
import { SemanticScholarClient } from "./api/semantic-scholar";
import { OpenAlexClient } from "./api/openalex";
import { CrossRefClient } from "./api/crossref";
import { ArxivMetadataClient } from "./api/arxiv-metadata";
import { resolvePaperWithRefs } from "./api/multi-source";
import { findArxivId } from "./api/arxiv-lookup";
import { fetchRefsAndCitations } from "./api/multi-source";
import { CollectionPickerModal } from "./modals/collection-picker";
import { TagPickerModal } from "./modals/tag-picker";
import { ExpandPickerModal } from "./modals/expand-picker";
import { DownloadPickerModal, downloadPapers, buildPaperFilename, expandTilde } from "./modals/download-picker";
import { SendPickerModal } from "./modals/send-picker";
import { RecommendPromptModal } from "./modals/recommend-prompt-modal";
import { RecommendPickerModal } from "./modals/recommend-picker";
import { StatusPickerModal } from "./modals/status-picker";
import {
  BatchMissingPdfModal,
  BatchLongPaperWarningModal,
  BatchSummaryModeModal,
} from "./modals/batch-summary-modals";
import type { BannedPaper } from "./types";
import { LiteratureNoteManager, readFrontmatterArxiv } from "./notes/literature";
import { hasSummarySection, insertSummaryText } from "./notes/summary-text";
import { buildCanvas, expandCanvas, resolveNewEdges } from "./canvas/builder";
import { parseCanvasData } from "./canvas/parse";
import { registerCanvasPaperMenu } from "./canvas/node-menu";
import { hasPaperNode, resolvePaperNodeId, layoutPapers, layoutNewPapers } from "./canvas/layout";
import { S2RefCache } from "./api/s2-cache";
import * as fs from "fs";
import * as path from "path";
import { summarizePaper, effectiveModel, providerSupportsWebSearch } from "./api/llm";
import {
  isAlreadyOnCanvas,
  requestRecommendations,
  verifyRecommendations,
} from "./api/recommend";
import type { CanvasPaperSummary, VerifiedRecommendation } from "./api/recommend";
import { SummaryProgressModal } from "./modals/summary-progress-modal";

/**
 * The plugin's own block inside a .canvas file, alongside Obsidian's `nodes`
 * and `edges`. Absent on a canvas the user created by hand, and every field is
 * optional because the block has grown over several versions.
 */
interface CanvasMeta {
  citationGraphMeta?: {
    zoteroCollectionKey?: string;
    collectionName?: string;
    zoteroTags?: string[];
    bannedPapers?: BannedPaper[];
    lastDownloadPath?: string;
  };
}

/**
 * Apply a status color to a canvas node, removing the color entirely when
 * the status maps to none. Canvas JSON omits `color` for default nodes, so
 * an empty string must delete the key rather than be written through.
 */
function applyStatusColor(node: CanvasNode, color: string): void {
  if (color) {
    node.color = color;
  } else {
    delete node.color;
  }
}

/**
 * Paint the nodes a resolved colour map covers and leave every other node
 * exactly as it is.
 *
 * A path missing from the map is not a paper (a canvas holds the user's own
 * notes too) or arrived on the canvas after the colours were resolved. Either
 * way its colour is none of the plugin's business.
 */
function paintStatusColors(nodes: CanvasNode[], colors: Map<string, string>): void {
  for (const node of nodes) {
    if (node.type !== "file" || !node.file) continue;
    const color = colors.get(node.file);
    if (color === undefined) continue;
    applyStatusColor(node, color);
  }
}

/**
 * The parts of Obsidian's canvas view this plugin reads.
 *
 * There is no public API for the canvas, so the open file and the current
 * selection have to be taken off the view object directly. Everything here is
 * optional on purpose: an Obsidian release that renames one of these leaves
 * the selection-aware commands falling back to their picker instead of
 * throwing.
 */
interface CanvasViewInternals {
  file?: unknown;
  canvas?: {
    selection?: Iterable<{ filePath?: string; file?: { path?: string } }>;
  };
}

/** Read a workspace leaf as a canvas view. */
function canvasViewOf(leaf: WorkspaceLeaf): CanvasViewInternals {
  return leaf.view as unknown as CanvasViewInternals;
}

/** The note path behind every paper node on a canvas. */
function notePathsOf(nodes: CanvasNode[]): string[] {
  return nodes
    .filter((n) => n.type === "file" && n.file)
    .map((n) => n.file!);
}

/**
 * Add papers to a canvas's ban list, skipping any already on it.
 *
 * Mutates the canvas it is handed rather than a captured copy, so it can run
 * inside `updateCanvas` against freshly read content: bans added from another
 * window while a picker was open survive instead of being overwritten.
 * Returns how many were genuinely new.
 */
function addBannedPapers(canvas: CanvasMeta, additions: BannedPaper[]): number {
  const meta = (canvas.citationGraphMeta ??= {});
  const existing = meta.bannedPapers ?? [];
  const known = new Set(existing.map((b) => b.id));
  const fresh = additions.filter((b) => b.id && !known.has(b.id));
  meta.bannedPapers = [...existing, ...fresh];
  return fresh.length;
}

export default class CitationGraphPlugin extends Plugin {
  /** Runtime stylesheet mapping canvas node colours to reading statuses. */
  private statusStyleEl: HTMLStyleElement | null = null;

  settings: CitationGraphSettings = DEFAULT_SETTINGS;
  s2Cache!: S2RefCache;
  // External-API clients are created once at load so their rate-limit state
  // persists across commands within a session.
  private s2Client!: SemanticScholarClient;
  private openAlexClient!: OpenAlexClient;
  private crossRefClient!: CrossRefClient;
  private arxivClient!: ArxivMetadataClient;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyStatusStyles();
    this.addSettingTab(new CitationGraphSettingTab(this.app, this));

    initLog(this.app.vault.adapter, this.pluginDir);

    this.s2Cache = new S2RefCache(this.app.vault.adapter, this.pluginDir);
    await this.s2Cache.load();

    this.s2Client = new SemanticScholarClient();
    this.openAlexClient = new OpenAlexClient();
    this.crossRefClient = new CrossRefClient();
    this.arxivClient = new ArxivMetadataClient();
    this.applyApiCredentials();

    this.addCommand({
      id: "create-from-collection",
      name: "Canvas: create from collection",
      callback: () => this.createFromCollection(),
    });

    this.addCommand({
      id: "create-from-tag",
      name: "Canvas: create from tag",
      callback: () => this.createFromTag(),
    });

    this.addCommand({
      id: "expand-paper",
      name: "Papers: expand paper",
      checkCallback: this.canvasCommand(() => this.expandPaper()),
    });

    this.addCommand({
      id: "expand-paper-refresh",
      name: "Papers: expand paper (force refresh)",
      checkCallback: this.canvasCommand(() => this.expandPaper({ forceRefresh: true })),
    });

    this.addCommand({
      id: "clear-s2-cache",
      name: "Maintenance: clear Semantic Scholar cache",
      callback: async () => {
        this.s2Cache.clear();
        await this.s2Cache.save();
        new Notice("Semantic Scholar cache cleared.");
      },
    });

    this.addCommand({
      id: "relayout-canvas",
      name: "Canvas: relayout",
      checkCallback: this.canvasCommand(() => this.relayoutCanvas()),
    });

    this.addCommand({
      id: "resolve-missing-edges",
      name: "Canvas: resolve missing citation edges",
      checkCallback: this.canvasCommand(() => this.resolveMissingEdges()),
    });

    this.addCommand({
      id: "resolve-missing-edges-refresh",
      name: "Canvas: resolve missing citation edges (force refresh)",
      checkCallback: this.canvasCommand(() =>
        this.resolveMissingEdges({ forceRefresh: true })
      ),
    });

    this.addCommand({
      id: "sync-to-zotero",
      name: "Canvas: sync to Zotero",
      checkCallback: this.canvasCommand(() => this.syncToZotero()),
    });

    this.addCommand({
      id: "download-papers",
      name: "PDFs: download",
      checkCallback: this.canvasCommand(() => this.downloadPapersFromCanvas()),
    });

    this.addCommand({
      id: "add-paper-by-doi",
      name: "Papers: add by DOI or arXiv",
      checkCallback: this.canvasCommand(() => this.addPaperByDoi()),
    });

    this.addCommand({
      id: "refresh-reading-status",
      name: "Reading: refresh reading status",
      checkCallback: this.canvasCommand(() => this.refreshReadingStatus()),
    });

    this.addCommand({
      id: "set-paper-status",
      name: "Reading: set paper status",
      checkCallback: this.canvasCommand(() => this.setPaperStatus()),
    });

    this.addCommand({
      id: "toggle-read-status",
      name: "Reading: cycle reading status",
      checkCallback: this.canvasCommand(() => this.cycleReadingStatus()),
    });

    this.addCommand({
      id: "send-papers-to-canvas",
      name: "Canvas: send papers to another canvas",
      checkCallback: this.canvasCommand(() => this.sendPapersToCanvas()),
    });

    this.addCommand({
      id: "write-summary",
      name: "PDFs: write summary",
      checkCallback: this.canvasCommand(() => this.writeSummary()),
    });

    this.addCommand({
      id: "recommend-papers",
      name: "Papers: recommend papers",
      checkCallback: this.canvasCommand(() => this.recommendPapers()),
    });

    this.addCommand({
      id: "delete-paper",
      name: "Papers: delete paper",
      checkCallback: this.canvasCommand(() => this.deletePaper()),
    });

    this.registerPaperContextMenu();
  }

  /**
   * Wrap a command that only means anything with a canvas open, so it is
   * absent from the command palette the rest of the time rather than present
   * and guaranteed to fail. Obsidian still lists it in the hotkey settings,
   * and an assigned hotkey simply does nothing while no canvas is open.
   *
   * The availability test is the same lookup the commands themselves use, so
   * a command is offered exactly when it would find a canvas to act on.
   */
  private canvasCommand(run: () => unknown): (checking: boolean) => boolean {
    return (checking: boolean): boolean => {
      if (!this.findActiveCanvas()) return false;
      if (!checking) run();
      return true;
    };
  }

  /**
   * Mirror the per-paper commands onto the canvas right-click menu. Every one
   * of them stays in the command palette: this is a second way in for a paper
   * the user has already pointed at, not a replacement. Actions receive the
   * clicked nodes explicitly, so they do not depend on right-click having
   * moved the canvas selection.
   */
  private registerPaperContextMenu(): void {
    const isPaperNote = (path: string): boolean => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return false;
      // Built per call so a changed collections folder is picked up without
      // a plugin reload. isPaperNote only reads the metadata cache.
      const noteManager = new LiteratureNoteManager(
        this.app,
        normalizePath(this.settings.collectionsFolder)
      );
      return noteManager.isPaperNote(file);
    };

    const plural = (verb: string, noun: string) => (count: number) =>
      count === 1 ? `${verb} ${noun}` : `${verb} ${count} ${noun}s`;

    registerCanvasPaperMenu(this, isPaperNote, [
      {
        title: "Expand references and citations",
        icon: "git-fork",
        singleOnly: true,
        run: (paths) => this.expandPaper({ notePath: paths[0] }),
      },
      {
        title: plural("Set status of", "paper"),
        icon: "book-open",
        run: (paths) => this.setPaperStatus(paths),
      },
      {
        title: plural("Cycle status of", "paper"),
        icon: "refresh-cw",
        run: (paths) => this.cycleReadingStatus(paths),
      },
      {
        title: plural("Download", "PDF"),
        icon: "download",
        run: (paths) => this.downloadPapersFromCanvas(paths),
      },
      {
        title: plural("Write", "summary"),
        icon: "file-text",
        run: (paths) => this.writeSummary(paths),
      },
      {
        title: plural("Delete", "paper"),
        icon: "trash-2",
        run: (paths) => this.deletePaper(paths),
      },
    ]);
  }

  onunload(): void {
    this.statusStyleEl?.remove();
    this.statusStyleEl = null;
  }

  /**
   * This plugin's own folder, as a vault-relative path, holding the reference
   * cache and the log file.
   *
   * `manifest.dir` is what Obsidian actually loaded the plugin from and so
   * respects a renamed config directory; the fallback reconstructs the same
   * path for the rare manifest that arrives without it.
   */
  private get pluginDir(): string {
    return (
      this.manifest.dir ??
      normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`)
    );
  }

  /**
   * The same folder as an absolute filesystem path.
   *
   * Only the download helpers need this: they hand the path to code running
   * outside Obsidian, which cannot resolve a vault-relative one. Everything
   * that stays inside the plugin goes through the vault adapter instead, which
   * takes the relative form. Null when the vault is not backed by a real
   * filesystem, so callers report that rather than building a broken path.
   */
  private absolutePluginDir(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    return path.join(adapter.getBasePath(), this.pluginDir);
  }

  /**
   * Find a paper's arXiv ID when its note does not record one.
   *
   * Wired into the download path so a paper added by the DOI of its published
   * version is looked up rather than written off: the preprint is usually
   * there, and it is only the link between the two that is missing.
   */
  private findArxivId(paper: Paper): Promise<string | null> {
    return findArxivId(paper, {
      arxiv: this.arxivClient,
      openalex: this.openAlexClient,
    });
  }

  /**
   * Write arXiv IDs discovered during a download back into their notes, so the
   * next run finds them recorded and skips the lookup.
   */
  private async recordArxivIds(found: Map<string, string>): Promise<void> {
    for (const [notePath, arxivId] of found) {
      const noteFile = this.app.vault.getAbstractFileByPath(notePath);
      if (!(noteFile instanceof TFile)) continue;
      try {
        await this.app.fileManager.processFrontMatter(noteFile, (fm) => {
          if (readFrontmatterArxiv(fm)) return;
          fm.arxiv = arxivId;
        });
      } catch (e) {
        console.error(
          `Citation Graph: could not record the arXiv ID on ${notePath}`,
          e
        );
      }
    }
  }

  /**
   * Read a canvas, let `mutate` rewrite it, and save the result.
   *
   * `Vault.process` re-reads the file under the vault's write lock, so `mutate`
   * sees what is on disk at the moment of writing rather than a snapshot taken
   * before the command started. That distinction is the whole point: these
   * commands routinely spend minutes in Semantic Scholar or an LLM, and a
   * read-then-write pair would silently discard every node the user dragged,
   * added or deleted while they waited.
   *
   * The callback therefore has to derive its result from the canvas it is
   * given, never from one captured earlier. Returning `false` from it leaves
   * the file completely untouched, which matters because re-serialising a
   * canvas reformats JSON the user never asked to have reformatted.
   */
  private async updateCanvas<T = unknown>(
    file: TFile,
    mutate: (canvas: CanvasData & T) => (CanvasData & Partial<T>) | void | false
  ): Promise<void> {
    await this.app.vault.process(file, (raw) => {
      const canvas = parseCanvasData<T>(raw, file.path);
      const updated = mutate(canvas);
      if (updated === false) return raw;
      return JSON.stringify(updated ?? canvas, null, 2);
    });
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    const merged = Object.assign({}, DEFAULT_SETTINGS, saved) as CitationGraphSettings & {
      canvasFolder?: string;
      literatureNotesFolder?: string;
      readColor?: string;
    };

    // One-time migration: fold the old separate folder settings into the
    // unified collectionsFolder, and forget legacy keys we no longer use.
    let changed = false;
    if (saved && !saved.collectionsFolder && (saved.canvasFolder || saved.literatureNotesFolder)) {
      merged.collectionsFolder = saved.canvasFolder || saved.literatureNotesFolder || DEFAULT_SETTINGS.collectionsFolder;
      changed = true;
    }
    for (const legacy of ["canvasFolder", "literatureNotesFolder", "readColor"] as const) {
      if (legacy in merged) {
        delete merged[legacy];
        changed = true;
      }
    }

    this.settings = merged;
    if (changed) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyStatusStyles();
    this.applyApiCredentials();
  }

  /**
   * Push the current keys and contact email into the long-lived API clients.
   *
   * The clients outlive any one command so their rate-limit spacing carries
   * across commands; that also means they never see a credential entered after
   * load unless it is handed to them here.
   */
  private applyApiCredentials(): void {
    const resolved = resolveApiKeys(this.settings);
    this.s2Client.setApiKey(resolved.semanticScholarApiKey);
    this.openAlexClient.setEmail(this.settings.openAlexEmail);
    this.crossRefClient.setEmail(this.settings.openAlexEmail);
  }

  /**
   * Rebuild the small stylesheet that says which node colour means which
   * reading status.
   *
   * Status reaches the canvas as `color` in the .canvas file, which Obsidian
   * turns into a class and a colour on each node. Reading the status back off
   * that keeps the canvas file the single source of truth. The alternative, a
   * per-status cssclass in the note's frontmatter, meant the same fact was
   * stored twice and had to be kept in step, and it resolved through
   * Obsidian's file lookup -- which silently picks the wrong note when two
   * filenames differ only in case.
   *
   * The sheet holds nothing but that mapping: each rule assigns the custom
   * properties `styles.css` reads, and every length, colour and opacity stays
   * there where a theme or snippet can reach it. It has to be generated at all
   * only because which colour means which status is the user's choice, and a
   * static stylesheet cannot know it. Obsidian offers no API for a stylesheet
   * whose contents change, so the element is managed by hand and removed again
   * in `onunload`.
   */
  applyStatusStyles(): void {
    if (!this.statusStyleEl) {
      this.statusStyleEl = document.createElement("style");
      this.statusStyleEl.id = "citation-graph-status-colors";
      document.head.appendChild(this.statusStyleEl);
    }
    this.statusStyleEl.textContent = statusStyleRules(this.settings);
  }

  // ─── Create from Collection ─────────────────────────────────

  private async createFromCollection(): Promise<void> {
    try {
      // 1. Pick collection
      const picker = new CollectionPickerModal(this.app);
      const collection = await picker.pickCollection();
      if (!collection) {
        return;
      }

      logNotice(`Fetching items from "${collection.data.name}"...`);

      // 2. Fetch Zotero items
      const zotero = new ZoteroClient(
        resolveApiKeys(this.settings).zoteroApiKey,
        resolveApiKeys(this.settings).zoteroUserId
      );
      const items = await zotero.getCollectionItems(collection.data.key, collection.data.groupId);

      if (items.length === 0) {
        logNotice("No items found in this collection.");
        return;
      }

      await this.buildCanvasFromItems(items, collection.data.name, {
        zoteroCollectionKey: collection.data.key,
      });
    } catch (e) {
      console.error("Citation Graph: Error creating canvas", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Create from Tag ────────────────────────────────────────

  private async createFromTag(): Promise<void> {
    try {
      const picker = new TagPickerModal(this.app);
      const result = await picker.pickTags();
      if (!result) {
        return;
      }
      const displayName = result.tags.join(" + ");
      logNotice(
        `Building canvas from ${result.items.length} items tagged ${result.tags.join(" ∩ ")}...`
      );
      await this.buildCanvasFromItems(result.items, displayName, {
        zoteroTags: result.tags,
      });
    } catch (e) {
      console.error("Citation Graph: Error creating canvas from tag", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Shared canvas builder ──────────────────────────────────

  /**
   * Take a set of Zotero items and a display name, then run the full pipeline:
   * resolve papers on Semantic Scholar, build edges, create literature notes,
   * write the .canvas file, and open it.
   *
   * `metaExtras` distinguishes the source: a `zoteroCollectionKey` lets
   * Sync-to-Zotero push back into the original collection, while
   * `zoteroTags` records which tag intersection produced the canvas (sync
   * will then create a fresh collection on first sync).
   */
  private async buildCanvasFromItems(
    items: ZoteroItem[],
    displayName: string,
    metaExtras: { zoteroCollectionKey?: string; zoteroTags?: string[] }
  ): Promise<void> {
    // 1. Convert to Papers and collect external IDs
    const papers = new Map<string, Paper>();
    const externalIds: string[] = [];

    for (const item of items) {
      const paper = zoteroItemToPaper(item);
      if (!paper) continue;

      papers.set(paper.id, paper);

      // Build S2-compatible ID
      if (paper.doi) externalIds.push(`DOI:${paper.doi}`);
      else if (paper.arxiv) externalIds.push(`ArXiv:${paper.arxiv}`);
    }

    if (externalIds.length === 0) {
      logNotice(
        "No papers with DOI or arXiv ID found. Cannot build citation graph."
      );
      return;
    }

    logNotice(`Resolving ${externalIds.length} papers on Semantic Scholar...`);

    // 2. Batch resolve on Semantic Scholar with references included so we
    // can build citation edges from the same response (no second round trip).
    const s2Papers = await this.s2Client.getPaperBatch(
      externalIds,
      (done, total) => logNotice(`Resolving papers: ${done}/${total}`),
      true,
    );

    // Enrich our papers with S2 data
    for (const paper of papers.values()) {
      const s2Key = paper.doi
        ? paper.doi.toLowerCase()
        : paper.arxiv || "";
      const s2Paper = s2Papers.get(s2Key);
      if (s2Paper) {
        paper.semanticScholarId = s2Paper.paperId;
        if (!paper.arxiv && s2Paper.externalIds?.ArXiv)
          paper.arxiv = s2Paper.externalIds.ArXiv;
        if (!paper.doi && s2Paper.externalIds?.DOI)
          paper.doi = s2Paper.externalIds.DOI;
        if (!paper.year && s2Paper.year) paper.year = s2Paper.year;
        if (s2Paper.citationCount != null)
          paper.citationCount = s2Paper.citationCount;
        if (s2Paper.abstract) paper.abstract = s2Paper.abstract;
      }
    }

    // 3. Build citation edges from the batch response (no extra requests)
    const resolvedPapers = new Map<string, S2Paper>();
    for (const s2Paper of s2Papers.values()) {
      if (s2Paper.paperId) resolvedPapers.set(s2Paper.paperId, s2Paper);
    }

    const rawEdges = SemanticScholarClient.buildCitationEdgesFromBatch(resolvedPapers);

    // Map S2 edges back to our paper IDs
    const s2IdToPaperId = new Map<string, string>();
    for (const paper of papers.values()) {
      if (paper.semanticScholarId) {
        s2IdToPaperId.set(paper.semanticScholarId, paper.id);
      }
    }

    const edges: CitationEdge[] = rawEdges
      .map((e) => ({
        fromId: s2IdToPaperId.get(e.fromId) || e.fromId,
        toId: s2IdToPaperId.get(e.toId) || e.toId,
      }))
      .filter((e) => papers.has(e.fromId) && papers.has(e.toId));

    // 4. Create directory (canvas + notes co-located). Strip characters
    // illegal on Windows or in iCloud-synced vaults, since the display name
    // is user input (collection name or joined tag list) and may contain any
    // of them.
    logNotice("Creating literature notes...");
    const safeFolder = sanitizeVaultFolderName(displayName);
    const collectionDir = normalizePath(
      `${this.settings.collectionsFolder}/${safeFolder}`
    );
    if (!this.app.vault.getAbstractFileByPath(collectionDir)) {
      await this.app.vault.createFolder(collectionDir);
    }

    const noteManager = new LiteratureNoteManager(
      this.app,
      collectionDir
    );
    await noteManager.createNotes(Array.from(papers.values()), (done, total) => {
      logNotice(`Creating notes: ${done}/${total}`);
    });

    // 5. Build canvas
    const graph: CitationGraph = {
      papers,
      edges,
      collectionName: displayName,
      zoteroCollectionKey: metaExtras.zoteroCollectionKey || "",
    };

    const canvasData = buildCanvas(
      graph,
      this.settings.nodeWidth,
      this.settings.nodeHeight
    );

    // 6. Save canvas file inside the directory
    const safeName = displayName.replace(/[^a-zA-Z0-9_-]/g, "_");
    let canvasPath = normalizePath(`${collectionDir}/${safeName}.canvas`);
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(canvasPath)) {
      canvasPath = normalizePath(
        `${collectionDir}/${safeName}_${counter}.canvas`
      );
      counter++;
    }

    // Paint any notes that already carry a reading status
    paintStatusColors(
      canvasData.nodes,
      await this.resolveStatusColors(notePathsOf(canvasData.nodes))
    );

    // Store metadata in the canvas for later use (expand mode, sync, etc.)
    const canvasWithMeta = {
      ...canvasData,
      citationGraphMeta: {
        zoteroCollectionKey: metaExtras.zoteroCollectionKey || "",
        zoteroTags: metaExtras.zoteroTags,
        collectionName: displayName,
        bannedPapers: [] as BannedPaper[],
      },
    };

    await this.app.vault.create(
      canvasPath,
      JSON.stringify(canvasWithMeta, null, 2)
    );

    // 7. Open the canvas
    const leaf = this.app.workspace.getLeaf(false);
    const file = this.app.vault.getAbstractFileByPath(canvasPath);
    if (file instanceof TFile) {
      await leaf.openFile(file);
    }

    logNotice(
      `Citation graph created: ${papers.size} papers, ${edges.length} edges`
    );
  }

  // ─── Expand Paper ───────────────────────────────────────────

  private async expandPaper(opts?: { forceRefresh?: boolean; notePath?: string }): Promise<void> {
    try {
      // 1. Get the active canvas file
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      // 2. Read canvas data
      const canvasData = await this.readCanvas<CanvasMeta>(activeFile);

      // 3. Ask user which paper to expand (pick from nodes)
      const fileNodes = canvasData.nodes.filter(
        (n) => n.type === "file" && n.file
      );
      if (fileNodes.length === 0) {
        logNotice("No paper nodes found on this canvas.");
        return;
      }

      // Find a paper to expand: the caller's node, else the canvas selection
      let targetNotePath: string | null =
        opts?.notePath && fileNodes.some((n) => n.file === opts.notePath)
          ? opts.notePath
          : null;

      // Check if a node is selected on the canvas
      if (!targetNotePath) {
        for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
          const selection = canvasViewOf(leaf).canvas?.selection;
          if (!selection) continue;
          const selected = [...selection];
          if (selected.length !== 1) continue;
          const filePath = selected[0]?.filePath || selected[0]?.file?.path;
          if (filePath && fileNodes.some((n) => n.file === filePath)) {
            targetNotePath = filePath;
            break;
          }
        }
      }

      // Fall back to paper picker modal
      if (!targetNotePath) {
        targetNotePath = await new Promise<string | null>((resolve) => {
          let resolved = false;
          const done = (val: string | null) => {
            if (!resolved) { resolved = true; resolve(val); }
          };
          class PaperPicker extends FuzzySuggestModal<{
            file: string;
            display: string;
          }> {
            getItems() {
              return fileNodes.map((n) => ({
                file: n.file!,
                display: n.file!.replace(/.*\//, "").replace(/\.md$/, ""),
              }));
            }
            getItemText(item: { display: string }) {
              return item.display;
            }
            onChooseItem(item: { file: string }) {
              done(item.file);
            }
            onClose() {
              setTimeout(() => done(null), 50);
            }
          }
          const picker = new PaperPicker(this.app);
          picker.open();
        });
      }

      if (!targetNotePath) {
        logNotice("No paper selected.");
        return;
      }

      // 4. Read the note's frontmatter to get DOI/S2 ID
      const noteFile = this.app.vault.getAbstractFileByPath(targetNotePath);
      if (!(noteFile instanceof TFile)) {
        logNotice("Could not find the literature note file.");
        return;
      }

      const cache = this.app.metadataCache.getFileCache(noteFile);
      const fm = cache?.frontmatter;
      if (!fm) {
        logNotice("Literature note has no frontmatter.");
        return;
      }

      const doi = fm.doi || null;
      const arxivId = readFrontmatterArxiv(fm);
      const s2Id = fm.semantic_scholar_id || null;
      const externalId = doi ? `DOI:${doi}` : s2Id;

      if (!externalId) {
        logNotice(
          "No DOI or Semantic Scholar ID found in note frontmatter."
        );
        return;
      }

      // 5. Query citation sources (with cache)
      let references: S2Paper[] = [];
      let citations: S2Paper[] = [];
      const cached = opts?.forceRefresh ? null : this.s2Cache.get(externalId);

      if (cached) {
        logNotice("Using cached references...");
        references = cached.references;
        citations = cached.citations;
      } else {
        logNotice("Fetching references and citations...");
        const multiResult = await fetchRefsAndCitations(
          doi, arxivId, s2Id, this.settings,
          { s2: this.s2Client, openalex: this.openAlexClient, crossref: this.crossRefClient },
        );

        if (multiResult) {
          references = multiResult.references;
          citations = multiResult.citations;
          this.s2Cache.setMerged(
            externalId, doi, arxivId,
            references, citations, multiResult.sources,
          );
          await this.s2Cache.save();
        }
      }

      if (references.length === 0 && citations.length === 0) {
        logNotice("No references or citations found for this paper.");
        return;
      }

      // 6. Determine which papers are already on canvas (by S2 ID or DOI)
      const canvasPapers = this.canvasPapers(canvasData);
      const existingS2Ids = this.canvasPaperIds(canvasPapers);

      // 7. Show expand picker (filter out banned papers)
      const bannedPapers = canvasData.citationGraphMeta?.bannedPapers || [];
      const bannedIds = new Set(bannedPapers.map((b) => b.id));

      const expandModal = new ExpandPickerModal(
        this.app,
        references,
        citations,
        existingS2Ids,
        bannedIds
      );
      const { selected, banned } = await expandModal.pickPapers();

      // Papers marked uninteresting are never offered on this canvas again.
      const newBans: BannedPaper[] = banned.map((p) => ({
        id: p.paperId,
        title: p.title || "Untitled",
      }));

      if (selected.length === 0) {
        // The ban list is still worth persisting on its own.
        if (newBans.length === 0) {
          logNotice("No papers selected.");
          return;
        }
        let added = 0;
        await this.updateCanvas<CanvasMeta>(activeFile, (canvas) => {
          added = addBannedPapers(canvas, newBans);
        });
        logNotice(
          `No papers selected. ${added} papers marked as uninteresting.`
        );
        return;
      }

      logNotice(`Adding ${selected.length} papers...`);

      // 8. Convert selected S2 papers to our Paper type
      const newPapers: Paper[] = selected.map((s2p) =>
        s2PaperToPaper(s2p)
      );

      // 9. Create literature notes in the same directory as the canvas
      const expandFolder = activeFile.parent?.path || normalizePath(this.settings.collectionsFolder);
      const noteManager = new LiteratureNoteManager(
        this.app,
        expandFolder
      );
      await noteManager.createNotes(newPapers);

      // 10. Build edges between the expanded paper and the canvas.
      // Both endpoints must name a paper by the id `indexPapers` keys on, which
      // is the paper's own id, never the raw S2 paperId: the fallback sources
      // hand back synthetic ids ("doi:…", "openalex:…") that `s2PaperToPaper`
      // deliberately drops, so an edge naming one resolves to no node and is
      // silently discarded.
      const expandedPaper = canvasPapers.find(
        (p) => p.notePath === targetNotePath
      );
      const expandedId: string =
        expandedPaper?.id || s2Id || doi || externalId;

      const referenceIds = new Set(references.map((r) => r.paperId));
      const newEdges: CitationEdge[] = selected.map((s2p, i) =>
        referenceIds.has(s2p.paperId)
          ? // Expanded paper → selected paper (expanded cites selected)
            { fromId: expandedId, toId: newPapers[i].id }
          : // Selected paper → expanded paper (selected cites expanded)
            { fromId: newPapers[i].id, toId: expandedId }
      );

      // Papers already on the canvas need their edge drawn here too. Without
      // this an expansion only ever links the papers it just added, so a
      // reference that landed on the canvas on an earlier run stays unlinked
      // with no way to link it: the picker disables its row as already present.
      if (expandedPaper) {
        newEdges.push(
          ...this.buildCitationEdges(
            expandedPaper,
            references,
            citations,
            canvasPapers
          )
        );
      }

      // Edges between two *other* papers on the canvas are not resolved here:
      // that would mean querying each one's references separately.

      // 11. Build all-papers map for canvas expansion
      const allPapers = this.indexPapers([...canvasPapers, ...newPapers]);

      // 12. Update canvas. Colours are resolved up front because the write
      //     itself is synchronous and cannot read notes.
      const colors = await this.resolveStatusColors([
        ...notePathsOf(canvasData.nodes),
        ...newPapers.map((p) => p.notePath).filter((p): p is string => !!p),
      ]);

      await this.updateCanvas<CanvasMeta>(activeFile, (canvas) => {
        addBannedPapers(canvas, newBans);
        const expanded = expandCanvas(
          canvas,
          newPapers,
          newEdges,
          allPapers,
          this.settings.nodeWidth,
          this.settings.nodeHeight
        );
        paintStatusColors(expanded.nodes, colors);
        return { ...expanded, citationGraphMeta: canvas.citationGraphMeta };
      });

      logNotice(
        `Added ${selected.length} papers to canvas.`
      );
    } catch (e) {
      console.error("Citation Graph: Error expanding paper", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // ─── Add Paper by DOI or arXiv ──────────────────────────

  private async addPaperByDoi(): Promise<void> {
    try {
      // 1. Find the active canvas
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      // 2. Prompt for DOI or arxiv ID
      const rawInput = await new Promise<string | null>((resolve) => {
        const modal = new DoiInputModal(this.app, resolve);
        modal.open();
      });
      if (!rawInput) return;

      // 3. Parse input: DOI URL, arxiv DOI, arxiv ID, or plain DOI
      let s2Query: string;
      let doi: string | null = null;
      let arxiv: string | null = null;
      let input = rawInput.replace(/^https?:\/\/doi\.org\//i, "").replace(/^https?:\/\/arxiv\.org\/abs\//i, "").trim();

      // arxiv-minted DOIs (10.48550/arXiv.XXXX.XXXXX) → use arxiv ID
      const arxivDoiMatch = input.match(/^10\.48550\/arXiv\.(.+)$/i);
      if (arxivDoiMatch) {
        arxiv = arxivDoiMatch[1];
        s2Query = `ARXIV:${arxiv}`;
      } else if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(input) || /^[a-z-]+\/\d{7}(v\d+)?$/.test(input)) {
        // Raw arxiv ID
        arxiv = input;
        s2Query = `ARXIV:${input}`;
      } else {
        doi = input;
        s2Query = `DOI:${input}`;
      }

      logNotice(`Looking up ${s2Query}...`);
      const resolved = await resolvePaperWithRefs(
        { doi, arxiv, s2Query },
        {
          s2: this.s2Client,
          openalex: this.openAlexClient,
          crossref: this.crossRefClient,
          arxiv: this.arxivClient,
        }
      );

      if (!resolved) {
        logNotice("Paper not found on Semantic Scholar, OpenAlex, arXiv, or CrossRef.");
        return;
      }

      const s2Paper = resolved.paper;
      const paper = s2PaperToPaper(s2Paper);

      // 4. Read canvas data
      const canvasData = await this.readCanvas<CanvasMeta>(activeFile);

      // Check if paper is already on canvas
      const existingNodeIds = new Set(canvasData.nodes.map((n) => n.id));
      if (hasPaperNode(paper, existingNodeIds)) {
        logNotice("This paper is already on the canvas.");
        return;
      }

      // 5. Create literature note in the same directory as the canvas
      const noteFolder = activeFile.parent?.path || normalizePath(this.settings.collectionsFolder);
      const noteManager = new LiteratureNoteManager(this.app, noteFolder);
      await noteManager.createNote(paper);

      // 6. Build edges to existing papers via resolved refs/citations.
      // Matches by S2 ID, DOI (case-insensitive), and arXiv ID, since fallback
      // sources (OpenAlex/CrossRef/arXiv) don't always provide an S2 ID.
      const canvasPapers = this.canvasPapers(canvasData);
      const newEdges = this.buildCitationEdges(
        paper,
        resolved.references,
        resolved.citations,
        canvasPapers
      );

      // 7. Build allPapers map for layout
      const allPapers = this.indexPapers([...canvasPapers, paper]);

      // 8. Update canvas. Colours are resolved up front because the write
      //    itself is synchronous and cannot read notes.
      const colors = await this.resolveStatusColors([
        ...notePathsOf(canvasData.nodes),
        ...(paper.notePath ? [paper.notePath] : []),
      ]);

      await this.updateCanvas<CanvasMeta>(activeFile, (canvas) => {
        const expanded = expandCanvas(
          canvas,
          [paper],
          newEdges,
          allPapers,
          this.settings.nodeWidth,
          this.settings.nodeHeight
        );
        paintStatusColors(expanded.nodes, colors);
        return {
          ...expanded,
          // A canvas the user created by hand has no metadata block yet. Seed
          // one named after the file, or the commands that key off it (sending
          // papers to another canvas, Zotero sync) would refuse a canvas built
          // entirely this way.
          citationGraphMeta: canvas.citationGraphMeta ?? {
            zoteroCollectionKey: "",
            collectionName: activeFile.basename,
            bannedPapers: [] as BannedPaper[],
          },
        };
      });

      const sourceLabel = resolved.metadataSource === "s2"
        ? ""
        : ` (metadata from ${resolved.metadataSource})`;
      logNotice(`Added "${paper.title}" to canvas${sourceLabel}.`);

      if (resolved.references.length === 0 && resolved.citations.length === 0) {
        logNotice(
          `Warning: No references or citations could be resolved for "${paper.title}". The paper was added without citation edges.`
        );
      }
    } catch (e) {
      console.error("Citation Graph: Error adding paper by DOI", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Recommend Papers ───────────────────────────────────

  /**
   * Every canvas node that points at a literature note, read back as a Paper.
   * Abstract and citation count are left empty: they are not stored in
   * frontmatter, and every caller either does not need them or fetches them.
   */
  private canvasPapers(canvasData: CanvasData): Paper[] {
    const papers: Paper[] = [];
    for (const node of canvasData.nodes) {
      if (node.type !== "file" || !node.file) continue;
      const file = this.app.vault.getAbstractFileByPath(node.file);
      if (!(file instanceof TFile)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      papers.push({
        id: fm.doi || fm.semantic_scholar_id || node.id,
        title: fm.title || "",
        authors: fm.authors || [],
        year: fm.year || 0,
        doi: fm.doi || null,
        arxiv: readFrontmatterArxiv(fm),
        citekey: fm.citekey || null,
        semanticScholarId: fm.semantic_scholar_id || null,
        abstract: null,
        citationCount: null,
        notePath: node.file,
      });
    }
    return papers;
  }

  /**
   * Index papers by every identifier the layout code might look them up by.
   * Edges name papers by their stable id, but callers also resolve S2 IDs.
   */
  private indexPapers(papers: Paper[]): Map<string, Paper> {
    const index = new Map<string, Paper>();
    for (const paper of papers) {
      index.set(paper.id, paper);
      if (paper.semanticScholarId) index.set(paper.semanticScholarId, paper);
    }
    return index;
  }

  /** The identifiers that mark a paper as already present on a canvas. */
  private canvasPaperIds(papers: Paper[]): Set<string> {
    const ids = new Set<string>();
    for (const paper of papers) {
      if (paper.semanticScholarId) ids.add(paper.semanticScholarId);
      if (paper.doi) ids.add(`doi:${paper.doi.toLowerCase()}`);
    }
    return ids;
  }

  /**
   * Citation edges between one newly resolved paper and papers already known,
   * matching on S2 ID, DOI and arXiv ID because the fallback sources
   * (OpenAlex/CrossRef/arXiv) do not all supply an S2 ID.
   */
  private buildCitationEdges(
    paper: Paper,
    references: S2Paper[],
    citations: S2Paper[],
    others: Paper[],
  ): CitationEdge[] {
    const refIds = collectRefIdentifiers(references);
    const citeIds = collectRefIdentifiers(citations);
    const edges: CitationEdge[] = [];

    for (const other of others) {
      if (other.id === paper.id) continue;
      const s2 = other.semanticScholarId;
      const doi = other.doi?.toLowerCase();
      const arxiv = other.arxiv;

      const isReference =
        (s2 && refIds.s2.has(s2)) ||
        (doi && refIds.doi.has(doi)) ||
        (arxiv && refIds.arxiv.has(arxiv));
      const isCitation =
        (s2 && citeIds.s2.has(s2)) ||
        (doi && citeIds.doi.has(doi)) ||
        (arxiv && citeIds.arxiv.has(arxiv));

      if (isReference) edges.push({ fromId: paper.id, toId: other.id });
      if (isCitation) edges.push({ fromId: other.id, toId: paper.id });
    }

    return edges;
  }

  /**
   * Re-resolve every paper on the canvas against the citation sources and draw
   * the edges the canvas is missing.
   *
   * Expanding papers one at a time does not add up to this. An expansion only
   * resolves edges incident to the paper being expanded, and it cannot bring in
   * a paper that is already present: the picker lists such a row disabled, so a
   * pair that arrived on the canvas by two separate routes has no way to get
   * its arrow. This walks every paper instead and asks for the whole set.
   *
   * Nodes are never touched. Only `edges` is rewritten, so hand-placed
   * positions survive; moving nodes is *Canvas: relayout*'s job and it asks
   * first.
   */
  private async resolveMissingEdges(opts?: { forceRefresh?: boolean }): Promise<void> {
    const progress = new ProgressNotice("Resolving citation edges");
    try {
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      const canvasData = await this.readCanvas(activeFile);

      const papers = this.canvasPapers(canvasData);
      if (papers.length < 2) {
        logNotice(
          "This canvas has fewer than two papers, so there are no edges to resolve."
        );
        return;
      }

      const citationEdges: CitationEdge[] = [];
      const unidentified: string[] = [];
      const unresolved: string[] = [];
      let fetched = 0;
      let fromCache = 0;

      for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        progress.setStatus(
          `Resolving citation edges: paper ${i + 1} of ${papers.length}`
        );
        progress.setHint(paper.title || paper.id);

        // fetchRefsAndCitations derives its own query IDs; this key is only for
        // the cache, which indexes DOI, arXiv and S2 forms alike.
        const cacheKey = paper.doi
          ? `DOI:${paper.doi}`
          : paper.arxiv
            ? `ARXIV:${paper.arxiv}`
            : paper.semanticScholarId;
        if (!cacheKey) {
          unidentified.push(paper.title || paper.notePath || paper.id);
          continue;
        }

        const cached = opts?.forceRefresh ? null : this.s2Cache.get(cacheKey);
        let references: S2Paper[];
        let citations: S2Paper[];

        if (cached) {
          references = cached.references;
          citations = cached.citations;
          fromCache++;
        } else {
          const result = await fetchRefsAndCitations(
            paper.doi, paper.arxiv, paper.semanticScholarId, this.settings,
            { s2: this.s2Client, openalex: this.openAlexClient, crossref: this.crossRefClient },
          );
          if (!result) {
            // Every source came back empty. Usually the paper is too new or too
            // obscure to be indexed, but an exhausted Semantic Scholar rate
            // limit looks the same from here, which is why the count is
            // reported rather than passed over.
            unresolved.push(paper.title || paper.id);
            continue;
          }
          references = result.references;
          citations = result.citations;
          this.s2Cache.setMerged(
            cacheKey, paper.doi, paper.arxiv,
            references, citations, result.sources,
          );
          fetched++;
        }

        citationEdges.push(
          ...this.buildCitationEdges(paper, references, citations, papers)
        );
      }

      if (fetched > 0) await this.s2Cache.save();

      // Which edges are missing is decided against the canvas as it stands at
      // write time, not against the snapshot taken before the fetch loop: that
      // loop runs for minutes on a large canvas, and every node the user added,
      // moved or deleted meanwhile has to survive it. The count is taken from
      // the same pass so the notice reports what was actually written.
      const paperIndex = this.indexPapers(papers);
      let addedCount = 0;
      await this.updateCanvas(activeFile, (canvas) => {
        const addedEdges = resolveNewEdges(
          canvas.edges,
          new Set(canvas.nodes.map((n) => n.id)),
          citationEdges,
          paperIndex
        );
        addedCount = addedEdges.length;
        // Nodes are never touched by this command, so a run that finds no
        // missing edge must leave the file byte-for-byte as it was.
        if (addedEdges.length === 0) return false;
        canvas.edges = [...canvas.edges, ...addedEdges];
      });

      progress.hide();

      const detail = [
        `${papers.length} papers checked`,
        `${fromCache} from cache`,
      ];
      if (unresolved.length > 0) {
        detail.push(`${unresolved.length} with no citation data`);
        logOnly(`No citation data resolved for: ${unresolved.join("; ")}`);
      }
      if (unidentified.length > 0) {
        detail.push(`${unidentified.length} without an identifier`);
        logOnly(
          `No DOI, arXiv ID or Semantic Scholar ID for: ${unidentified.join("; ")}`
        );
      }
      logNotice(
        addedCount === 0
          ? `No missing citation edges found (${detail.join(", ")}).`
          : `Added ${addedCount} citation edge${addedCount === 1 ? "" : "s"} (${detail.join(", ")}).`
      );
    } catch (e) {
      console.error("Citation Graph: Error resolving missing edges", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.hide();
    }
  }

  /**
   * Ask the configured LLM which papers would fit the current canvas, verify
   * every suggestion against the citation sources, and offer the survivors in
   * the same picker the Expand command uses.
   *
   * Verification is not optional: a model will happily invent a plausible
   * title, authors and DOI, and an unverified suggestion cannot become a
   * canvas node anyway because it has no identifier to hang edges off.
   */
  private async recommendPapers(): Promise<void> {
    try {
      if (!isLlmConfigured(this.settings)) {
        logNotice(
          "Configure the LLM settings first: Recommend papers uses the same provider as Write summary."
        );
        return;
      }

      const canvasFile = this.findActiveCanvas();
      if (!canvasFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      const canvasData = await this.readCanvas<CanvasMeta>(canvasFile);

      if (!canvasData.nodes.some((n) => n.type === "file" && n.file)) {
        logNotice("No paper nodes found on this canvas.");
        return;
      }

      const existingPapers = this.canvasPapers(canvasData);
      if (existingPapers.length === 0) {
        logNotice(
          "The notes behind this canvas have no frontmatter, so there is nothing to describe to the model."
        );
        return;
      }

      const settings = resolveApiKeys(this.settings);
      const model = effectiveModel(settings);
      const canSearch = providerSupportsWebSearch(settings);
      const webSearch = settings.recommendWebSearch && canSearch;
      const searchNote = webSearch
        ? `${model} will search the web as well as drawing on its own knowledge.`
        : canSearch
          ? "Web search is off in the plugin settings, so suggestions come from the model's own knowledge only."
          : "This provider cannot search the web, so suggestions come from the model's own knowledge only.";

      const request = await new RecommendPromptModal(
        this.app,
        existingPapers.length,
        searchNote
      ).pick();
      if (!request) return;

      const summaries: CanvasPaperSummary[] = existingPapers.map((p) => ({
        title: p.title,
        authors: p.authors || [],
        year: p.year || null,
        doi: p.doi,
        arxiv: p.arxiv,
      }));

      if (request.includeAbstracts) {
        await this.attachAbstracts(summaries);
      }

      const progress = new ProgressNotice(
        `Asking ${model} for recommendations`,
        webSearch
          ? "web search takes a few minutes, please wait"
          : "this takes a minute, please wait"
      );
      let recommendations;
      let usage;
      try {
        const result = await requestRecommendations(
          {
            papers: summaries,
            count: settings.recommendCount,
            custom: request.prompt || settings.recommendPrompt,
            webSearch,
            // Web search plus a long list takes the CLI well past the default.
            timeoutMs: 600000,
            onActivity: (activity) => progress.setStatus(activity),
          },
          settings
        );
        recommendations = result.recommendations;
        usage = result.response;
      } finally {
        progress.hide();
      }

      if (recommendations.length === 0) {
        logNotice(
          wasTruncated(usage?.stopReason)
            ? "The model's reply was cut off at the output limit, so no recommendations could be read. " +
              "Raise \"Max output tokens\" under Recommendations, or ask for fewer papers."
            : "The model returned no usable recommendations. Its reply is in citation-graph.log."
        );
        logOnly(
          "Recommendation reply that could not be parsed:\n" +
          (usage?.text ?? "").slice(0, 4000)
        );
        return;
      }

      const fresh = recommendations.filter((rec) => !isAlreadyOnCanvas(rec, summaries));
      const alreadyPresent = recommendations.length - fresh.length;

      if (fresh.length === 0) {
        logNotice(
          `All ${recommendations.length} suggestions are already on this canvas.`
        );
        return;
      }

      const checking = "checking each paper exists";
      const verifyProgress = new ProgressNotice(`Verifying 1/${fresh.length}`, checking);
      // Surface a backoff wait rather than letting the count appear to stall.
      this.s2Client.onRateLimitWait = (seconds) => {
        verifyProgress.setHint(`Semantic Scholar rate limit, retrying in ${seconds}s`);
      };
      let verifyResult;
      try {
        verifyResult = await verifyRecommendations(
          fresh,
          {
            s2: this.s2Client,
            openalex: this.openAlexClient,
            crossref: this.crossRefClient,
            arxiv: this.arxivClient,
          },
          (done, total, title) => {
            verifyProgress.setStatus(`Verifying ${done}/${total}: ${title.slice(0, 60)}`);
            verifyProgress.setHint(checking);
          }
        );
      } finally {
        this.s2Client.onRateLimitWait = null;
        verifyProgress.hide();
      }

      const { verified, dropped, unchecked, stoppedReason } = verifyResult;

      const spent =
        usage && usage.inputTokens + usage.outputTokens > 0
          ? `${usage.inputTokens} in / ${usage.outputTokens} out tokens`
          : "";
      const tally = [
        `${verified.length} of ${recommendations.length} suggestions verified`,
        alreadyPresent > 0 ? `${alreadyPresent} already on canvas` : "",
        dropped.length > 0 ? `${dropped.length} discarded as unverifiable` : "",
        unchecked.length > 0 ? `${unchecked.length} never checked` : "",
        spent,
      ].filter(Boolean);
      logNotice(`${tally.join(", ")}.`);

      if (stoppedReason) logNotice(stoppedReason);

      for (const drop of dropped) {
        logOnly(
          `Discarded recommendation (${drop.reason}): "${drop.recommendation.title}"` +
          (drop.recommendation.doi ? ` [DOI ${drop.recommendation.doi}]` : "")
        );
      }

      if (verified.length === 0) return;

      const bannedPapers = canvasData.citationGraphMeta?.bannedPapers || [];
      const bannedIds = new Set(bannedPapers.map((b) => b.id));

      const picker = new RecommendPickerModal(
        this.app,
        verified,
        this.canvasPaperIds(existingPapers),
        bannedIds
      );
      const { selected, banned } = await picker.pickPapers();

      const newBans: BannedPaper[] = banned
        .filter((p) => p.paperId)
        .map((p) => ({ id: p.paperId, title: p.title || "Untitled" }));

      if (selected.length === 0) {
        // The ban list is still worth persisting on its own.
        if (newBans.length === 0) {
          logNotice("No papers selected.");
          return;
        }
        let added = 0;
        await this.updateCanvas<CanvasMeta>(canvasFile, (canvas) => {
          added = addBannedPapers(canvas, newBans);
        });
        logNotice(
          `No papers selected. ${added} papers marked as uninteresting.`
        );
        return;
      }

      await this.addRecommendedPapers(canvasFile, existingPapers, selected, newBans);
    } catch (e) {
      console.error("Citation Graph: Error recommending papers", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Fill in abstracts for the papers being described to the model. One batch
   * request covers the whole canvas; papers Semantic Scholar cannot resolve
   * simply keep their title-only entry.
   */
  private async attachAbstracts(summaries: CanvasPaperSummary[]): Promise<void> {
    const ids = summaries
      .map((p) => (p.doi ? `DOI:${p.doi}` : p.arxiv ? `ArXiv:${p.arxiv}` : null))
      .filter((id): id is string => id !== null);
    if (ids.length === 0) return;

    const notice = new Notice("Fetching abstracts...", 0);
    try {
      const papers = await this.s2Client.getPaperBatch(ids);
      for (const summary of summaries) {
        const key = summary.doi?.toLowerCase() || summary.arxiv;
        if (!key) continue;
        const match = papers.get(key);
        if (match?.abstract) summary.abstract = match.abstract;
      }
    } finally {
      notice.hide();
    }
  }

  /** Create notes for accepted recommendations and place them on the canvas. */
  private async addRecommendedPapers(
    canvasFile: TFile,
    existingPapers: Paper[],
    selected: VerifiedRecommendation[],
    newBans: BannedPaper[],
  ): Promise<void> {
    logNotice(`Adding ${selected.length} papers...`);

    const newPapers = selected.map((v) => s2PaperToPaper(v.resolved.paper));

    const noteFolder =
      canvasFile.parent?.path || normalizePath(this.settings.collectionsFolder);
    const noteManager = new LiteratureNoteManager(this.app, noteFolder);
    await noteManager.createNotes(newPapers);

    // Verification already fetched each paper's references and citations, so
    // edges cost nothing extra here — including edges among the new papers.
    const counterparts = [...existingPapers, ...newPapers];
    const newEdges: CitationEdge[] = [];
    for (let i = 0; i < selected.length; i++) {
      newEdges.push(
        ...this.buildCitationEdges(
          newPapers[i],
          selected[i].resolved.references,
          selected[i].resolved.citations,
          counterparts
        )
      );
    }

    const allPapers = this.indexPapers(counterparts);
    // Colours are resolved up front because the write itself is synchronous
    // and cannot read notes.
    const colors = await this.resolveStatusColors([
      ...existingPapers.map((p) => p.notePath),
      ...newPapers.map((p) => p.notePath),
    ].filter((p): p is string => !!p));

    await this.updateCanvas<CanvasMeta>(canvasFile, (canvas) => {
      addBannedPapers(canvas, newBans);
      const expanded = expandCanvas(
        canvas,
        newPapers,
        newEdges,
        allPapers,
        this.settings.nodeWidth,
        this.settings.nodeHeight
      );
      paintStatusColors(expanded.nodes, colors);
      return { ...expanded, citationGraphMeta: canvas.citationGraphMeta };
    });

    const withoutEdges = newPapers.filter(
      (p) => !newEdges.some((e) => e.fromId === p.id || e.toId === p.id)
    ).length;
    logNotice(
      `Added ${newPapers.length} papers to canvas` +
      (withoutEdges > 0 ? ` (${withoutEdges} with no citation link to the canvas).` : ".")
    );
  }

  // ─── Download Papers ────────────────────────────────────

  private async downloadPapersFromCanvas(paths?: string[]): Promise<void> {
    try {
      // 1. Find the active canvas
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      // 2. Read canvas and extract papers
      const canvasData = await this.readCanvas<CanvasMeta>(activeFile);

      const fileNodes = canvasData.nodes.filter(
        (n) => n.type === "file" && n.file
      );
      if (fileNodes.length === 0) {
        logNotice("No paper nodes found on this canvas.");
        return;
      }

      // 3. Build Paper objects from note frontmatter
      const papers: Paper[] = [];
      for (const node of fileNodes) {
        const noteFile = this.app.vault.getAbstractFileByPath(node.file!);
        if (!(noteFile instanceof TFile)) continue;
        const cache = this.app.metadataCache.getFileCache(noteFile);
        const fm = cache?.frontmatter;
        if (!fm) continue;
        papers.push({
          id: fm.doi || fm.semantic_scholar_id || node.id,
          title: fm.title || "Untitled",
          authors: fm.authors || [],
          year: fm.year || 0,
          doi: fm.doi || null,
          arxiv: readFrontmatterArxiv(fm),
          citekey: fm.citekey || null,
          semanticScholarId: fm.semantic_scholar_id || null,
          abstract: null,
          citationCount: null,
          notePath: node.file!,
        });
      }

      if (papers.length === 0) {
        logNotice("Could not read paper metadata from notes.");
        return;
      }

      // 4. Filter to the targeted papers if any nodes are highlighted
      const selectedPaths = this.resolveTargetPaths(fileNodes, paths);
      const modalPapers = selectedPaths.length > 0
        ? papers.filter((p) => selectedPaths.includes(p.notePath!))
        : papers;

      if (modalPapers.length === 0) {
        logNotice("None of the selected nodes are paper notes.");
        return;
      }

      // 5. Resolve the plugin's own directory, so a download fallback can
      //    locate any helper files bundled alongside the plugin.
      const pluginDir = this.absolutePluginDir();
      if (!pluginDir) {
        logNotice(
          "Downloading needs a vault stored in the local filesystem."
        );
        return;
      }

      // 6. Decide where the PDFs go, and ask which papers only when there is
      //    a question to ask. Picking one paper and running the command is
      //    already an answer; a modal offering that single paper back with a
      //    checkbox beside it adds a click and no information.
      const knownPath =
        canvasData.citationGraphMeta?.lastDownloadPath ||
        this.settings.defaultDownloadPath ||
        "";

      let downloadPath: string;
      let chosenPapers: Paper[];
      if (modalPapers.length === 1 && knownPath) {
        downloadPath = knownPath;
        chosenPapers = modalPapers;
      } else {
        const result = await new DownloadPickerModal(
          this.app,
          modalPapers,
          knownPath
        ).pickPapers();
        if (!result) return;
        downloadPath = result.downloadPath;
        chosenPapers = result.papers;
      }

      // 7. Save the download path to canvas metadata for next time
      await this.updateCanvas<CanvasMeta>(activeFile, (canvas) => {
        (canvas.citationGraphMeta ??= {}).lastDownloadPath = downloadPath;
      });

      // 8. Download papers
      logNotice(
        chosenPapers.length === 1
          ? `Downloading "${chosenPapers[0].title}"...`
          : `Downloading ${chosenPapers.length} papers...`
      );
      const { downloaded, failed, resolvedArxiv } = await downloadPapers(
        chosenPapers,
        downloadPath,
        pluginDir,
        {
          onProgress: (done, total, title) => {
            logNotice(`Downloading ${done + 1}/${total}: ${title}`);
          },
          resolveArxiv: (paper) => this.findArxivId(paper),
        }
      );
      await this.recordArxivIds(resolvedArxiv);

      // 9. Report results
      if (failed.length === 0) {
        logNotice(
          downloaded === 1
            ? `Downloaded "${chosenPapers[0].title}".`
            : `Downloaded ${downloaded} papers successfully.`
        );
      } else {
        logNotice(
          `Downloaded ${downloaded}/${downloaded + failed.length} papers. Failed: ${failed.join(", ")}`
        );
      }
    } catch (e) {
      console.error("Citation Graph: Error downloading papers", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Sync to Zotero ──────────────────────────────────────

  private async syncToZotero(): Promise<void> {
    try {
      // 0. Check Zotero Web API credentials (local API is read-only)
      const resolvedForZotero = resolveApiKeys(this.settings);
      if (!resolvedForZotero.zoteroApiKey || !resolvedForZotero.zoteroUserId) {
        logNotice(
          "Zotero API key and user ID are required to sync. Configure them in settings or via ZOTERO_API_KEY / ZOTERO_USER_ID env vars."
        );
        return;
      }

      // 1. Find the active canvas
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      const canvasData = await this.readCanvas<CanvasMeta>(activeFile);

      // 2. Read paper metadata from all file nodes on canvas
      const fileNodes = canvasData.nodes.filter((n) => n.type === "file" && n.file);
      if (fileNodes.length === 0) {
        logNotice("No paper nodes found on this canvas.");
        return;
      }

      const canvasPapers: Array<{
        title: string;
        authors: string[];
        year: number;
        doi: string | null;
      }> = [];

      for (const node of fileNodes) {
        const noteFile = this.app.vault.getAbstractFileByPath(node.file!);
        if (!(noteFile instanceof TFile)) continue;
        const cache = this.app.metadataCache.getFileCache(noteFile);
        const fm = cache?.frontmatter;
        if (!fm) continue;
        canvasPapers.push({
          title: fm.title || "Untitled",
          authors: fm.authors || [],
          year: fm.year || 0,
          doi: fm.doi || null,
        });
      }

      if (canvasPapers.length === 0) {
        logNotice("Could not read paper metadata from notes.");
        return;
      }

      // 3. Ask user: update existing collection or create new?
      const existingCollectionKey = canvasData.citationGraphMeta?.zoteroCollectionKey;
      const collectionName = canvasData.citationGraphMeta?.collectionName || activeFile.basename;

      const mode = await new Promise<"update" | "create" | null>((resolve) => {
        let resolved = false;
        const done = (val: "update" | "create" | null) => {
          if (!resolved) { resolved = true; resolve(val); }
        };
        class SyncModeModal extends FuzzySuggestModal<{ id: "update" | "create"; label: string }> {
          getItems() {
            const items: Array<{ id: "update" | "create"; label: string }> = [];
            if (existingCollectionKey) {
              items.push({
                id: "update",
                label: `Update existing collection "${collectionName}"`,
              });
            }
            items.push({ id: "create", label: "Create new Zotero collection" });
            return items;
          }
          getItemText(item: { label: string }) {
            return item.label;
          }
          onChooseItem(item: { id: "update" | "create" }) {
            done(item.id);
          }
          onClose() {
            // Delay to let onChooseItem fire first
            setTimeout(() => done(null), 50);
          }
        }
        new SyncModeModal(this.app).open();
      });

      if (!mode) return;

      const zotero = new ZoteroClient(
        resolvedForZotero.zoteroApiKey,
        resolvedForZotero.zoteroUserId
      );

      let targetCollectionKey: string;

      if (mode === "update" && existingCollectionKey) {
        targetCollectionKey = existingCollectionKey;

        // Fetch existing items to deduplicate by DOI
        logNotice("Fetching existing Zotero collection items...");
        const existingItems = await zotero.getCollectionItems(targetCollectionKey);
        const existingDois = new Set<string>();
        for (const item of existingItems) {
          const doi = ZoteroClient.extractDOI(item);
          if (doi) existingDois.add(doi.toLowerCase());
        }

        // Filter out papers already in the collection
        const newPapers = canvasPapers.filter((p) => {
          if (!p.doi) return true; // no DOI = can't dedup, add anyway
          return !existingDois.has(p.doi.toLowerCase());
        });

        if (newPapers.length === 0) {
          logNotice("All papers are already in the Zotero collection.");
          return;
        }

        logNotice(`Adding ${newPapers.length} new papers to Zotero (${canvasPapers.length - newPapers.length} already present)...`);
        await zotero.addItems(
          newPapers.map((p) => paperToZoteroItem(p)),
          targetCollectionKey
        );
      } else {
        // Create new collection — prompt for name, check for conflicts
        const existingCollections = await zotero.getCollections();
        const existingNames = new Set(existingCollections.map((c) => c.data.name));
        const suggestedName = `${collectionName} (canvas sync)`;

        const newName = await new Promise<string | null>((resolve) => {
          let resolved = false;
          const modal = new Modal(this.app);
          modal.onOpen = () => {
            const { contentEl } = modal;
            modal.setTitle("New Zotero collection");
            const input = contentEl.createEl("input", {
              type: "text",
              cls: "citation-graph-collection-name-input",
              value: suggestedName,
            });

            const warning = contentEl.createDiv({
              cls: "citation-graph-collection-warning",
            });

            const updateWarning = () => {
              if (existingNames.has(input.value.trim())) {
                warning.setText("A collection with this name already exists.");
              } else {
                warning.setText("");
              }
            };
            updateWarning();
            input.addEventListener("input", updateWarning);

            const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
            new ButtonComponent(footer)
              .setButtonText("Create")
              .setCta()
              .onClick(() => {
                const name = input.value.trim();
                if (!name) return;
                if (existingNames.has(name)) return;
                if (!resolved) { resolved = true; resolve(name); }
                modal.close();
              });
            new ButtonComponent(footer)
              .setButtonText("Cancel")
              .onClick(() => modal.close());

            input.focus();
            input.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                const name = input.value.trim();
                if (!name || existingNames.has(name)) return;
                if (!resolved) { resolved = true; resolve(name); }
                modal.close();
              }
            });
          };
          modal.onClose = () => {
            if (!resolved) { resolved = true; resolve(null); }
          };
          modal.open();
        });

        if (!newName) return;

        logNotice(`Creating Zotero collection "${newName}"...`);
        targetCollectionKey = await zotero.createCollection(newName);

        logNotice(`Adding ${canvasPapers.length} papers to new Zotero collection...`);
        await zotero.addItems(
          canvasPapers.map((p) => paperToZoteroItem(p)),
          targetCollectionKey
        );

        // Update canvas metadata with new collection key
        await this.updateCanvas<CanvasMeta>(activeFile, (canvas) => {
          const meta = (canvas.citationGraphMeta ??= {});
          meta.zoteroCollectionKey = targetCollectionKey;
          meta.collectionName = newName;
        });
      }

      logNotice("Zotero sync complete!");
    } catch (e) {
      console.error("Citation Graph: Error syncing to Zotero", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Reading Status ─────────────────────────────────────────

  /**
   * Repaint every paper on the active canvas from its note.
   *
   * The other commands keep a paper's colour and label current as its status
   * changes, but two things drift without this: "annotated" is derived from
   * the note body, so writing notes changes a paper's appearance with no
   * command involved; and papers whose notes predate the status classes have
   * no label until something writes one.
   */
  private async refreshReadingStatus(): Promise<void> {
    try {
      const canvasFile = this.findActiveCanvas();
      if (!canvasFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      const canvasData = await this.readCanvas<CanvasMeta>(canvasFile);
      const colors = await this.resolveStatusColors(notePathsOf(canvasData.nodes));

      await this.updateCanvas<CanvasMeta>(canvasFile, (canvas) => {
        paintStatusColors(canvas.nodes, colors);
      });

      const papers = notePathsOf(canvasData.nodes).length;
      logNotice(`Refreshed reading status for ${papers} node${papers === 1 ? "" : "s"}.`);
    } catch (e) {
      console.error("Citation Graph: Error refreshing reading status", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Set an explicit status on the selected papers.
   *
   * "Read + notes written" is not offered here: it is derived from the note
   * body when the canvas is painted, so there is no stored value to set.
   */
  private async setPaperStatus(paths?: string[]): Promise<void> {
    try {
      const targets = await this.resolveCanvasTargets(paths);
      if (!targets) return;

      const status = await StatusPickerModal.pick(this.app, targets.targetPaths.length);
      if (!status) {
        logNotice("No status selected.");
        return;
      }

      const applied = await this.applyStatusToPapers(targets, () => status);
      if (applied === 0) return;
      logNotice(
        `Set ${applied} paper${applied === 1 ? "" : "s"} to "${STATUS_LABELS[status]}".`
      );
    } catch (e) {
      console.error("Citation Graph: Error setting paper status", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Advance the selected papers through unread -> reading -> read, for
   * marking progress without opening the picker. Abandoned papers re-enter
   * the cycle at the start; annotated is skipped because it is derived.
   */
  private async cycleReadingStatus(paths?: string[]): Promise<void> {
    try {
      const targets = await this.resolveCanvasTargets(paths);
      if (!targets) return;

      let lastStatus: PaperStatus | null = null;
      const applied = await this.applyStatusToPapers(targets, (current) => {
        lastStatus = nextStatusInCycle(current);
        return lastStatus;
      });

      if (applied === 0) return;
      logNotice(
        applied === 1 && lastStatus
          ? `Status: ${STATUS_LABELS[lastStatus]}.`
          : `Advanced reading status for ${applied} papers.`
      );
    } catch (e) {
      console.error("Citation Graph: Error cycling reading status", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Write a new status to each target note and repaint its canvas node,
   * returning how many papers were actually updated. The repaint derives the
   * color from the status just written rather than re-reading it, so a paper
   * that already has notes lands on "annotated" immediately without waiting
   * for Obsidian's metadata cache to catch up with the write.
   */
  private async applyStatusToPapers(
    targets: {
      canvasFile: TFile;
      canvasData: CanvasData & CanvasMeta;
      targetPaths: string[];
    },
    nextStatus: (current: PaperStatus) => PaperStatus
  ): Promise<number> {
    const { canvasFile, targetPaths } = targets;
    const canvasDir = canvasFile.parent?.path || normalizePath(this.settings.collectionsFolder);
    const noteManager = new LiteratureNoteManager(this.app, canvasDir);

    // Every note is written and its new colour worked out before the canvas is
    // touched, because the canvas write below is synchronous.
    const colors = new Map<string, string>();
    let updated = 0;
    let skipped = 0;
    for (const filePath of targetPaths) {
      const noteFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!(noteFile instanceof TFile)) continue;
      if (!noteManager.isPaperNote(noteFile)) {
        skipped++;
        continue;
      }

      const written = nextStatus(noteManager.getStatus(noteFile));
      await noteManager.setStatus(noteFile, written);
      updated++;

      const display: DisplayStatus = await noteManager.displayStatusFor(noteFile, written);
      colors.set(filePath, statusColor(this.settings, display));
    }

    if (updated === 0) {
      logNotice(
        skipped > 0
          ? "Selection contains no papers. Notes that are not papers are left alone."
          : "No literature notes found for the selected papers."
      );
      return 0;
    }
    if (skipped > 0) {
      logNotice(`Skipped ${skipped} note${skipped === 1 ? "" : "s"} that ${skipped === 1 ? "is" : "are"} not a paper.`);
    }

    await this.updateCanvas<CanvasMeta>(canvasFile, (canvas) => {
      paintStatusColors(canvas.nodes, colors);
    });
    return updated;
  }

  // ─── Delete Paper ───────────────────────────────────────────

  private async deletePaper(paths?: string[]): Promise<void> {
    try {
      // 1. Resolve the canvas and which papers to delete
      const targets = await this.resolveCanvasTargets(paths);
      if (!targets) return;
      const { canvasFile: activeFile, targetPaths } = targets;

      // 2. Confirmation dialog
      const displayNames = targetPaths.map((p) =>
        p.replace(/.*\//, "").replace(/\.md$/, "")
      );
      const confirmed = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const done = (val: boolean) => {
          if (!resolved) { resolved = true; resolve(val); }
        };
        const modal = new Modal(this.app);
        modal.onOpen = () => {
          const { contentEl } = modal;
          modal.setTitle(
            `Delete ${targetPaths.length} paper${targetPaths.length > 1 ? "s" : ""}?`
          );
          contentEl.createEl("p", {
            text: "The canvas node and its citation edges will be removed, and the literature note will be moved to trash.",
          });
          const list = contentEl.createEl("ul");
          for (const name of displayNames.slice(0, 10)) {
            list.createEl("li", { text: name });
          }
          if (displayNames.length > 10) {
            list.createEl("li", { text: `…and ${displayNames.length - 10} more` });
          }
          const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
          new ButtonComponent(footer)
            .setButtonText("Delete")
            .setWarning()
            .onClick(() => { done(true); modal.close(); });
          new ButtonComponent(footer)
            .setButtonText("Cancel")
            .onClick(() => modal.close());
        };
        modal.onClose = () => done(false);
        modal.open();
      });

      if (!confirmed) return;

      // 3. Collect the notes to trash
      const filesToTrash: TFile[] = [];
      for (const filePath of targetPaths) {
        const noteFile = this.app.vault.getAbstractFileByPath(filePath);
        if (noteFile instanceof TFile) filesToTrash.push(noteFile);
      }

      // 4. Prune nodes and edges, writing the canvas first so no view still
      //    references the files about to be trashed. The nodes are matched by
      //    path against the canvas as it stands now, so a node the user moved
      //    or renumbered while the confirmation was open still goes.
      const doomed = new Set(targetPaths);
      let removedCount = 0;
      await this.updateCanvas(activeFile, (canvas) => {
        const removedNodeIds = new Set(
          canvas.nodes
            .filter((n) => n.type === "file" && n.file && doomed.has(n.file))
            .map((n) => n.id)
        );
        removedCount = removedNodeIds.size;
        canvas.nodes = canvas.nodes.filter((n) => !removedNodeIds.has(n.id));
        canvas.edges = canvas.edges.filter(
          (e) => !removedNodeIds.has(e.fromNode) && !removedNodeIds.has(e.toNode)
        );
      });

      // 5. Trash literature note files
      let trashed = 0;
      for (const file of filesToTrash) {
        try {
          await this.app.fileManager.trashFile(file);
          trashed++;
        } catch (err) {
          console.error(`Citation Graph: failed to trash ${file.path}`, err);
        }
      }

      logNotice(
        `Deleted ${removedCount} paper${removedCount !== 1 ? "s" : ""} (${trashed} note${trashed !== 1 ? "s" : ""} trashed).`
      );
    } catch (e) {
      console.error("Citation Graph: Error deleting paper", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Which papers a per-paper command acts on: the caller's explicit list when
   * there is one (the canvas context menu passes the clicked nodes), else the
   * canvas selection. Either way the result is restricted to paths that are
   * actually on this canvas.
   */
  private resolveTargetPaths(
    fileNodes: { file?: string }[],
    overridePaths?: string[]
  ): string[] {
    if (!overridePaths || overridePaths.length === 0) {
      return this.getSelectedCanvasPaths(fileNodes);
    }
    return overridePaths.filter((p) => fileNodes.some((n) => n.file === p));
  }

  /**
   * Get file paths of paper nodes currently selected on any open canvas.
   * Returns an empty array if nothing is selected.
   */
  private getSelectedCanvasPaths(fileNodes: { file?: string }[]): string[] {
    const targetPaths: string[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const selection = canvasViewOf(leaf).canvas?.selection;
      if (!selection) continue;
      for (const selectedNode of selection) {
        const filePath = selectedNode?.filePath || selectedNode?.file?.path;
        if (filePath && fileNodes.some((n) => n.file === filePath)) {
          targetPaths.push(filePath);
        }
      }
      if (targetPaths.length > 0) break;
    }
    return targetPaths;
  }

  /**
   * Work out the colour each note's canvas node should carry, and bring the
   * note's marker class up to date while the file is open anyway.
   *
   * Reading happens here rather than during the write because `updateCanvas`
   * mutates synchronously, under the vault's write lock: no note can be read
   * once the canvas is open for writing. The map assigns a colour for every
   * status, empty string included, so a node's colour ends up a pure function
   * of its note instead of accumulating stale colours from earlier statuses.
   *
   * Notes that are not papers are left out of the map entirely, which is how
   * `paintStatusColors` knows to leave those nodes alone.
   */
  private async resolveStatusColors(
    notePaths: Iterable<string>
  ): Promise<Map<string, string>> {
    const canvasDir = normalizePath(this.settings.collectionsFolder);
    const noteManager = new LiteratureNoteManager(this.app, canvasDir);
    const colors = new Map<string, string>();

    // Resolve every note concurrently: a large canvas would otherwise
    // serialize one file read per node behind the previous one.
    await Promise.all(
      [...new Set(notePaths)].map(async (notePath) => {
        const noteFile = this.app.vault.getAbstractFileByPath(notePath);
        if (!(noteFile instanceof TFile)) return;
        // Canvases hold the user's own notes too. Leave those completely
        // alone, including any colour they set on the node by hand.
        if (!noteManager.isPaperNote(noteFile)) return;
        const display = await noteManager.getDisplayStatus(noteFile);
        colors.set(notePath, statusColor(this.settings, display));
        // The label follows the colour, so nothing else needs writing. This
        // only ensures the marker class and clears stale per-status classes,
        // and is a no-op once a note is clean.
        await noteManager.syncNoteClass(noteFile);
      })
    );

    return colors;
  }

  /** The canvas the user is working in: the active file, else any open canvas. */
  private findActiveCanvas(): TFile | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "canvas") return activeFile;

    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const file = canvasViewOf(leaf).file;
      if (file instanceof TFile && file.extension === "canvas") return file;
    }
    return null;
  }

  /**
   * Read and parse a canvas file. Goes through `parseCanvasData` so that the
   * empty file Obsidian writes for a brand-new canvas reads as an empty graph
   * instead of throwing "Unexpected end of JSON input".
   */
  private async readCanvas<T = unknown>(file: TFile): Promise<CanvasData & T> {
    return parseCanvasData<T>(await this.app.vault.read(file), file.path);
  }

  /** Ask the user to pick one paper node from a canvas. */
  private pickPaperNode(fileNodes: CanvasNode[]): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (val: string | null) => {
        if (!resolved) { resolved = true; resolve(val); }
      };
      class PaperPicker extends FuzzySuggestModal<{ file: string; display: string }> {
        getItems() {
          return fileNodes.map((n) => ({
            file: n.file!,
            display: n.file!.replace(/.*\//, "").replace(/\.md$/, ""),
          }));
        }
        getItemText(item: { display: string }) {
          return item.display;
        }
        onChooseItem(item: { file: string }) {
          done(item.file);
        }
        onClose() {
          setTimeout(() => done(null), 50);
        }
      }
      new PaperPicker(this.app).open();
    });
  }

  /**
   * Resolve which canvas a per-paper command acts on and which papers it
   * targets: the canvas selection when there is one, else a single paper
   * chosen from a picker. Returns null after telling the user why there is
   * nothing to act on.
   */
  private async resolveCanvasTargets(overridePaths?: string[]): Promise<{
    canvasFile: TFile;
    canvasData: CanvasData & CanvasMeta;
    targetPaths: string[];
  } | null> {
    const canvasFile = this.findActiveCanvas();
    if (!canvasFile) {
      logNotice("Open a citation graph canvas first, then run this command.");
      return null;
    }

    const canvasData = await this.readCanvas<CanvasMeta>(canvasFile);

    const fileNodes = canvasData.nodes.filter((n) => n.type === "file" && n.file);
    if (fileNodes.length === 0) {
      logNotice("No paper nodes found on this canvas.");
      return null;
    }

    const targetPaths = this.resolveTargetPaths(fileNodes, overridePaths);
    if (targetPaths.length === 0) {
      const picked = await this.pickPaperNode(fileNodes);
      if (!picked) {
        logNotice("No paper selected.");
        return null;
      }
      targetPaths.push(picked);
    }

    return { canvasFile, canvasData, targetPaths };
  }

  // ─── Relayout Canvas ───────────────────────────────────────

  private async relayoutCanvas(): Promise<void> {
    try {
      // Find the canvas file
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      // Confirmation dialog
      const confirmed = await new Promise<boolean>((resolve) => {
        const modal = new Modal(this.app);
        modal.onOpen = () => {
          const { contentEl } = modal;
          modal.setTitle("Relayout canvas");
          contentEl.createEl("p", {
            text: "This will reset all node positions. Custom positioning will be lost.",
          });
          const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
          new ButtonComponent(footer)
            .setButtonText("Relayout")
            .setCta()
            .onClick(() => { resolve(true); modal.close(); });
          new ButtonComponent(footer)
            .setButtonText("Cancel")
            .onClick(() => modal.close());
        };
        modal.onClose = () => resolve(false);
        modal.open();
      });

      if (!confirmed) return;

      const canvasData = await this.readCanvas<CanvasMeta>(activeFile);

      const fileNodes = canvasData.nodes.filter((n) => n.type === "file" && n.file);
      if (fileNodes.length === 0) {
        logNotice("No paper nodes found on this canvas.");
        return;
      }

      // Rebuild Paper objects from note frontmatter
      const papers: Paper[] = [];
      for (const node of fileNodes) {
        const noteFile = this.app.vault.getAbstractFileByPath(node.file!);
        if (!(noteFile instanceof TFile)) continue;
        const cache = this.app.metadataCache.getFileCache(noteFile);
        const fm = cache?.frontmatter;
        if (!fm) continue;

        papers.push({
          id: fm.doi || fm.semantic_scholar_id || node.id,
          title: fm.title || "",
          authors: fm.authors || [],
          year: fm.year || 0,
          doi: fm.doi || null,
          arxiv: readFrontmatterArxiv(fm),
          citekey: fm.citekey || null,
          semanticScholarId: fm.semantic_scholar_id || null,
          abstract: null,
          citationCount: null,
          notePath: node.file!,
        });
      }

      if (papers.length === 0) {
        logNotice("Could not read paper metadata from notes.");
        return;
      }

      // Ensure all notes have the cssclass for hiding properties in canvas.
      // Done through processFrontMatter rather than a regex splice: the old
      // version appended a second `cssclasses:` key to notes that already had
      // one (duplicate YAML key), missed CRLF files because it anchored on
      // "---\n", and skipped notes whose *body* merely mentioned the class.
      const relayoutNotes = new LiteratureNoteManager(
        this.app,
        activeFile.parent?.path || normalizePath(this.settings.collectionsFolder)
      );
      for (const node of fileNodes) {
        const noteFile = this.app.vault.getAbstractFileByPath(node.file!);
        if (!(noteFile instanceof TFile)) continue;
        await relayoutNotes.ensureNoteClass(noteFile);
      }

      // Relayout with proper sizing
      const newNodes = layoutPapers(papers, {
        nodeWidth: this.settings.nodeWidth,
        nodeHeight: this.settings.nodeHeight,
      });

      // Build a map from node ID → new layout for file nodes
      const newLayoutById = new Map(newNodes.map((n) => [n.id, n]));

      // Colours are resolved before the canvas is opened for writing, which
      // happens synchronously and so cannot read notes.
      const colors = await this.resolveStatusColors(notePathsOf(canvasData.nodes));

      // Move the file nodes onto their new positions and leave every other
      // node where it is.
      await this.updateCanvas<CanvasMeta>(activeFile, (canvas) => {
        canvas.nodes = canvas.nodes.map((node) => {
          const updated = newLayoutById.get(node.id);
          return updated
            ? { ...node, x: updated.x, y: updated.y, width: updated.width, height: updated.height }
            : node;
        });
        paintStatusColors(canvas.nodes, colors);
      });
      logNotice(`Relayouted ${papers.length} papers chronologically.`);
    } catch (e) {
      console.error("Citation Graph: Error relayouting canvas", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Send Papers to Canvas ──────────────────────────────────

  private async sendPapersToCanvas(): Promise<void> {
    try {
      // 1. Find active canvas
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      // 2. Read source canvas
      const sourceData = await this.readCanvas<CanvasMeta>(activeFile);

      if (!sourceData.citationGraphMeta) {
        logNotice("This canvas is not a citation graph canvas.");
        return;
      }

      // 3. Build Paper objects from source canvas file nodes
      const fileNodes = sourceData.nodes.filter(
        (n) => n.type === "file" && n.file
      );
      if (fileNodes.length === 0) {
        logNotice("No paper nodes found on this canvas.");
        return;
      }

      const sourcePapers: Paper[] = [];
      for (const node of fileNodes) {
        const noteFile = this.app.vault.getAbstractFileByPath(node.file!);
        if (!(noteFile instanceof TFile)) continue;
        const cache = this.app.metadataCache.getFileCache(noteFile);
        const fm = cache?.frontmatter;
        if (!fm) continue;
        sourcePapers.push({
          id: fm.doi || fm.semantic_scholar_id || node.id,
          title: fm.title || "Untitled",
          authors: fm.authors || [],
          year: fm.year || 0,
          doi: fm.doi || null,
          arxiv: readFrontmatterArxiv(fm),
          citekey: fm.citekey || null,
          semanticScholarId: fm.semantic_scholar_id || null,
          abstract: null,
          citationCount: null,
          notePath: node.file!,
        });
      }

      if (sourcePapers.length === 0) {
        logNotice("Could not read paper metadata from notes.");
        return;
      }

      // 4. Check canvas selection first; fall back to picker modal
      let picked: { papers: Paper[]; nodeIds: Set<string> } | null = null;

      const selectedPaths = this.getSelectedCanvasPaths(fileNodes);

      if (selectedPaths.length > 0) {
        // Use canvas-selected papers directly
        const selectedSet = new Set(selectedPaths);
        const papers = sourcePapers.filter((p) => p.notePath && selectedSet.has(p.notePath));
        if (papers.length > 0) {
          // Resolved against the source canvas so these are the IDs its own
          // nodes and edges actually use, legacy scheme included.
          const sourceIds = new Set(sourceData.nodes.map((n) => n.id));
          picked = {
            papers,
            nodeIds: new Set(papers.map((p) => resolvePaperNodeId(p, sourceIds))),
          };
        }
      }

      if (!picked) {
        // Fall back to picker modal
        const sendModal = new SendPickerModal(this.app, sourcePapers, sourceData.nodes);
        picked = await sendModal.pickPapers();
      }
      if (!picked || picked.papers.length === 0) return;

      // 5. Show mode picker (copy / move)
      const mode = await new Promise<"copy" | "move" | null>((resolve) => {
        let resolved = false;
        const done = (val: "copy" | "move" | null) => {
          if (!resolved) {
            resolved = true;
            resolve(val);
          }
        };
        class ModePicker extends FuzzySuggestModal<{ id: "copy" | "move"; label: string }> {
          getItems() {
            return [
              { id: "copy" as const, label: "Copy (keep on this canvas)" },
              { id: "move" as const, label: "Move (remove from this canvas)" },
            ];
          }
          getItemText(item: { label: string }) {
            return item.label;
          }
          onChooseItem(item: { id: "copy" | "move" }) {
            done(item.id);
          }
          onClose() {
            setTimeout(() => done(null), 50);
          }
        }
        new ModePicker(this.app).open();
      });
      if (!mode) return;

      // 6. Discover target canvases (all .canvas files excluding current)
      const targetCanvases = this.app.vault
        .getFiles()
        .filter((f) => f.extension === "canvas" && f.path !== activeFile.path);

      if (targetCanvases.length === 0) {
        logNotice("No other canvases found in the vault.");
        return;
      }

      // 7. Show target canvas picker
      const targetFile = await new Promise<TFile | null>((resolve) => {
        let resolved = false;
        const done = (val: TFile | null) => {
          if (!resolved) {
            resolved = true;
            resolve(val);
          }
        };
        class CanvasPicker extends FuzzySuggestModal<TFile> {
          getItems() {
            return targetCanvases;
          }
          getItemText(file: TFile) {
            return file.basename;
          }
          onChooseItem(file: TFile) {
            done(file);
          }
          onClose() {
            setTimeout(() => done(null), 50);
          }
        }
        new CanvasPicker(this.app).open();
      });
      if (!targetFile) return;

      // 8. Read target canvas
      const targetData = await this.readCanvas<CanvasMeta>(targetFile);

      // 9. Compute edges to carry over.
      // The same paper can sit under different node IDs on the two canvases:
      // whichever was written first may still use the legacy scheme. Carried
      // edges therefore have to be rewritten from source IDs to the IDs the
      // nodes will have on the target, or they would point at nodes that are
      // not there.
      const selectedNodeIds = picked.nodeIds;
      const sourceNodeIds = new Set(sourceData.nodes.map((n) => n.id));
      const targetNodeIds = new Set(targetData.nodes.map((n) => n.id));

      const sourceToTargetId = new Map<string, string>();
      for (const p of picked.papers) {
        sourceToTargetId.set(
          resolvePaperNodeId(p, sourceNodeIds),
          resolvePaperNodeId(p, targetNodeIds)
        );
      }
      const toTargetId = (id: string): string => sourceToTargetId.get(id) ?? id;

      const willExistOnTarget = new Set([
        ...targetNodeIds,
        ...sourceToTargetId.values(),
      ]);

      const targetEdgeKeys = new Set(
        targetData.edges.map((e) => `${e.fromNode}->${e.toNode}`)
      );

      const edgesToAdd: CanvasEdge[] = [];
      for (const edge of sourceData.edges) {
        const fromNode = toTargetId(edge.fromNode);
        const toNode = toTargetId(edge.toNode);
        if (!willExistOnTarget.has(fromNode) || !willExistOnTarget.has(toNode)) continue;
        const key = `${fromNode}->${toNode}`;
        if (targetEdgeKeys.has(key)) continue;
        targetEdgeKeys.add(key);
        // Regenerate the id from the rewritten endpoints, matching how
        // buildCanvas names edges, so a carried edge cannot collide with an
        // unrelated edge id already on the target.
        edgesToAdd.push({ ...edge, id: `edge-${key}`, fromNode, toNode });
      }

      // 10. Layout new papers on target canvas
      const allPapersMap = new Map<string, Paper>();

      // Papers from target canvas
      for (const node of targetData.nodes) {
        if (node.type !== "file" || !node.file) continue;
        const noteFile = this.app.vault.getAbstractFileByPath(node.file);
        if (!(noteFile instanceof TFile)) continue;
        const cache = this.app.metadataCache.getFileCache(noteFile);
        const fm = cache?.frontmatter;
        if (!fm) continue;
        const paper: Paper = {
          id: fm.doi || fm.semantic_scholar_id || node.id,
          title: fm.title || "Untitled",
          authors: fm.authors || [],
          year: fm.year || 0,
          doi: fm.doi || null,
          arxiv: readFrontmatterArxiv(fm),
          citekey: fm.citekey || null,
          semanticScholarId: fm.semantic_scholar_id || null,
          abstract: null,
          citationCount: null,
          notePath: node.file,
        };
        allPapersMap.set(paper.id, paper);
      }

      // Add selected papers
      for (const p of picked.papers) {
        allPapersMap.set(p.id, p);
      }

      // Filter to papers not already on target
      const trulyNewPapers = picked.papers.filter(
        (p) => !hasPaperNode(p, targetNodeIds)
      );

      // 11. Colours are resolved before either canvas is opened for writing,
      //     which happens synchronously and so cannot read notes.
      const colors = await this.resolveStatusColors(
        trulyNewPapers.map((p) => p.notePath).filter((p): p is string => !!p)
      );

      // 12. Write updated target canvas. The layout and the duplicate-edge
      //     check both run against the target as it stands at write time, so
      //     anything added to it while the pickers were open survives.
      let added = 0;
      await this.updateCanvas<CanvasMeta>(targetFile, (canvas) => {
        const { updatedExisting, newNodes } = layoutNewPapers(
          canvas.nodes,
          trulyNewPapers,
          allPapersMap,
          {
            nodeWidth: this.settings.nodeWidth,
            nodeHeight: this.settings.nodeHeight,
          }
        );
        paintStatusColors(newNodes, colors);
        added = newNodes.length;

        const present = new Set(
          canvas.edges.map((e) => `${e.fromNode}->${e.toNode}`)
        );
        return {
          ...canvas,
          nodes: [...updatedExisting, ...newNodes],
          edges: [
            ...canvas.edges,
            ...edgesToAdd.filter(
              (e) => !present.has(`${e.fromNode}->${e.toNode}`)
            ),
          ],
        };
      });

      // 13. If move, update source canvas
      if (mode === "move") {
        await this.updateCanvas<CanvasMeta>(activeFile, (canvas) => {
          canvas.nodes = canvas.nodes.filter((n) => !selectedNodeIds.has(n.id));
          canvas.edges = canvas.edges.filter(
            (e) =>
              !selectedNodeIds.has(e.fromNode) && !selectedNodeIds.has(e.toNode)
          );
        });
      }

      // 14. Confirmation notice
      const verb = mode === "move" ? "Moved" : "Copied";
      const skipped = picked.papers.length - added;
      let msg = `${verb} ${added} paper${added !== 1 ? "s" : ""} to ${targetFile.basename}`;
      if (skipped > 0) msg += ` (${skipped} already existed)`;
      if (edgesToAdd.length > 0) msg += `, ${edgesToAdd.length} edge${edgesToAdd.length !== 1 ? "s" : ""} added`;
      logNotice(msg);
    } catch (e) {
      console.error("Citation Graph: Error sending papers to canvas", e);
      logNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Write Summary ──────────────────────────────────────────

  private async writeSummary(paths?: string[]): Promise<void> {
    try {
      // 1. Find active canvas
      const activeFile = this.findActiveCanvas();
      if (!activeFile) {
        logNotice("Open a citation graph canvas first, then run this command.");
        return;
      }

      const canvasData = await this.readCanvas<CanvasMeta>(activeFile);

      const fileNodes = canvasData.nodes.filter(
        (n) => n.type === "file" && n.file
      );
      if (fileNodes.length === 0) {
        logNotice("No paper nodes found on this canvas.");
        return;
      }

      // 2. Get target nodes (supports multiple)
      const selectedPaths = this.resolveTargetPaths(fileNodes, paths);
      let targetPaths: string[];

      if (selectedPaths.length > 0) {
        targetPaths = selectedPaths;
      } else {
        // Fall back to fuzzy picker if no selection
        const picked = await new Promise<string | null>((resolve) => {
          let resolved = false;
          const done = (val: string | null) => {
            if (!resolved) { resolved = true; resolve(val); }
          };
          class PaperPicker extends FuzzySuggestModal<{ file: string; display: string }> {
            getItems() {
              return fileNodes.map((n) => ({
                file: n.file!,
                display: n.file!.replace(/.*\//, "").replace(/\.md$/, ""),
              }));
            }
            getItemText(item: { display: string }) {
              return item.display;
            }
            onChooseItem(item: { file: string }) {
              done(item.file);
            }
            onClose() {
              setTimeout(() => done(null), 50);
            }
          }
          new PaperPicker(this.app).open();
        });
        if (!picked) return;
        targetPaths = [picked];
      }

      // 3. Build Paper objects from frontmatter
      const papers: Paper[] = [];
      for (const tp of targetPaths) {
        const noteFile = this.app.vault.getAbstractFileByPath(tp);
        if (!(noteFile instanceof TFile)) continue;
        const cache = this.app.metadataCache.getFileCache(noteFile);
        const fm = cache?.frontmatter;
        if (!fm) continue;
        papers.push({
          id: fm.doi || fm.semantic_scholar_id || "",
          title: fm.title || "Untitled",
          authors: fm.authors || [],
          year: fm.year || 0,
          doi: fm.doi || null,
          arxiv: readFrontmatterArxiv(fm),
          citekey: fm.citekey || null,
          semanticScholarId: fm.semantic_scholar_id || null,
          abstract: null,
          citationCount: null,
          notePath: tp,
        });
      }

      if (papers.length === 0) {
        logNotice("Could not read paper metadata from selected notes.");
        return;
      }

      const lastDownloadPath = canvasData.citationGraphMeta?.lastDownloadPath || "";
      await this.summarizePapersWithPdfs(papers, lastDownloadPath);
    } catch (e) {
      console.error("Citation Graph: Error writing summary", e);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENOENT") && msg.includes("claude")) {
        logNotice("Claude CLI not found. Make sure Claude Code is installed and 'claude' is on your PATH.");
      } else if (msg.includes("TIMEOUT") || msg.includes("timed out")) {
        logNotice("Summary generation timed out.");
      } else {
        logNotice(`Error: ${msg}`);
      }
    }
  }

  /**
   * Core summarization pipeline: resolve PDFs, handle missing ones,
   * warn about long papers, and run the LLM on each.
   */
  private async summarizePapersWithPdfs(
    papers: Paper[],
    downloadPath: string,
  ): Promise<void> {
    // 1. Resolve PDF paths for all papers
    const withPdf: { paper: Paper; pdfPath: string }[] = [];
    const missingPdf: Paper[] = [];

    for (const paper of papers) {
      const pdfFilename = buildPaperFilename(paper, ".pdf");
      let pdfPath: string | null = null;

      if (downloadPath) {
        const candidate = path.join(expandTilde(downloadPath), pdfFilename);
        if (fs.existsSync(candidate)) pdfPath = candidate;
      }
      if (!pdfPath && this.settings.defaultDownloadPath) {
        const candidate = path.join(expandTilde(this.settings.defaultDownloadPath), pdfFilename);
        if (fs.existsSync(candidate)) pdfPath = candidate;
      }

      if (pdfPath) {
        withPdf.push({ paper, pdfPath });
      } else {
        missingPdf.push(paper);
      }
    }

    // 2. Handle missing PDFs (batch modal)
    if (missingPdf.length > 0) {
      const downloadDir = this.settings.defaultDownloadPath;
      if (!downloadDir) {
        logNotice(
          `${missingPdf.length} paper${missingPdf.length > 1 ? "s" : ""} missing PDFs ` +
          "and no default download path configured. Skipping those."
        );
      } else {
        const choice = await new BatchMissingPdfModal(this.app, missingPdf).pick();
        if (choice === null) return;

        if (choice === "download") {
          const pluginDir = this.absolutePluginDir();
          if (!pluginDir) {
            logNotice("Downloading needs a vault stored in the local filesystem.");
            return;
          }

          logNotice(`Downloading ${missingPdf.length} PDF${missingPdf.length > 1 ? "s" : ""}...`);
          const { resolvedArxiv } = await downloadPapers(
            missingPdf,
            downloadDir,
            pluginDir,
            {
              onProgress: (done, total, title) => {
                logNotice(`Downloading ${done + 1}/${total}: ${title}`);
              },
              resolveArxiv: (paper) => this.findArxivId(paper),
            },
          );
          await this.recordArxivIds(resolvedArxiv);

          // Re-resolve paths for the ones we tried to download
          for (const paper of missingPdf) {
            const pdfFilename = buildPaperFilename(paper, ".pdf");
            const candidate = path.join(downloadDir, pdfFilename);
            if (fs.existsSync(candidate)) {
              withPdf.push({ paper, pdfPath: candidate });
            }
          }
        }
        // "skip" falls through: missingPdf papers are simply not in withPdf
      }
    }

    if (withPdf.length === 0) {
      logNotice("No papers with available PDFs to summarize.");
      return;
    }

    // 3. Estimate page counts and warn about long papers
    const resolved: { paper: Paper; pdfPath: string; pages: number }[] = [];
    const longPapers: { title: string; pages: number }[] = [];

    for (const { paper, pdfPath } of withPdf) {
      let pages = 0;
      try {
        pages = estimatePdfPages(pdfPath);
      } catch (e) {
        // An unreadable PDF fails later with a clearer, per-paper message;
        // treat the page count as unknown rather than aborting the batch.
        console.warn(`Citation Graph: could not estimate pages for ${pdfPath}`, e);
      }
      resolved.push({ paper, pdfPath, pages });
      if (pages > 10) {
        longPapers.push({ title: paper.title, pages });
      }
    }

    if (longPapers.length > 0) {
      const proceed = await new BatchLongPaperWarningModal(this.app, longPapers).pick();
      if (!proceed) return;
    }

    // 4. Determine summary mode for papers with existing summaries
    let batchSummaryMode: "new" | "append" | "replace" = "new";
    let withSummaryCount = 0;

    for (const { paper } of resolved) {
      const noteFile = this.app.vault.getAbstractFileByPath(paper.notePath!);
      if (!(noteFile instanceof TFile)) continue;
      const content = await this.app.vault.read(noteFile);
      if (hasSummarySection(content)) withSummaryCount++;
    }

    if (withSummaryCount > 0) {
      const choice = await new BatchSummaryModeModal(
        this.app, withSummaryCount, resolved.length
      ).pick();
      if (choice === null) return;
      batchSummaryMode = choice;
    }

    // 5. Process each paper with progress modal
    const progressModal = new SummaryProgressModal(
      this.app, resolved.length, this.settings.llmBatchTokenBudget,
    );
    progressModal.open();

    let completed = 0;
    let failed = 0;
    let totalTokens = 0;

    for (let i = 0; i < resolved.length; i++) {
      if (progressModal.isCancelled) {
        logNotice("Batch summarization cancelled by user.");
        break;
      }

      const { paper, pdfPath } = resolved[i];

      // Check token budget before each call
      if (this.settings.llmBatchTokenBudget > 0 &&
          totalTokens >= this.settings.llmBatchTokenBudget) {
        logNotice(`Token budget reached (${totalTokens.toLocaleString()} tokens). Stopping batch.`);
        break;
      }

      progressModal.update(i + 1, paper.title, totalTokens);
      logNotice(`Summarizing ${i + 1}/${resolved.length}: ${paper.title}`);

      try {
        const result = await summarizePaper(paper, pdfPath, resolveApiKeys(this.settings));
        totalTokens += result.inputTokens + result.outputTokens;

        if (!result.text) {
          logNotice(`LLM returned an empty response for "${paper.title}".`);
          progressModal.logItem(paper.title, false);
          failed++;
          continue;
        }

        // Insert the summary into the note. The read and the write happen
        // together under the vault's write lock: a single call can take
        // minutes, and anything the user typed into the note meanwhile would
        // otherwise be overwritten by a stale copy.
        const noteFile = this.app.vault.getAbstractFileByPath(paper.notePath!);
        if (!(noteFile instanceof TFile)) {
          progressModal.logItem(paper.title, false);
          failed++;
          continue;
        }
        await this.app.vault.process(noteFile, (noteContent) =>
          insertSummaryText(
            noteContent,
            result.text,
            hasSummarySection(noteContent) ? batchSummaryMode : "new"
          )
        );
        completed++;
        progressModal.logItem(paper.title, true);
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        logNotice(`Failed to summarize "${paper.title}": ${msg}`);
        progressModal.logItem(paper.title, false);
      }
    }

    progressModal.showComplete(completed, failed, totalTokens);

    // 6. Report results (also logged so they appear in citation-graph.log)
    if (resolved.length === 1 && completed === 1) {
      logNotice(`Summary written for "${resolved[0].paper.title}".`);
    } else if (resolved.length > 1) {
      logNotice(
        `Summaries complete: ${completed} succeeded` +
        (failed > 0 ? `, ${failed} failed` : "") +
        `. Tokens: ${totalTokens.toLocaleString()}.`
      );
    }
  }
}

/**
 * Above this size, skip the page estimate entirely. The scan needs the whole
 * file in memory as a latin1 string on top of the Buffer it was read from --
 * roughly 2x the file size in the renderer -- for a number that only decides
 * whether to show a "this paper is long" warning.
 */
const MAX_PAGE_SCAN_BYTES = 64 * 1024 * 1024;

/** Rough page count from the number of "/Type /Page" markers; 0 if unknown. */
function estimatePdfPages(pdfPath: string): number {
  if (fs.statSync(pdfPath).size > MAX_PAGE_SCAN_BYTES) return 0;
  const matches = fs.readFileSync(pdfPath).toString("latin1").match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

// ─── DOI Input Modal ────────────────────────────────────────

class DoiInputModal extends Modal {
  private resolve: (doi: string | null) => void;

  constructor(app: import("obsidian").App, resolve: (doi: string | null) => void) {
    super(app);
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Add paper");

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "DOI, arxiv ID, or URL",
      cls: "citation-graph-doi-input",
    });

    const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
    new ButtonComponent(footer)
      .setButtonText("Add")
      .setCta()
      .onClick(() => {
        const doi = input.value.trim();
        if (!doi) {
          logNotice("Please enter a DOI.");
          return;
        }
        this.resolve(doi);
        this.resolve = () => {};
        this.close();
      });
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.close());

    // Submit on Enter
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const doi = input.value.trim();
        if (doi) {
          this.resolve(doi);
          this.resolve = () => {};
          this.close();
        }
      }
    });

    setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.resolve(null);
    this.contentEl.empty();
  }
}

// ─── Helpers ────────────────────────────────────────────────

function zoteroItemToPaper(item: ZoteroItem): Paper | null {
  const doi = ZoteroClient.extractDOI(item);
  const arxiv = ZoteroClient.extractArXiv(item);
  const citekey = ZoteroClient.extractCitekey(item);

  // Need at least a DOI or arXiv to query Semantic Scholar
  if (!doi && !arxiv) return null;

  const id = doi || arxiv || item.data.key;
  const authors = item.data.creators
    .filter((c) => c.creatorType === "author")
    .map((c) => {
      if (c.name) return c.name;
      return `${c.firstName || ""} ${c.lastName || ""}`.trim();
    });

  // Parse year from date field
  let year = 0;
  if (item.data.date) {
    const match = item.data.date.match(/(\d{4})/);
    if (match) year = parseInt(match[1], 10);
  }

  return {
    id,
    title: item.data.title || "Untitled",
    authors,
    year,
    doi,
    arxiv,
    citekey,
    semanticScholarId: null,
    abstract: null,
    citationCount: null,
    notePath: null,
  };
}

function paperToZoteroItem(p: {
  title: string;
  authors: string[];
  year: number;
  doi: string | null;
}) {
  return {
    title: p.title,
    creators: p.authors.map((name) => {
      const parts = name.split(" ");
      const lastName = parts.pop() || "";
      const firstName = parts.join(" ");
      return { creatorType: "author" as const, firstName, lastName };
    }),
    date: String(p.year || ""),
    DOI: p.doi || undefined,
  };
}

/**
 * Sanitize a user-supplied name (e.g. Zotero collection name) for use as a
 * vault folder. Strips characters illegal on Windows or iCloud-synced vaults
 * and trims trailing dots/spaces, which Windows also rejects.
 */
function sanitizeVaultFolderName(name: string): string {
  const trimmed = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return trimmed || "untitled";
}

function s2PaperToPaper(s2: S2Paper): Paper {
  const doi = s2.externalIds?.DOI || null;
  const arxiv = s2.externalIds?.ArXiv || null;
  const id = doi || arxiv || s2.paperId;

  // Synthetic paperIds (from OpenAlex/CrossRef/arXiv fallbacks) are not real
  // Semantic Scholar IDs and shouldn't be persisted as such — they'd never
  // line up with future S2 lookups in the vault.
  const isSyntheticId =
    s2.paperId.startsWith("doi:") ||
    s2.paperId.startsWith("openalex:") ||
    s2.paperId.startsWith("arxiv:") ||
    s2.paperId.startsWith("crossref:");

  return {
    id,
    title: s2.title || "Untitled",
    authors: (s2.authors || []).map((a) => a.name),
    year: s2.year || 0,
    doi,
    arxiv,
    citekey: null,
    semanticScholarId: isSyntheticId ? null : s2.paperId,
    abstract: s2.abstract || null,
    citationCount: s2.citationCount ?? null,
    notePath: null,
  };
}

/** Build identifier sets (S2 / DOI / arXiv) from a list of related papers
 *  so we can match against existing canvas notes by any available ID. */
function collectRefIdentifiers(papers: S2Paper[]): {
  s2: Set<string>;
  doi: Set<string>;
  arxiv: Set<string>;
} {
  const s2 = new Set<string>();
  const doi = new Set<string>();
  const arxiv = new Set<string>();
  for (const p of papers) {
    if (!p) continue;
    // Skip synthetic paperIds — they would never match a real S2 ID stored
    // in a literature note's frontmatter
    if (
      p.paperId &&
      !p.paperId.startsWith("doi:") &&
      !p.paperId.startsWith("openalex:") &&
      !p.paperId.startsWith("arxiv:") &&
      !p.paperId.startsWith("crossref:")
    ) {
      s2.add(p.paperId);
    }
    if (p.externalIds?.DOI) doi.add(p.externalIds.DOI.toLowerCase());
    if (p.externalIds?.ArXiv) arxiv.add(p.externalIds.ArXiv);
  }
  return { s2, doi, arxiv };
}
