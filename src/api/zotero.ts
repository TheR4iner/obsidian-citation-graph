/// <reference types="node" />
import { requestUrl } from "obsidian";
import type { ZoteroCollection, ZoteroItem } from "../types";
import { asArray, asNumber, asRecord, asString, parseJson, pick } from "./json";
import * as http from "http";

const LOCAL_BASE = "/api";
const LOCAL_PORT = 23119;
const WEB_BASE = "https://api.zotero.org";

/** Refuse a local response past this size rather than buffering it all. */
const MAX_LOCAL_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Make a GET request to Zotero's local HTTP server using Node's http module.
 * Obsidian's requestUrl can be unreliable with http://localhost in Electron.
 *
 * The body comes back as `unknown`. Each caller asserts the shape it expects,
 * which is a claim about Zotero's API that this function is in no position to
 * check; making that assertion visible at the call site is the point.
 */
async function localGet(path: string): Promise<unknown> {
  const data = await localGetText(path);
  try {
    return JSON.parse(data);
  } catch {
    throw new Error(`Invalid JSON from Zotero: ${data.slice(0, 200)}`);
  }
}

/** Zotero's local server could not be reached at all: the app is not running. */
export class ZoteroUnreachableError extends Error {}

/** GET a local API path and return the raw body. */
function localGetText(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: LOCAL_PORT, path, headers: { Accept: "application/json" } },
      (res) => {
        // Without setEncoding, "data" yields Buffers; concatenating them one
        // at a time would decode each in isolation and corrupt any multi-byte
        // character that straddles a chunk boundary (accented author names,
        // CJK titles). Decoding through the stream keeps the boundary state.
        res.setEncoding("utf8");

        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Zotero returned HTTP ${status} for ${path}`));
          return;
        }

        let data = "";
        let truncated = false;
        res.on("data", (chunk: string) => {
          if (truncated) return;
          data += chunk;
          if (data.length > MAX_LOCAL_RESPONSE_BYTES) {
            truncated = true;
            res.destroy();
            reject(new Error(`Zotero response for ${path} was unexpectedly large; aborted.`));
          }
        });
        res.on("error", (err: unknown) =>
          reject(err instanceof Error ? err : new Error(String(err)))
        );
        res.on("end", () => {
          if (!truncated) resolve(data);
        });
      }
    );
    req.on("error", () =>
      reject(new ZoteroUnreachableError("Cannot connect to Zotero. Make sure the Zotero desktop app is running."))
    );
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new ZoteroUnreachableError("Zotero is not responding. Make sure the Zotero desktop app is running."));
    });
  });
}

type ZoteroItemInput = {
  title: string;
  creators: Array<{
    creatorType: string;
    firstName: string;
    lastName: string;
  }>;
  date: string;
  DOI?: string;
  itemType?: string;
};

/**
 * Client for Zotero API.
 * Reads always use the local API (localhost:23119, no auth needed).
 * Writes always use the Web API (requires apiKey + userId).
 */
export class ZoteroClient {
  constructor(
    private apiKey: string,
    private userId: string
  ) {}

  /** Whether write operations are available (Web API credentials configured) */
  get canWrite(): boolean {
    return !!(this.apiKey && this.userId);
  }

  // ─── Reads (local API) ─────────────────────────────────────

  /** Fetch all collections from local Zotero instance, including group libraries */
  async getCollections(): Promise<ZoteroCollection[]> {
    const userCollections = (await localGet(
      `${LOCAL_BASE}/users/0/collections`
    )) as ZoteroCollection[];

    let groups: Array<{ id: number; data: { name: string } }> = [];
    try {
      groups = (await localGet(`${LOCAL_BASE}/users/0/groups`)) as typeof groups;
    } catch {
      // Groups endpoint unavailable -- return only personal library
    }

    const groupCollectionArrays = await Promise.all(
      groups.map(async (g) => {
        try {
          const cols = (await localGet(
            `${LOCAL_BASE}/groups/${encodeURIComponent(String(g.id))}/collections`
          )) as ZoteroCollection[];
          return cols.map((c) => ({
            ...c,
            data: { ...c.data, groupId: g.id, groupName: g.data.name },
          }));
        } catch {
          return [] as ZoteroCollection[];
        }
      })
    );

    return [...userCollections, ...groupCollectionArrays.flat()];
  }

  /**
   * Fetch all top-level items from the entire Zotero library.
   * Top-level excludes child attachments/notes/annotations server-side; the
   * extra client-side filter is a belt-and-braces guard for older Zotero
   * versions that may include child items in /items/top responses.
   */
  async getAllItems(): Promise<ZoteroItem[]> {
    const items: ZoteroItem[] = [];
    let start = 0;
    const limit = 100;

    while (true) {
      const batch = (await localGet(
        `${LOCAL_BASE}/users/0/items/top?start=${start}&limit=${limit}`
      )) as ZoteroItem[];
      items.push(...batch);

      if (batch.length < limit) break;
      start += limit;
    }

    return items.filter((item) => {
      const t = item.data.itemType;
      return t !== "attachment" && t !== "note" && t !== "annotation";
    });
  }

  /** Fetch all items in a collection from local Zotero */
  async getCollectionItems(collectionKey: string, groupId?: number): Promise<ZoteroItem[]> {
    // Encode both identifiers: they arrive from Zotero responses and canvas
    // metadata, so neither is guaranteed to be path-safe.
    const owner = groupId ? `groups/${encodeURIComponent(String(groupId))}` : "users/0";
    const key = encodeURIComponent(collectionKey);
    const items: ZoteroItem[] = [];
    let start = 0;
    const limit = 100;

    while (true) {
      const batch = (await localGet(
        `${LOCAL_BASE}/${owner}/collections/${key}/items?start=${start}&limit=${limit}`
      )) as ZoteroItem[];
      items.push(...batch);

      if (batch.length < limit) break;
      start += limit;
    }

    // Filter to actual reference items (not attachments, notes, etc.)
    return items.filter((item) => {
      const t = item.data.itemType;
      return t !== "attachment" && t !== "note" && t !== "annotation";
    });
  }

  /**
   * The local `file://` URL of the PDF Zotero stores for the item with this
   * DOI, searching the personal library and then each group library. Null when
   * no item matches, or its best attachment is not a PDF or is not on disk.
   * Throws when Zotero cannot be reached, so a caller can tell "not running"
   * from "no PDF".
   */
  async findPdfFileUrl(doi: string): Promise<string | null> {
    for (const library of await this.libraryPaths()) {
      const found = await localGet(
        `${LOCAL_BASE}/${library}/items?q=${encodeURIComponent(doi)}&qmode=fields`
      );
      const attachment = pdfAttachmentPath(found, doi);
      if (!attachment) continue;
      // Zotero 7 answers this with the attachment's file URL as plain text.
      return localPdfFileUrl(await localGetText(`${attachment}/file/view/url`));
    }
    return null;
  }

  private libraryList: Promise<string[]> | null = null;

  /** "users/0" plus one "groups/<id>" per group, fetched once per client. */
  private libraryPaths(): Promise<string[]> {
    this.libraryList ??= localGet(`${LOCAL_BASE}/users/0/groups`)
      .then((groups) => asArray(groups).map((g) => asNumber(pick(g, "id"))))
      .catch(() => [] as Array<number | null>)
      .then((ids) => [
        "users/0",
        ...ids.filter((id): id is number => id !== null).map((id) => `groups/${id}`),
      ]);
    return this.libraryList;
  }

  // ─── Writes (Web API) ──────────────────────────────────────

  private requireWebApi(): void {
    if (!this.apiKey || !this.userId) {
      throw new Error(
        "Zotero API key and user ID are required for write operations. Configure them in Citation Graph settings."
      );
    }
  }

  /** Create a new collection via the Web API, returns the collection key */
  async createCollection(name: string): Promise<string> {
    this.requireWebApi();

    const resp = await requestUrl({
      url: `${WEB_BASE}/users/${encodeURIComponent(this.userId)}/collections`,
      method: "POST",
      headers: {
        "Zotero-API-Key": this.apiKey,
        "Content-Type": "application/json",
        "Zotero-API-Version": "3",
      },
      body: JSON.stringify([{ name }]),
    });

    // Zotero answers with { successful: { "0": { ...the new collection } } }.
    const successful = asRecord(pick(parseJson(resp.text), "successful"));
    const created = successful ? Object.values(successful)[0] : undefined;
    const identifier = asString(pick(created, "key"));
    if (!identifier) {
      throw new Error("Failed to create Zotero collection");
    }
    return identifier;
  }

  /** Add items to Zotero via the Web API */
  async addItems(items: ZoteroItemInput[], collectionKey: string): Promise<void> {
    this.requireWebApi();

    const payload = items.map((item) => ({
      itemType: item.itemType || "journalArticle",
      title: item.title,
      creators: item.creators,
      date: item.date,
      DOI: item.DOI || "",
      collections: [collectionKey],
    }));

    await requestUrl({
      url: `${WEB_BASE}/users/${encodeURIComponent(this.userId)}/items`,
      method: "POST",
      headers: {
        "Zotero-API-Key": this.apiKey,
        "Content-Type": "application/json",
        "Zotero-API-Version": "3",
      },
      body: JSON.stringify(payload),
    });
  }

  // ─── Static helpers ───────────────────────────────────────

  /** Extract DOI from a Zotero item (checks DOI field and Extra field) */
  static extractDOI(item: ZoteroItem): string | null {
    if (item.data.DOI) return item.data.DOI;

    // Check Extra field for DOI
    const extra = item.data.extra || "";
    const match = extra.match(/DOI:\s*(.+)/i);
    if (match) return match[1].trim();

    return null;
  }

  /** Extract arXiv ID from a Zotero item (checks Extra field, URL, and arXiv-minted DOI) */
  static extractArXiv(item: ZoteroItem): string | null {
    const extra = item.data.extra || "";
    const match = extra.match(/arXiv:\s*(\d+\.\d+)/i);
    if (match) return match[1];

    const url = item.data.url || "";
    const urlMatch = url.match(/arxiv\.org\/abs\/(\d+\.\d+)/);
    if (urlMatch) return urlMatch[1];

    // arXiv-minted DOIs (10.48550/arXiv.XXXX.XXXXX) encode the arxiv ID directly.
    const doi = item.data.DOI || "";
    const doiMatch = doi.match(/^10\.48550\/arXiv\.(.+)$/i);
    if (doiMatch) return doiMatch[1];

    return null;
  }

  /** Extract citekey from Extra field (Better BibTeX) */
  static extractCitekey(item: ZoteroItem): string | null {
    const extra = item.data.extra || "";
    const match = extra.match(/Citation Key:\s*(.+)/i);
    if (match) return match[1].trim();
    return null;
  }
}

/**
 * From a local API item search, the API path of the best attachment of the
 * item whose DOI is `doi`, when that attachment is a PDF that exists on disk.
 *
 * The search matches the DOI anywhere in any field, so results are filtered to
 * an exact, case-insensitive DOI match. Zotero puts each item's best
 * attachment (oldest PDF first) in `links.attachment`, and leaves out
 * `attachmentSize` when the file is missing locally, for instance when file
 * sync has not downloaded it.
 */
export function pdfAttachmentPath(searchResults: unknown, doi: string): string | null {
  const wanted = doi.trim().toLowerCase();
  for (const item of asArray(searchResults)) {
    const itemType = asString(pick(item, "data", "itemType"));
    if (!itemType || itemType === "attachment" || itemType === "note" || itemType === "annotation") continue;
    if (ZoteroClient.extractDOI(item as ZoteroItem)?.trim().toLowerCase() !== wanted) continue;
    const link = pick(item, "links", "attachment");
    if (asString(pick(link, "attachmentType")) !== "application/pdf") continue;
    if (asNumber(pick(link, "attachmentSize")) === null) continue;
    const href = asString(pick(link, "href"));
    if (!href) continue;
    let pathname: string;
    try {
      pathname = new URL(href).pathname;
    } catch {
      continue;
    }
    // Only ever follow a path of the expected shape back to the local server.
    if (/^\/api\/(?:users|groups)\/\d+\/items\/[A-Z0-9]+$/.test(pathname)) return pathname;
  }
  return null;
}

/**
 * Accept Zotero's answer as a link only when it is a host-less `file://` URL
 * of a `.pdf`. A linked attachment in a group library points wherever another
 * member chose, and the link is handed to the system to open: a non-PDF file
 * would open in whatever handles its type, and a URL naming a host (a network
 * share on Windows) would make the system connect to it.
 */
export function localPdfFileUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || url.host !== "") return null;
  return /\.pdf$/i.test(url.pathname) ? url.href : null;
}
