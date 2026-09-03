import { normalizePath, type DataAdapter } from "obsidian";
import type { S2Paper, S2CacheData, S2CacheEntry } from "../types";
import { asNumber, asRecord, parseJson, pick } from "./json";

const CACHE_FILE = "s2-cache.json";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * A plain object used as a lookup table must not inherit from Object.prototype.
 * Keys here come from DOIs and third-party paper IDs, so an inherited name like
 * "constructor" or "toString" would otherwise resolve to a truthy prototype
 * member and be mistaken for a cache hit, and writing "__proto__" would mutate
 * the prototype of every object in the plugin.
 */
function nullProtoRecord<T>(source?: Record<string, T>): Record<string, T> {
	return Object.assign(Object.create(null) as Record<string, T>, source);
}

function emptyCache(): S2CacheData {
	return { version: 1, entries: nullProtoRecord(), externalIdIndex: nullProtoRecord() };
}

/** Strip abstracts from ref/citation papers to save disk space */
function stripAbstract(paper: S2Paper): S2Paper {
	const { abstract: _, ...rest } = paper;
	return { ...rest, abstract: null };
}

/**
 * Persistent cache for Semantic Scholar reference/citation lookups.
 * Stored as a separate JSON file in the plugin directory.
 */
export class S2RefCache {
	private cache: S2CacheData = emptyCache();
	private dirty = false;
	private readonly filePath: string;

	constructor(
		private adapter: DataAdapter,
		pluginDir: string,
	) {
		this.filePath = normalizePath(`${pluginDir}/${CACHE_FILE}`);
	}

	async load(): Promise<void> {
		try {
			const raw = await this.adapter.read(this.filePath);
			const parsed = parseJson(raw);
			if (asNumber(pick(parsed, "version")) === 1 && pick(parsed, "entries")) {
				// Rehydrate into null-prototype maps: JSON.parse produces plain
				// objects, which would reintroduce the inherited-key problem
				// described on nullProtoRecord.
				this.cache = {
					version: 1,
					entries: nullProtoRecord(
						asRecord(pick(parsed, "entries")) as Record<string, S2CacheEntry>
					),
					// Older cache files may lack the index entirely.
					externalIdIndex: nullProtoRecord(
						asRecord(pick(parsed, "externalIdIndex")) as
							| Record<string, string>
							| undefined
					),
				};
			}
		} catch {
			// File missing or corrupt: start fresh
			this.cache = emptyCache();
		}
		this.pruneExpired();
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		await this.adapter.write(this.filePath, JSON.stringify(this.cache));
		this.dirty = false;
	}

	/** Look up cached refs/citations by any external ID form */
	get(externalId: string): { references: S2Paper[]; citations: S2Paper[] } | null {
		const paperId = this.resolveId(externalId);
		if (!paperId) return null;

		const entry = this.cache.entries[paperId];
		if (!entry) return null;

		if (Date.now() - entry.cachedAt > TTL_MS) {
			this.invalidate(paperId);
			return null;
		}

		return { references: entry.references, citations: entry.citations };
	}

	/** Cache a paper's references and citations */
	set(externalId: string, paper: S2Paper): void {
		const entry: S2CacheEntry = {
			references: (paper.references || []).map(stripAbstract),
			citations: (paper.citations || []).map(stripAbstract),
			cachedAt: Date.now(),
		};

		this.cache.entries[paper.paperId] = entry;

		// Index all known ID forms -> canonical paperId
		this.indexPaper(externalId, paper);
		this.dirty = true;
	}

	/** Cache pre-merged multi-source references and citations */
	setMerged(
		externalId: string,
		doi: string | null,
		arxivId: string | null,
		references: S2Paper[],
		citations: S2Paper[],
		sources: string[],
	): void {
		// Use DOI-based canonical key, falling back to externalId
		const canonicalKey = doi ? `DOI:${doi}` : externalId;

		const entry: S2CacheEntry = {
			references: references.map(stripAbstract),
			citations: citations.map(stripAbstract),
			cachedAt: Date.now(),
			sources,
		};

		this.cache.entries[canonicalKey] = entry;

		// Index all known ID forms
		this.cache.externalIdIndex[canonicalKey] = canonicalKey;
		this.cache.externalIdIndex[externalId] = canonicalKey;
		if (doi) {
			this.cache.externalIdIndex[`DOI:${doi}`] = canonicalKey;
		}
		if (arxivId) {
			this.cache.externalIdIndex[`ARXIV:${arxivId}`] = canonicalKey;
		}
		this.dirty = true;
	}

	/** Number of cached papers */
	get size(): number {
		return Object.keys(this.cache.entries).length;
	}

	/** Remove all cached data */
	clear(): void {
		this.cache = emptyCache();
		this.dirty = true;
	}

	private resolveId(externalId: string): string | null {
		// Direct hit: externalId is itself a paperId
		if (this.cache.entries[externalId]) return externalId;
		// Index lookup
		return this.cache.externalIdIndex[externalId] ?? null;
	}

	private indexPaper(externalId: string, paper: S2Paper): void {
		const pid = paper.paperId;
		this.cache.externalIdIndex[pid] = pid;
		this.cache.externalIdIndex[externalId] = pid;

		if (paper.externalIds?.DOI) {
			this.cache.externalIdIndex[`DOI:${paper.externalIds.DOI}`] = pid;
		}
		if (paper.externalIds?.ArXiv) {
			this.cache.externalIdIndex[`ARXIV:${paper.externalIds.ArXiv}`] = pid;
		}
	}

	private invalidate(paperId: string): void {
		delete this.cache.entries[paperId];
		// Clean up index entries pointing to this paperId
		for (const [key, val] of Object.entries(this.cache.externalIdIndex)) {
			if (val === paperId) delete this.cache.externalIdIndex[key];
		}
		this.dirty = true;
	}

	private pruneExpired(): void {
		const now = Date.now();
		for (const [paperId, entry] of Object.entries(this.cache.entries)) {
			if (now - entry.cachedAt > TTL_MS) {
				this.invalidate(paperId);
			}
		}
	}
}
