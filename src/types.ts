/** A banned (uninteresting) paper, stored per-canvas */
export interface BannedPaper {
	id: string;
	title: string;
}

/** A paper with metadata from Zotero + Semantic Scholar */
export interface Paper {
	/** Stable ID: DOI preferred, else arXiv, else S2 ID */
	id: string;
	title: string;
	authors: string[];
	year: number;
	doi: string | null;
	arxiv: string | null;
	citekey: string | null;
	semanticScholarId: string | null;
	abstract: string | null;
	citationCount: number | null;
	/** Path to literature note within vault (e.g. "literature/vaswani2017attention.md") */
	notePath: string | null;
}

/** Directed citation edge: fromPaper cites toPaper */
export interface CitationEdge {
	fromId: string; // citing paper (usually newer)
	toId: string; // cited paper (usually older)
}

/** The full citation graph for a collection */
export interface CitationGraph {
	papers: Map<string, Paper>;
	edges: CitationEdge[];
	collectionName: string;
	zoteroCollectionKey: string;
}

/** Obsidian Canvas JSON types (matching the .canvas spec) */
export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	type: "file" | "text" | "link" | "group";
	file?: string;
	text?: string;
	url?: string;
	color?: string;
}

export interface CanvasEdge {
	id: string;
	fromNode: string;
	toNode: string;
	fromSide: "top" | "bottom" | "left" | "right";
	toSide: "top" | "bottom" | "left" | "right";
	toEnd?: "arrow" | "none";
	color?: string;
	label?: string;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

/**
 * An Obsidian canvas preset color ID, or "" for no color (the canvas default
 * grey frame).
 */
export type PresetColor = "" | "1" | "2" | "3" | "4" | "5" | "6";

/**
 * A canvas node color. The JSON Canvas spec allows either a preset ID or a
 * hex string, so themes that do not define the preset variables (or simply
 * clash with them) can be matched exactly.
 */
export type StatusColor = PresetColor | `#${string}`;

const PRESET_COLORS: readonly string[] = ["", "1", "2", "3", "4", "5", "6"];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Whether a color is a custom hex value rather than a preset ID. */
export function isCustomColor(color: string): boolean {
	return HEX_COLOR.test(color);
}

/**
 * Narrow an arbitrary stored value to a usable canvas color, falling back to
 * no color. Guards against hand-edited or stale data.json values reaching the
 * canvas, where an invalid color would be written into the .canvas file.
 */
export function parseStatusColor(value: unknown): StatusColor {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (PRESET_COLORS.includes(trimmed)) return trimmed as PresetColor;
	if (HEX_COLOR.test(trimmed)) return trimmed.toLowerCase() as `#${string}`;
	return "";
}

/**
 * Reading status of a paper, stored in the literature note's `status`
 * frontmatter field. This is the complete set of statuses the user can
 * choose; `annotated` is deliberately absent because it is derived from the
 * note body rather than stored (see DisplayStatus).
 */
export type PaperStatus = "unread" | "reading" | "read" | "abandoned";

/** Every stored status, in the order shown to the user. */
export const PAPER_STATUSES: readonly PaperStatus[] = [
	"unread",
	"reading",
	"read",
	"abandoned",
] as const;

/**
 * What a paper looks like on the canvas. `annotated` is never written to
 * frontmatter: it is computed from the note body at paint time, so the
 * plugin never persists a status the user did not explicitly pick.
 */
export type DisplayStatus = PaperStatus | "annotated";

/** Human-readable labels for the status picker and settings UI. */
export const STATUS_LABELS: Record<DisplayStatus, string> = {
	unread: "To read",
	reading: "Reading",
	read: "Read",
	annotated: "Read + notes written",
	abandoned: "Abandoned",
};

/**
 * Statuses the fast toggle cycles through. `abandoned` is excluded because
 * it is not a step in normal reading progress, and `annotated` because it is
 * derived rather than set.
 */
export const STATUS_CYCLE: readonly PaperStatus[] = ["unread", "reading", "read"] as const;

/**
 * The status the fast toggle advances to. A status outside the cycle
 * (abandoned) re-enters it at the start, because indexOf returns -1.
 */
export function nextStatusInCycle(current: PaperStatus): PaperStatus {
	const index = STATUS_CYCLE.indexOf(current);
	return STATUS_CYCLE[(index + 1) % STATUS_CYCLE.length];
}

/** Narrow an arbitrary frontmatter value to a PaperStatus, or null. */
export function parsePaperStatus(value: unknown): PaperStatus | null {
	if (typeof value !== "string") return null;
	const lowered = value.toLowerCase().trim();
	return (PAPER_STATUSES as readonly string[]).includes(lowered)
		? (lowered as PaperStatus)
		: null;
}

/** Plugin settings */
export interface CitationGraphSettings {
	collectionsFolder: string;
	zoteroApiKey: string;
	zoteroUserId: string;
	semanticScholarApiKey: string;
	enableOpenAlex: boolean;
	enableCrossRef: boolean;
	openAlexEmail: string;
	nodeWidth: number;
	nodeHeight: number;
	defaultDownloadPath: string;
	/** Canvas node colors per reading status. `annotated` is derived, not stored, but still painted. */
	colorUnread: StatusColor;
	colorReading: StatusColor;
	colorRead: StatusColor;
	colorAnnotated: StatusColor;
	colorAbandoned: StatusColor;
	llmProvider: "anthropic" | "openai" | "google" | "claude-cli";
	llmApiKey: string;
	llmModel: string;
	llmMaxOutputTokens: number;
	llmBatchTokenBudget: number;
	claudeCliPath: string;
	summaryPrompt: string;
}

export const DEFAULT_SETTINGS: CitationGraphSettings = {
	collectionsFolder: "collections",
	zoteroApiKey: "",
	zoteroUserId: "",
	semanticScholarApiKey: "",
	enableOpenAlex: true,
	enableCrossRef: true,
	openAlexEmail: "",
	nodeWidth: 600,
	nodeHeight: 800,
	defaultDownloadPath: "",
	colorUnread: "",
	colorReading: "3",
	colorRead: "5",
	colorAnnotated: "4",
	colorAbandoned: "1",
	llmProvider: "claude-cli",
	llmApiKey: "",
	llmModel: "",
	llmMaxOutputTokens: 1024,
	llmBatchTokenBudget: 0,
	claudeCliPath: "",
	summaryPrompt: "",
};

/** The configured canvas color for a given display status. */
export function statusColor(
	settings: CitationGraphSettings,
	status: DisplayStatus
): StatusColor {
	switch (status) {
		case "unread":
			return parseStatusColor(settings.colorUnread);
		case "reading":
			return parseStatusColor(settings.colorReading);
		case "read":
			return parseStatusColor(settings.colorRead);
		case "annotated":
			return parseStatusColor(settings.colorAnnotated);
		case "abandoned":
			return parseStatusColor(settings.colorAbandoned);
	}
}

/** Env var names for the LLM provider API keys. */
export const LLM_PROVIDER_ENV_VAR: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_API_KEY",
};

/**
 * Return a copy of settings with any empty key/ID fields filled in from
 * environment variables. Call this at use-sites (API client construction,
 * summarization); never before saveData() so env values are not persisted.
 */
export function resolveApiKeys(settings: CitationGraphSettings): CitationGraphSettings {
	const envLlmKey = LLM_PROVIDER_ENV_VAR[settings.llmProvider]
		? (process.env[LLM_PROVIDER_ENV_VAR[settings.llmProvider]] ?? "")
		: "";
	return {
		...settings,
		zoteroApiKey: settings.zoteroApiKey || process.env.ZOTERO_API_KEY || "",
		zoteroUserId: settings.zoteroUserId || process.env.ZOTERO_USER_ID || "",
		semanticScholarApiKey:
			settings.semanticScholarApiKey || process.env.SEMANTIC_SCHOLAR_API_KEY || "",
		llmApiKey: settings.llmApiKey || envLlmKey,
	};
}

/** Check whether the user has configured LLM settings enough to run summaries. */
export function isLlmConfigured(settings: CitationGraphSettings): boolean {
	if (settings.llmProvider === "claude-cli") return true;
	return !!resolveApiKeys(settings).llmApiKey;
}

/** Return value from an LLM summarization call */
export interface LlmResponse {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

/** Zotero API response types */
export interface ZoteroCollection {
	key: string;
	data: {
		key: string;
		name: string;
		parentCollection: string | false;
		/** Set when this collection belongs to a group library (not the personal library) */
		groupId?: number;
		groupName?: string;
	};
}

export interface ZoteroItem {
	key: string;
	data: {
		key: string;
		itemType: string;
		title: string;
		creators: Array<{
			creatorType: string;
			firstName?: string;
			lastName?: string;
			name?: string;
		}>;
		date: string;
		DOI?: string;
		extra?: string;
		url?: string;
		collections: string[];
		// type: 0 (or absent) = manual user tag; 1 = auto-added by importer.
		tags?: Array<{ tag: string; type?: number }>;
	};
}

/** Cached references/citations for a single paper */
export interface S2CacheEntry {
	references: S2Paper[];
	citations: S2Paper[];
	cachedAt: number; // Date.now() timestamp
	sources?: string[]; // which APIs contributed (e.g. ["s2", "openalex", "crossref"])
}

/** On-disk shape of s2-cache.json */
export interface S2CacheData {
	version: 1;
	entries: Record<string, S2CacheEntry>; // keyed by S2 paperId
	externalIdIndex: Record<string, string>; // "DOI:10.xxx" -> paperId
}

/** Semantic Scholar response types */
export interface S2Paper {
	paperId: string;
	externalIds: {
		DOI?: string;
		ArXiv?: string;
		[key: string]: string | undefined;
	} | null;
	title: string;
	year: number | null;
	authors: Array<{ name: string }>;
	abstract: string | null;
	citationCount: number | null;
	references?: S2Paper[];
	citations?: S2Paper[];
}
