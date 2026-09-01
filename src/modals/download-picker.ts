import { Modal, ButtonComponent, Notice } from "obsidian";
import { logNotice } from "../log";
import type { App } from "obsidian";
import type { Paper } from "../types";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as https from "https";
import { getDownloadFallback } from "../api/fallback-source";
// Matches arxiv IDs: new format "2301.01234" or old format "quant-ph/0601075"
const ARXIV_PATTERN = /^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+\/\d{7}(v\d+)?$/;

/**
 * Expand a leading "~" to the user's home directory. Node's fs/path never do
 * this (it is a shell convention), so an unexpanded "~/papers" would otherwise
 * create a literal "~" folder in the cwd. Bare "~" and "~/..." are handled;
 * "~user" syntax is not (we have no way to resolve other users' homes here).
 */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function isValidArxivId(id: string): boolean {
  return ARXIV_PATTERN.test(id);
}

/** Sanitize a string for use as a filename: remove/replace problematic chars. */
export function sanitizeFilename(name: string): string {
  return name
    // Windows-illegal set plus control characters
    // eslint-disable-next-line no-control-regex -- illegal in filenames, matched on purpose
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    // Strip trailing dots/spaces which Windows also rejects
    .replace(/[. ]+$/g, "")
    .trim();
}

/**
 * Most filesystems cap a single name at 255 *bytes* (ext4, APFS) or 255 UTF-16
 * units (NTFS). Paper titles regularly run past that, and the resulting
 * ENAMETOOLONG surfaces as an opaque per-paper download failure.
 */
const MAX_FILENAME_BYTES = 200;

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
  return out.trimEnd();
}

/** Build a formatted filename: "Title (FirstAuthor) (Year).ext" */
export function buildPaperFilename(paper: Paper, originalPath: string): string {
  const ext = path.extname(originalPath) || ".pdf";
  const firstAuthor = paper.authors.length > 0
    ? sanitizeFilename(paper.authors[0]) || "Unknown"
    : "Unknown";
  const year = paper.year || "Unknown";
  const suffix = ` (${firstAuthor}) (${year})${ext}`;
  // Give the title whatever budget the fixed suffix leaves. Sanitize again
  // after truncating: cutting mid-string can expose a new trailing dot/space.
  const budget = Math.max(16, MAX_FILENAME_BYTES - Buffer.byteLength(suffix, "utf8"));
  const title =
    sanitizeFilename(truncateToBytes(sanitizeFilename(paper.title || ""), budget)) ||
    "Untitled";
  return `${title}${suffix}`;
}

interface DownloadChoice {
  paper: Paper;
  selected: boolean;
  alreadyDownloaded: boolean;
  /**
   * Whether a source is already known for this paper, without asking anyone.
   *
   * False does not mean unavailable: a paper stored under the DOI of its
   * published version usually has no arXiv ID recorded and is on arXiv all the
   * same. Those rows stay selectable, and the download run looks the paper up
   * before giving up on it. What this decides is only what gets ticked by
   * default, so a large canvas does not open with dozens of lookups queued.
   */
  knownSource: boolean;
}

export interface DownloadPickerResult {
  downloadPath: string;
  papers: Paper[];
}

/**
 * Modal for selecting papers to download.
 * Shows checkboxes for each paper on the canvas, a "Select All" button,
 * and a download path input pre-filled with the last used path.
 */
export class DownloadPickerModal extends Modal {
  private choices: DownloadChoice[] = [];
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private downloadPath: string;
  /** Pending debounced rescan of the download folder; cleared on close. */
  private rescanTimer: number | null = null;

  private resolvePromise: ((result: DownloadPickerResult | null) => void) | null = null;

  constructor(
    app: App,
    private papers: Paper[],
    lastDownloadPath: string,
  ) {
    super(app);
    this.downloadPath = lastDownloadPath || "";
  }

  /**
   * Scan the download directory for papers that are already there. Anything
   * this plugin downloaded was renamed to the formatted filename, so that is
   * the primary match; a DOI with "/" and "." replaced by "_" is also checked,
   * since files fetched by other tools are commonly named after the DOI.
   */
  private checkAlreadyDownloaded(): void {
    let existingFiles: string[] = [];
    const resolvedPath = this.downloadPath ? expandTilde(this.downloadPath) : "";
    if (resolvedPath && fs.existsSync(resolvedPath)) {
      try {
        existingFiles = fs.readdirSync(resolvedPath).map((f) => f.toLowerCase());
      } catch {
        // can't read dir, treat as empty
      }
    }

    const fallback = getDownloadFallback();

    this.choices = this.papers.map((paper) => {
      const knownSource =
        (!!paper.arxiv && isValidArxivId(paper.arxiv)) ||
        (fallback !== null && fallback.canAttempt(paper));

      let alreadyDownloaded = false;
      if (existingFiles.length > 0) {
        const formatted = buildPaperFilename(paper, ".pdf").toLowerCase();
        alreadyDownloaded = existingFiles.includes(formatted);
        if (!alreadyDownloaded && paper.doi) {
          const doiPattern = paper.doi.toLowerCase().replace(/[./]/g, "_");
          alreadyDownloaded = existingFiles.some((f) => f.includes(doiPattern));
        }
      }

      return {
        paper,
        selected: !alreadyDownloaded && knownSource,
        alreadyDownloaded,
        knownSource,
      };
    });

    // Sort: ready to download first, then already downloaded, then the ones
    // that need looking up.
    this.choices.sort((a, b) => {
      if (a.knownSource !== b.knownSource) return a.knownSource ? -1 : 1;
      if (a.alreadyDownloaded !== b.alreadyDownloaded) return a.alreadyDownloaded ? 1 : -1;
      return (a.paper.title || "").localeCompare(b.paper.title || "");
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-download-modal");

    this.setTitle("Download papers");

    // Download path row. The native folder picker used to live here but
    // electron.remote was removed in Electron 14, so the button was silently
    // a no-op in modern Obsidian. Users type or paste the path instead.
    const pathRow = contentEl.createDiv("citation-graph-download-path-row");
    pathRow.createEl("label", { text: "Download to:", cls: "citation-graph-download-label" });
    const pathInput = pathRow.createEl("input", {
      type: "text",
      cls: "citation-graph-download-path-input",
      value: this.downloadPath,
      placeholder: "~/Downloads/papers",
    });
    contentEl.createDiv({
      cls: "citation-graph-download-path-hint",
      text: "Use an absolute path, or start with ~ for your home directory (e.g. ~/Downloads/papers).",
    });
    // Debounced: checkAlreadyDownloaded does a synchronous existsSync +
    // readdirSync, which blocks the UI thread. Running it per keystroke
    // freezes the modal on large or network-mounted folders.
    pathInput.addEventListener("input", () => {
      this.downloadPath = pathInput.value.trim();
      if (this.rescanTimer) window.clearTimeout(this.rescanTimer);
      this.rescanTimer = window.setTimeout(() => {
        this.rescanTimer = null;
        this.checkAlreadyDownloaded();
        this.renderList();
      }, 300);
    });

    // Run initial check
    this.checkAlreadyDownloaded();

    // Select all / deselect all buttons
    const actionRow = contentEl.createDiv("citation-graph-download-actions");
    new ButtonComponent(actionRow)
      .setButtonText("Select all")
      .onClick(() => {
        for (const c of this.choices) {
          if (!c.alreadyDownloaded) c.selected = true;
        }
        this.renderList();
      });
    new ButtonComponent(actionRow)
      .setButtonText("Deselect all")
      .onClick(() => {
        for (const c of this.choices) c.selected = false;
        this.renderList();
      });

    // Count
    this.countEl = contentEl.createDiv("citation-graph-count");
    this.updateCount();

    // Scrollable list
    this.listEl = contentEl.createDiv("citation-graph-paper-list");
    this.renderList();

    // Footer
    const footer = contentEl.createDiv("citation-graph-footer");
    new ButtonComponent(footer)
      .setButtonText("Download")
      .setCta()
      .onClick(() => {
        if (!this.downloadPath) {
          logNotice("Please specify a download path.");
          return;
        }
        const selected = this.choices
          .filter((c) => c.selected && !c.alreadyDownloaded)
          .map((c) => c.paper);
        if (selected.length === 0) {
          logNotice("No papers selected for download.");
          return;
        }
        if (this.resolvePromise) {
          this.resolvePromise({ downloadPath: this.downloadPath, papers: selected });
          this.resolvePromise = null;
        }
        this.close();
      });
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.close());
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const total = this.choices.length;
    const needLookup = this.choices.filter(
      (c) => !c.knownSource && !c.alreadyDownloaded
    ).length;
    const downloaded = this.choices.filter((c) => c.alreadyDownloaded).length;
    const selected = this.choices.filter(
      (c) => c.selected && !c.alreadyDownloaded
    ).length;

    let text = `${total} papers`;
    if (downloaded > 0) text += ` · ${downloaded} already downloaded`;
    if (needLookup > 0) text += ` · ${needLookup} to look up on arXiv`;
    text += ` · ${selected} selected`;
    this.countEl.setText(text);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    for (const choice of this.choices) {
      const rowCls = [
        "citation-graph-paper-row",
        choice.alreadyDownloaded ? "is-downloaded" : "",
        !choice.knownSource ? "is-no-source" : "",
      ].filter(Boolean).join(" ");

      const row = this.listEl.createDiv(rowCls);

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = choice.selected || choice.alreadyDownloaded;
      checkbox.disabled = choice.alreadyDownloaded;
      checkbox.addEventListener("change", () => {
        choice.selected = checkbox.checked;
        this.updateCount();
      });

      const info = row.createDiv("citation-graph-paper-info");
      info.createEl("strong", { text: choice.paper.title || "Untitled" });
      const meta = info.createDiv("citation-graph-paper-meta");
      const authors = choice.paper.authors.slice(0, 3).join(", ");
      const authorSuffix = choice.paper.authors.length > 3
        ? ` +${choice.paper.authors.length - 3}`
        : "";
      meta.createSpan({
        text: `${authors}${authorSuffix} · ${choice.paper.year || "?"}`,
      });
      if (choice.paper.doi) {
        meta.createSpan({ text: ` · ${choice.paper.doi}`, cls: "citation-graph-doi" });
      }

      const rightActions = row.createDiv("citation-graph-row-actions");
      if (choice.alreadyDownloaded) {
        const badge = rightActions.createDiv("citation-graph-badge citation-graph-badge-downloaded");
        badge.setText("Downloaded");
      } else if (!choice.knownSource) {
        const badge = rightActions.createDiv("citation-graph-badge citation-graph-badge-nosource");
        badge.setText("No ID yet");
        badge.title =
          "No arXiv ID recorded for this paper. Selecting it searches arXiv by title before giving up.";
      }
    }

    this.updateCount();
  }

  onClose(): void {
    if (this.rescanTimer) {
      window.clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  pickPapers(): Promise<DownloadPickerResult | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Download papers sequentially. Tries arXiv first (when an arXiv ID is
 * available), then the configured fallback source if this build has one (see
 * ../api/download-fallback). Papers no source can supply are reported as
 * failed with the reason.
 *
 * `pluginDir` is the absolute path to the plugin's own directory; a fallback
 * receives it so it can locate helper files bundled alongside the plugin.
 *
 * `resolveArxiv` is asked for an arXiv ID whenever a paper carries none, so a
 * paper stored under the DOI of its published version is looked up rather than
 * written off. Any ID it finds comes back in `resolvedArxiv`, keyed by note
 * path, for the caller to record so the next run needs no lookup.
 */
export interface DownloadOptions {
  onProgress?: (done: number, total: number, title: string) => void;
  resolveArxiv?: (paper: Paper) => Promise<string | null>;
}

export interface DownloadOutcome {
  downloaded: number;
  failed: string[];
  /** Note path → the arXiv ID a lookup turned up for it during this run. */
  resolvedArxiv: Map<string, string>;
}

export async function downloadPapers(
  papers: Paper[],
  downloadPath: string,
  pluginDir: string,
  opts: DownloadOptions = {}
): Promise<DownloadOutcome> {
  const { onProgress, resolveArxiv } = opts;
  const resolvedArxiv = new Map<string, string>();
  // Resolve a leading "~" before any filesystem use; fs/path don't do this.
  downloadPath = expandTilde(downloadPath);
  // Validate the download folder up-front: a bad path would otherwise fail
  // every paper one-by-one with the same opaque error.
  try {
    fs.mkdirSync(downloadPath, { recursive: true });
    fs.accessSync(downloadPath, fs.constants.W_OK);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    logNotice(`Cannot use download folder "${downloadPath}": ${reason}`, 10000);
    return { downloaded: 0, failed: papers.map((p) => p.title), resolvedArxiv };
  }

  // Probe the fallback once and gate every per-paper attempt on the result:
  // the probe can be slow (it spawns an interactive shell) and its answer is
  // the same for every paper in the run.
  const fallback = getDownloadFallback();
  const fallbackAvailable = fallback !== null && (await fallback.isAvailable());
  // Track whether we've already surfaced a fallback setup error so we don't
  // spam the user with one Notice per paper for the same root cause.
  let setupErrorShown = false;

  let downloaded = 0;
  const failed: string[] = [];

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    if (onProgress) onProgress(i, papers.length, paper.title);

    try {
      let savedPath: string | null = null;
      let fallbackError: Error | null = null;
      let arxivError: string | null = null;

      // arXiv is always tried first, and a paper with no recorded arXiv ID is
      // looked up rather than passed over: the ID is missing far more often
      // than the preprint is.
      let arxivId = paper.arxiv && isValidArxivId(paper.arxiv) ? paper.arxiv : null;
      let lookedUp = false;
      if (!arxivId && resolveArxiv) {
        logNotice(`Searching arXiv for "${paper.title}"...`);
        arxivId = await resolveArxiv(paper);
        lookedUp = true;
        if (arxivId) {
          paper.arxiv = arxivId;
          if (paper.notePath) resolvedArxiv.set(paper.notePath, arxivId);
          logNotice(`Found on arXiv (${arxivId}): ${paper.title}`);
        }
      }

      if (arxivId) {
        try {
          savedPath = await downloadFromArxiv(arxivId, downloadPath);
          logNotice(`Downloaded from arxiv: ${paper.title}`);
        } catch (arxivErr) {
          arxivError = arxivErr instanceof Error ? arxivErr.message : String(arxivErr);
          console.warn(`Citation Graph: arxiv download failed for "${paper.title}": ${arxivError}`);
        }
      }

      if (!savedPath && fallback !== null && fallbackAvailable && fallback.canAttempt(paper)) {
        try {
          savedPath = await fallback.download(paper, downloadPath, { pluginDir });
          if (savedPath) logNotice(`Downloaded from ${fallback.name}: ${paper.title}`);
        } catch (e) {
          fallbackError = e instanceof Error ? e : new Error(String(e));
        }
      }

      if (!savedPath) {
        const arxivSuffix = arxivError ? ` (arXiv attempt: ${arxivError})` : "";
        // Distinguish "arXiv does not have it" from "we never had an ID to
        // try": the first is an answer, the second used to be reported as one.
        const arxivVerdict = arxivError
          ? "The arXiv download failed"
          : lookedUp
            ? "Not on arXiv: searched by DOI and by title"
            : "No arXiv version found";

        if (fallbackError !== null && fallback !== null) {
          // Suppress duplicate setup errors (a missing prerequisite, an
          // unwritable folder) after the first paper — they apply to every
          // paper in the run, not just this one.
          const isSetup = fallback.isSetupError(fallbackError.message);
          if (isSetup && setupErrorShown) {
            failed.push(paper.title);
            continue;
          }
          if (isSetup) setupErrorShown = true;
          throw new Error(fallbackError.message + arxivSuffix);
        }
        if (fallback === null) {
          throw new Error(
            `${arxivVerdict}, and no other source is configured.${arxivSuffix}`
          );
        }
        if (!fallbackAvailable) {
          throw new Error(fallback.setupHint + arxivSuffix);
        }
        if (!fallback.canAttempt(paper)) {
          throw new Error(fallback.missingIdentifierHint + arxivSuffix);
        }
        // Available, attemptable, nothing thrown -> the fallback returned null.
        throw new Error(`Not available on arXiv or ${fallback.name}.` + arxivSuffix);
      }

      // Rename to formatted filename. sanitizeFilename already strips path
      // separators, but the title is remote-sourced, so assert containment
      // before moving anything rather than trusting that to stay true.
      if (fs.existsSync(savedPath)) {
        const dir = path.resolve(path.dirname(savedPath));
        const newPath = path.join(dir, buildPaperFilename(paper, savedPath));
        if (!newPath.startsWith(dir + path.sep)) {
          console.warn(
            `Citation Graph: refusing to rename "${savedPath}" outside ${dir}`
          );
        } else if (path.resolve(savedPath) !== newPath) {
          fs.renameSync(savedPath, newPath);
        }
      }
      downloaded++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`Citation Graph: Failed to download "${paper.title}"`, e);
      logNotice(`Failed: ${paper.title}\n${reason}`, 10000);
      failed.push(paper.title);
    }
  }

  return { downloaded, failed, resolvedArxiv };
}

/**
 * Hosts arxiv.org is allowed to redirect a PDF download to.
 * cloudfront.net is included because arXiv fronts its PDFs with CloudFront.
 */
const ARXIV_REDIRECT_HOSTS = ["arxiv.org", "cloudfront.net"];

/**
 * Whether a redirect target is one of the allowed hosts.
 *
 * Matching on `host.endsWith(domain)` is wrong: domain labels are separated by
 * dots, so "notarxiv.org".endsWith("arxiv.org") is true and any attacker who
 * can influence the redirect target reaches a host they control. Require
 * either an exact match or a real subdomain ("." + domain).
 */
function isAllowedArxivHost(host: string): boolean {
  return ARXIV_REDIRECT_HOSTS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/** Refuse a "PDF" larger than this: arXiv papers are far smaller, and an
 *  unbounded stream to disk is a trivial way to fill the user's drive. */
const MAX_PDF_BYTES = 200 * 1024 * 1024;

/** Download a PDF from arxiv given an arxiv ID (e.g. "2301.01234" or "quant-ph/0601075"). */
function downloadFromArxiv(arxivId: string, outputDir: string): Promise<string> {
  // Defense in depth: even though isValidArxivId gates the caller, strip any
  // character that could escape outputDir via path traversal and assert the
  // resolved destination stays inside it.
  const safeId = arxivId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const url = `https://arxiv.org/pdf/${arxivId}`;
  const outputDirResolved = path.resolve(outputDir);
  const destPath = path.join(outputDirResolved, `${safeId}.pdf`);
  if (!destPath.startsWith(outputDirResolved + path.sep)) {
    return Promise.reject(new Error(`Refusing to write outside ${outputDir}`));
  }

  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectsLeft: number) => {
      if (redirectsLeft <= 0) {
        reject(new Error("Too many redirects"));
        return;
      }

      const req = https.get(
        requestUrl,
        {
          headers: { "User-Agent": "ObsidianCitationGraph/1.0" },
          timeout: 60_000,
        },
        (res) => {
          // Follow redirects, but only to arxiv.org or known CDN hosts
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, requestUrl);
            const host = redirectUrl.hostname.toLowerCase();
            if (redirectUrl.protocol !== "https:" || !isAllowedArxivHost(host)) {
              res.resume();
              reject(new Error(`arxiv redirected to untrusted host: ${host}`));
              return;
            }
            doRequest(redirectUrl.href, redirectsLeft - 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`arxiv returned HTTP ${res.statusCode} for ${arxivId}`));
            return;
          }

          const fileStream = fs.createWriteStream(destPath);

          // Abort rather than stream an unbounded body to disk.
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_PDF_BYTES) {
              res.destroy();
              fileStream.destroy();
              fs.unlink(destPath, () => {});
              reject(new Error(`arxiv response for ${arxivId} exceeded ${MAX_PDF_BYTES} bytes`));
            }
          });

          res.pipe(fileStream);
          fileStream.on("finish", () => {
            fileStream.close();
            // Verify we got a PDF and not an error page. Every failure path
            // here must reject: an exception thrown inside a stream event
            // handler escapes the Promise and crashes the renderer instead.
            let header: string;
            let fd: number | null = null;
            try {
              const buf = Buffer.alloc(5);
              fd = fs.openSync(destPath, "r");
              fs.readSync(fd, buf, 0, 5, 0);
              header = buf.toString();
            } catch (err) {
              fs.unlink(destPath, () => {});
              reject(err instanceof Error ? err : new Error(String(err)));
              return;
            } finally {
              if (fd !== null) {
                try {
                  fs.closeSync(fd);
                } catch {
                  // Already closed or invalid; nothing useful to do.
                }
              }
            }
            if (header !== "%PDF-") {
              fs.unlink(destPath, () => {});
              reject(new Error(`arxiv did not return a PDF for ${arxivId}`));
            } else {
              resolve(destPath);
            }
          });
          fileStream.on("error", (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error(`arxiv request timed out for ${arxivId}`));
      });
      req.on("error", reject);
    };

    doRequest(url, 5);
  });
}

