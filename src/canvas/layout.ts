import type { Paper, CanvasNode } from "../types";

interface LayoutOptions {
	nodeWidth: number;
	nodeHeight: number;
	/** Horizontal spacing between year columns */
	xSpacing: number;
	/** Vertical spacing between nodes in the same year column */
	ySpacing: number;
}

const DEFAULTS: LayoutOptions = {
	nodeWidth: 600,
	nodeHeight: 800,
	xSpacing: 700,
	ySpacing: 900,
};

/**
 * Timeline layout: x-axis = publication year, y-axis = spread within year.
 * Returns positioned CanvasNodes.
 */
export function layoutPapers(
	papers: Paper[],
	options: Partial<LayoutOptions> = {}
): CanvasNode[] {
	const opts = { ...DEFAULTS, ...options };

	if (papers.length === 0) return [];

	// Group papers by year
	const byYear = new Map<number, Paper[]>();
	for (const paper of papers) {
		const year = paper.year || 0;
		if (!byYear.has(year)) byYear.set(year, []);
		byYear.get(year)!.push(paper);
	}

	// Sort years
	const years = Array.from(byYear.keys()).sort((a, b) => a - b);

	const nodes: CanvasNode[] = [];

	for (let yi = 0; yi < years.length; yi++) {
		const year = years[yi];
		const yearPapers = byYear.get(year)!;
		const x = yi * opts.xSpacing;

		// Center the column vertically
		const totalHeight = yearPapers.length * opts.ySpacing;
		const startY = -totalHeight / 2;

		for (let i = 0; i < yearPapers.length; i++) {
			const paper = yearPapers[i];
			nodes.push({
				id: paperNodeId(paper),
				x,
				y: startY + i * opts.ySpacing,
				width: opts.nodeWidth,
				height: opts.nodeHeight,
				type: "file",
				file: paper.notePath || "",
			});
		}
	}

	return nodes;
}

/**
 * Compute positions for new papers being added to an existing canvas.
 * Rebuilds the year-index-based x layout for ALL nodes (existing + new)
 * so that inserting a paper from a new year correctly shifts columns.
 * Returns { updatedExisting, newNodes }.
 */
export function layoutNewPapers(
	existingNodes: CanvasNode[],
	newPapers: Paper[],
	allPapers: Map<string, Paper>,
	options: Partial<LayoutOptions> = {}
): { updatedExisting: CanvasNode[]; newNodes: CanvasNode[] } {
	const opts = { ...DEFAULTS, ...options };

	if (newPapers.length === 0) {
		return { updatedExisting: existingNodes, newNodes: [] };
	}

	// Build a mapping from node file path → year using allPapers
	const fileToYear = new Map<string, number>();
	for (const paper of allPapers.values()) {
		if (paper.notePath) {
			fileToYear.set(paper.notePath, paper.year || 0);
		}
	}

	// Collect all unique years from existing nodes and new papers
	const yearSet = new Set<number>();
	for (const node of existingNodes) {
		if (node.type === "file" && node.file) {
			const year = fileToYear.get(node.file);
			if (year !== undefined) yearSet.add(year);
		}
	}
	for (const paper of newPapers) {
		yearSet.add(paper.year || 0);
	}

	const sortedYears = Array.from(yearSet).sort((a, b) => a - b);
	const yearToIndex = new Map<number, number>();
	sortedYears.forEach((y, i) => yearToIndex.set(y, i));

	// Reposition existing nodes to new x based on year index
	const updatedExisting = existingNodes.map((node) => {
		if (node.type === "file" && node.file) {
			const year = fileToYear.get(node.file);
			if (year !== undefined) {
				const newX =
					yearToIndex.get(year)! * opts.xSpacing;
				return { ...node, x: newX };
			}
		}
		return { ...node };
	});

	// Place new papers in correct columns, below existing nodes
	const newNodes: CanvasNode[] = [];

	for (const paper of newPapers) {
		const year = paper.year || 0;
		const x = (yearToIndex.get(year) ?? 0) * opts.xSpacing;

		// Find a y position that doesn't overlap
		const existingInColumn = updatedExisting
			.filter((n) => Math.abs(n.x - x) < opts.nodeWidth)
			.map((n) => n.y);
		const newInColumn = newNodes
			.filter((n) => Math.abs(n.x - x) < opts.nodeWidth)
			.map((n) => n.y);
		const allYsInColumn = [
			...existingInColumn,
			...newInColumn,
		].sort((a, b) => a - b);

		let y = 0;
		if (allYsInColumn.length > 0) {
			y =
				allYsInColumn[allYsInColumn.length - 1] +
				opts.ySpacing;
		}

		newNodes.push({
			id: paperNodeId(paper),
			x,
			y,
			width: opts.nodeWidth,
			height: opts.nodeHeight,
			type: "file",
			file: paper.notePath || "",
		});
	}

	return { updatedExisting, newNodes };
}

/** The paper identifier a node ID is derived from, in precedence order. */
function nodeIdSource(paper: Paper): string {
	return paper.doi || paper.arxiv || paper.semanticScholarId || paper.id;
}

/** 32-bit FNV-1a. Math.imul keeps the multiply inside 32-bit integer range. */
function fnv1a32(source: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		h ^= source.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** 32-bit djb2-xor: a structurally different mix, so the two halves below do
 *  not share a failure mode. */
function djb2xor32(source: string): number {
	let h = 5381;
	for (let i = 0; i < source.length; i++) {
		h = (Math.imul(h, 33) ^ source.charCodeAt(i)) | 0;
	}
	return h >>> 0;
}

/**
 * Generate a stable node ID from a paper.
 *
 * Two independent 32-bit hashes are concatenated, giving a ~2^64 space. The
 * previous single 32-bit hash left roughly 2^31 distinct values once Math.abs
 * discarded the sign, which is a birthday collision every ~17,000 canvases at
 * 500 papers -- and a collision is silent: two papers share one node, so one
 * of them simply never appears.
 */
export function paperNodeId(paper: Paper): string {
	const source = nodeIdSource(paper);
	return (
		"cg-" +
		fnv1a32(source).toString(36).padStart(7, "0") +
		djb2xor32(source).toString(36).padStart(7, "0")
	);
}

/**
 * The pre-widening node ID.
 *
 * A canvas node ID is persisted in the user's .canvas file, so the hash is a
 * storage format rather than an internal detail. Canvases written before the
 * widening still carry these IDs, and they stay valid forever: rather than
 * rewriting the user's files, every lookup accepts either form and only newly
 * created nodes use the current scheme.
 */
export function legacyPaperNodeId(paper: Paper): string {
	const source = nodeIdSource(paper);
	let hash = 0;
	for (let i = 0; i < source.length; i++) {
		hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
	}
	return "cg-" + Math.abs(hash).toString(36);
}

/** Every node ID a paper's node may legitimately carry, current scheme first. */
export function paperNodeIdCandidates(paper: Paper): string[] {
	return [paperNodeId(paper), legacyPaperNodeId(paper)];
}

/** Whether any of `existingIds` is a node ID this paper could be stored under. */
export function hasPaperNode(paper: Paper, existingIds: ReadonlySet<string>): boolean {
	return paperNodeIdCandidates(paper).some((id) => existingIds.has(id));
}

/**
 * The ID this paper's node actually uses on a canvas that already holds it,
 * falling back to the current scheme when the paper is not there yet (which is
 * the ID a newly laid-out node will be given).
 */
export function resolvePaperNodeId(
	paper: Paper,
	existingIds: ReadonlySet<string>
): string {
	for (const id of paperNodeIdCandidates(paper)) {
		if (existingIds.has(id)) return id;
	}
	return paperNodeId(paper);
}
