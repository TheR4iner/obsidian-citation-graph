import { requestUrl } from "obsidian";
import type { ZoteroCollection, ZoteroItem } from "../types";
import * as http from "http";

const LOCAL_BASE = "/api";
const LOCAL_PORT = 23119;
const WEB_BASE = "https://api.zotero.org";

/** Refuse a local response past this size rather than buffering it all. */
const MAX_LOCAL_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Make a GET request to Zotero's local HTTP server using Node's http module.
 * Obsidian's requestUrl can be unreliable with http://localhost in Electron.
 */
function localGet(path: string): Promise<any> {
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
        res.on("error", (err) => reject(err));
        res.on("end", () => {
          if (truncated) return;
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from Zotero: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", () =>
      reject(new Error("Cannot connect to Zotero. Make sure the Zotero desktop app is running."))
    );
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Zotero is not responding. Make sure the Zotero desktop app is running."));
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
    const userCollections: ZoteroCollection[] = await localGet(`${LOCAL_BASE}/users/0/collections`);

    let groups: Array<{ id: number; data: { name: string } }> = [];
    try {
      groups = await localGet(`${LOCAL_BASE}/users/0/groups`);
    } catch {
      // Groups endpoint unavailable -- return only personal library
    }

    const groupCollectionArrays = await Promise.all(
      groups.map(async (g) => {
        try {
          const cols: ZoteroCollection[] = await localGet(`${LOCAL_BASE}/groups/${encodeURIComponent(String(g.id))}/collections`);
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
      const batch: ZoteroItem[] = await localGet(
        `${LOCAL_BASE}/users/0/items/top?start=${start}&limit=${limit}`
      );
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
      const batch: ZoteroItem[] = await localGet(
        `${LOCAL_BASE}/${owner}/collections/${key}/items?start=${start}&limit=${limit}`
      );
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

    const data = JSON.parse(resp.text);
    const successKeys = Object.values(data.successful || {}) as Array<{ key: string }>;
    if (successKeys.length === 0) {
      throw new Error("Failed to create Zotero collection");
    }
    return successKeys[0].key;
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
