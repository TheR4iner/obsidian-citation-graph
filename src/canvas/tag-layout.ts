import type { CanvasNode } from "../types";
import { isUpdateGroup } from "./layout";

export const TAG_GROUP_PREFIX = "cg-tag-";
export const MAX_TAGS_PER_PAPER = 3;
export const UNTAGGED_LABEL = "Untagged";
export const TOO_MANY_TAGS_LABEL = "Too many tags";
export const UNDRAWABLE_LABEL = "Tag combination not drawable";

const CARD_GAP = 100;
/** Space between a cell's edge and its cards; every group edge runs along a cell edge. */
const CELL_PADDING = 100;
const CLUSTER_GAP = 400;
/** Search budget per cluster, in grid cells evaluated. Bounds the command to well under a second. */
const SEARCH_BUDGET = 20_000_000;
const RESTARTS = 4;

export interface TagLayoutResult {
	nodes: CanvasNode[];
	/** Note paths of papers with more than MAX_TAGS_PER_PAPER tags. */
	tooManyTags: string[];
	/** Note paths of papers whose tag combination no placement of the groups could draw. */
	undrawable: string[];
}

/** Whether a node is a group this module created. */
export function isTagGroup(node: CanvasNode): boolean {
	return node.type === "group" && node.id.startsWith(TAG_GROUP_PREFIX);
}

/** Integer grid coordinates of one tag's rectangle, inclusive. */
interface Box {
	x1: number;
	x2: number;
	y1: number;
	y2: number;
}

/** Papers sharing one exact tag combination, as indices into a cluster's tags. */
interface Combo {
	tags: number[];
	cards: CanvasNode[];
}

/**
 * Rearrange a canvas's paper cards into overlapping groups, one per tag.
 *
 * Obsidian treats a card as belonging to every group whose rectangle contains
 * it, so a paper tagged A and B is placed where group A and group B overlap,
 * and outside every group whose tag it lacks. No card is duplicated: each
 * paper is one node, and its edges hang off that node.
 *
 * Not every family of combinations can be drawn with rectangles at once, so
 * the group rectangles are found by a seeded search that maximises the number
 * of papers whose exact combination has a region of its own. A paper whose
 * combination still has none goes in a separate fallback group and is
 * reported, as is one with more than three tags. A paper is never placed
 * inside a group whose tag it lacks.
 *
 * `tagOf` maps each paper note's path to its tags. File nodes absent from it
 * are not papers and keep their place, as do text, link and the user's own
 * group nodes. Groups this function created earlier are replaced, and the
 * same input lays out the same way, so a re-run changes nothing.
 */
export function layoutByTag(
	nodes: CanvasNode[],
	tagOf: ReadonlyMap<string, readonly string[]>
): TagLayoutResult {
	const isPaper = (n: CanvasNode): boolean =>
		n.type === "file" && !!n.file && tagOf.has(n.file);
	const papers = nodes.filter(isPaper);
	// The papers leave the group *Update from collection* put them in, so it goes too.
	const kept = nodes.filter((n) => !isPaper(n) && !isTagGroup(n) && !isUpdateGroup(n));
	if (papers.length === 0) return { nodes: kept, tooManyTags: [], undrawable: [] };

	// Anchor on where the previous run drew its rectangles too, so a re-run
	// does not creep by the padding each time.
	const ownGroups = nodes.filter(isTagGroup);
	const left = Math.min(
		...papers.map((n) => n.x),
		...ownGroups.map((g) => g.x - groupInset(g.label))
	);
	const top = Math.min(
		...papers.map((n) => n.y),
		...ownGroups.map((g) => g.y - groupInset(g.label))
	);

	// Obsidian tags are case-insensitive; the first spelling in path order labels the group.
	const labelOf = new Map<string, string>();
	for (const card of [...papers].sort((a, b) => a.file!.localeCompare(b.file!))) {
		for (const tag of tagOf.get(card.file!)!) {
			if (!labelOf.has(tag.toLowerCase())) labelOf.set(tag.toLowerCase(), tag);
		}
	}

	const untagged: CanvasNode[] = [];
	const tooMany: CanvasNode[] = [];
	const byCombo = new Map<string, { tags: string[]; cards: CanvasNode[] }>();
	for (const card of papers) {
		const tags = [...new Set(tagOf.get(card.file!)!.map((t) => t.toLowerCase()))].sort();
		if (tags.length === 0) untagged.push(card);
		else if (tags.length > MAX_TAGS_PER_PAPER) tooMany.push(card);
		else {
			const key = tags.join("\n");
			const entry = byCombo.get(key) ?? { tags, cards: [] };
			entry.cards.push(card);
			byCombo.set(key, entry);
		}
	}

	const groups: CanvasNode[] = [];
	const placed: CanvasNode[] = [];
	const undrawable: CanvasNode[] = [];
	const nextId = (): string => `${TAG_GROUP_PREFIX}${groups.length}`;
	let x = left;

	for (const cluster of clusters([...byCombo.values()])) {
		const tags = [...new Set(cluster.flatMap((c) => c.tags))].sort();
		const index = new Map(tags.map((t, i) => [t, i]));
		const combos: Combo[] = cluster.map((c) => ({
			tags: c.tags.map((t) => index.get(t)!),
			cards: c.cards,
		}));
		const drawn = drawCluster(tags.length, combos, x, top);
		drawn.rects.forEach((rect, i) => {
			const label = `#${labelOf.get(tags[i])!}`;
			const inset = groupInset(label);
			groups.push({
				id: nextId(),
				type: "group",
				label,
				x: rect.x + inset,
				y: rect.y + inset,
				width: rect.width - 2 * inset,
				height: rect.height - 2 * inset,
			});
		});
		placed.push(...drawn.placed);
		undrawable.push(...drawn.undrawable);
		x += drawn.width + CLUSTER_GAP;
	}

	for (const [label, cards] of [
		[UNTAGGED_LABEL, untagged],
		[TOO_MANY_TAGS_LABEL, tooMany],
		[UNDRAWABLE_LABEL, undrawable],
	] as const) {
		if (cards.length === 0) continue;
		const cell = gridCell(cards);
		placed.push(...cell.place(x, top));
		groups.push({ id: nextId(), type: "group", label, x, y: top, width: cell.width, height: cell.height });
		x += cell.width + CLUSTER_GAP;
	}

	return {
		// Groups first: Obsidian draws nodes in file order, so a group listed
		// after its cards would be painted over them.
		nodes: [...groups, ...kept, ...placed],
		tooManyTags: tooMany.map((n) => n.file!),
		undrawable: undrawable.map((n) => n.file!),
	};
}

/**
 * How far a tag group is drawn inside its cells' outline, varied per tag so
 * two groups starting on the same cell edge do not draw one line and stack
 * their labels exactly. Fallback groups (no `#`) are not inset.
 */
function groupInset(label: string | undefined): number {
	if (!label?.startsWith("#")) return 0;
	let h = 0;
	for (let i = 0; i < label.length; i++) h = (Math.imul(h, 31) + label.charCodeAt(i)) | 0;
	return 10 + 15 * ((h >>> 0) % 4);
}

/** Split combinations into clusters of tags linked by a shared paper, in tag order. */
function clusters<T extends { tags: string[] }>(combos: T[]): T[][] {
	const parent = new Map<string, string>();
	const find = (t: string): string => {
		while (parent.get(t) !== t) t = parent.get(t)!;
		return t;
	};
	for (const c of combos) for (const t of c.tags) if (!parent.has(t)) parent.set(t, t);
	for (const c of combos) for (const t of c.tags.slice(1)) parent.set(find(t), find(c.tags[0]));

	const byRoot = new Map<string, T[]>();
	for (const c of combos) {
		const root = find(c.tags[0]);
		byRoot.set(root, [...(byRoot.get(root) ?? []), c]);
	}
	const first = (cs: T[]): string => cs.flatMap((c) => c.tags).sort()[0];
	return [...byRoot.values()]
		.map((cs) => cs.sort((a, b) => a.tags.join("\n").localeCompare(b.tags.join("\n"))))
		.sort((a, b) => first(a).localeCompare(first(b)));
}

/** A grid of cards, filled column by column in their previous left-to-right order. */
function gridCell(cards: CanvasNode[]): {
	width: number;
	height: number;
	place: (x: number, y: number) => CanvasNode[];
} {
	const sorted = [...cards].sort((a, b) => a.x - b.x || a.y - b.y);
	const rows = Math.ceil(sorted.length / Math.ceil(Math.sqrt(sorted.length)));
	const cols = Math.ceil(sorted.length / rows);
	const cellW = Math.max(...sorted.map((n) => n.width)) + CARD_GAP;
	const cellH = Math.max(...sorted.map((n) => n.height)) + CARD_GAP;
	return {
		width: 2 * CELL_PADDING + cols * cellW - CARD_GAP,
		height: 2 * CELL_PADDING + rows * cellH - CARD_GAP,
		place: (x, y) =>
			sorted.map((card, k) => ({
				...card,
				x: x + CELL_PADDING + Math.floor(k / rows) * cellW,
				y: y + CELL_PADDING + (k % rows) * cellH,
			})),
	};
}

/**
 * Lay out one cluster: search for tag rectangles on an integer grid, give
 * each drawable combination one cell whose membership is exactly its tags,
 * then size the grid's columns and rows to the cards in them.
 */
function drawCluster(
	tagCount: number,
	combos: Combo[],
	left: number,
	top: number
): {
	rects: Array<{ x: number; y: number; width: number; height: number }>;
	placed: CanvasNode[];
	undrawable: CanvasNode[];
	width: number;
} {
	const boxes = searchBoxes(tagCount, combos);
	const size = gridSize(tagCount);
	const keys = cellKeys(boxes, size);

	const cellOf = new Map<Combo, [number, number]>();
	const undrawable: CanvasNode[] = [];
	for (const combo of combos) {
		const want = maskKey(combo.tags, tagCount);
		const at = keys.findIndex((key) => key === want);
		if (at < 0) undrawable.push(...combo.cards);
		else cellOf.set(combo, [at % size, Math.floor(at / size)]);
	}

	// Keep only grid lines that carry cards, plus one per tag whose
	// rectangle would otherwise vanish. Dropping a column never changes
	// which rectangles contain the cells that remain.
	const keepCol = new Set([...cellOf.values()].map(([i]) => i));
	const keepRow = new Set([...cellOf.values()].map(([, j]) => j));
	for (const b of boxes) {
		if (![...keepCol].some((i) => i >= b.x1 && i <= b.x2)) keepCol.add(b.x1);
		if (![...keepRow].some((j) => j >= b.y1 && j <= b.y2)) keepRow.add(b.y1);
	}
	const cols = [...keepCol].sort((a, b) => a - b);
	const rows = [...keepRow].sort((a, b) => a - b);

	const cells = new Map<Combo, ReturnType<typeof gridCell>>();
	for (const combo of cellOf.keys()) cells.set(combo, gridCell(combo.cards));
	const colWidth = new Map(cols.map((i) => [i, 2 * CELL_PADDING]));
	const rowHeight = new Map(rows.map((j) => [j, 2 * CELL_PADDING]));
	for (const [combo, [i, j]] of cellOf) {
		colWidth.set(i, Math.max(colWidth.get(i)!, cells.get(combo)!.width));
		rowHeight.set(j, Math.max(rowHeight.get(j)!, cells.get(combo)!.height));
	}
	const colX = new Map<number, number>();
	let x = left;
	for (const i of cols) {
		colX.set(i, x);
		x += colWidth.get(i)!;
	}
	const rowY = new Map<number, number>();
	let y = top;
	for (const j of rows) {
		rowY.set(j, y);
		y += rowHeight.get(j)!;
	}

	const placed: CanvasNode[] = [];
	for (const [combo, [i, j]] of cellOf) placed.push(...cells.get(combo)!.place(colX.get(i)!, rowY.get(j)!));

	const rects = boxes.map((b) => {
		const inCols = cols.filter((i) => i >= b.x1 && i <= b.x2);
		const inRows = rows.filter((j) => j >= b.y1 && j <= b.y2);
		const lastCol = inCols[inCols.length - 1];
		const lastRow = inRows[inRows.length - 1];
		const rx = colX.get(inCols[0])!;
		const ry = rowY.get(inRows[0])!;
		return {
			x: rx,
			y: ry,
			width: colX.get(lastCol)! + colWidth.get(lastCol)! - rx,
			height: rowY.get(lastRow)! + rowHeight.get(lastRow)! - ry,
		};
	});

	return { rects, placed, undrawable, width: x - left };
}

/** Grid lines available to the search: enough for every tag to start and end on its own. */
function gridSize(tagCount: number): number {
	return 2 * tagCount + 1;
}

type Key = number | string;

/** A membership set as 30-bit words. */
function maskWords(tags: number[], tagCount: number): number[] {
	const words = new Array<number>(Math.ceil(tagCount / 30)).fill(0);
	for (const t of tags) words[Math.floor(t / 30)] |= 1 << t % 30;
	return words;
}

/** Words as a comparable key: the number itself for the common one-word case. */
function wordsKey(words: number[]): Key {
	return words.length === 1 ? words[0] : words.join(",");
}

function maskKey(tags: number[], tagCount: number): Key {
	return wordsKey(maskWords(tags, tagCount));
}

/** The membership key of every grid cell, row-major. */
function cellKeys(boxes: Box[], size: number): Key[] {
	const tagCount = boxes.length;
	const lineMasks = (inside: (b: Box, line: number) => boolean): number[][] =>
		Array.from({ length: size }, (_, line) =>
			maskWords(boxes.flatMap((b, t) => (inside(b, line) ? [t] : [])), tagCount)
		);
	const colMasks = lineMasks((b, i) => i >= b.x1 && i <= b.x2);
	const rowMasks = lineMasks((b, j) => j >= b.y1 && j <= b.y2);
	const keys: Key[] = [];
	for (let j = 0; j < size; j++) {
		for (let i = 0; i < size; i++) {
			keys.push(wordsKey(colMasks[i].map((w, k) => w & rowMasks[j][k])));
		}
	}
	return keys;
}

/**
 * Score a placement: papers whose exact combination has a cell, times a
 * weight that always outranks the extent term, minus the rectangles' total
 * extent so smaller layouts win among equals. Allocation-free on the common
 * path, since the search calls it hundreds of thousands of times.
 */
function makeScorer(
	tagCount: number,
	size: number,
	combos: Combo[]
): { score: (boxes: Box[]) => number; paperWorth: number; total: number } {
	const words = Math.ceil(tagCount / 30);
	const index = new Map<Key, number>(combos.map((c, i) => [maskKey(c.tags, tagCount), i]));
	const weight = combos.map((c) => c.cards.length);
	const col = new Int32Array(size * words);
	const row = new Int32Array(size * words);
	const seen = new Uint8Array(combos.length);
	const cell = new Array<number>(words);
	const paperWorth = 2 * size * tagCount;

	const score = (boxes: Box[]): number => {
		col.fill(0);
		row.fill(0);
		seen.fill(0);
		let extent = 0;
		boxes.forEach((b, t) => {
			const w = Math.floor(t / 30);
			const bit = 1 << t % 30;
			for (let i = b.x1; i <= b.x2; i++) col[i * words + w] |= bit;
			for (let j = b.y1; j <= b.y2; j++) row[j * words + w] |= bit;
			extent += b.x2 - b.x1 + b.y2 - b.y1;
		});
		let covered = 0;
		for (let j = 0; j < size; j++) {
			for (let i = 0; i < size; i++) {
				let key: Key;
				if (words === 1) key = col[i] & row[j];
				else {
					for (let k = 0; k < words; k++) cell[k] = col[i * words + k] & row[j * words + k];
					key = cell.join(",");
				}
				const c = index.get(key);
				if (c !== undefined && !seen[c]) {
					seen[c] = 1;
					covered += weight[c];
				}
			}
		}
		return covered * paperWorth - extent;
	};
	return { score, paperWorth, total: weight.reduce((s, w) => s + w, 0) };
}

/**
 * Find tag rectangles under which as many papers as possible have a cell of
 * their exact combination, preferring smaller rectangles among equals.
 *
 * Simulated annealing with a fixed seed: one endpoint of one rectangle moves
 * at a time, and a worse move is sometimes kept early on so the search can
 * leave a dead end. The seed makes the result a pure function of the input,
 * which is what lets a re-run reproduce the same layout.
 */
function searchBoxes(tagCount: number, combos: Combo[]): Box[] {
	const size = gridSize(tagCount);
	if (tagCount === 1) return [{ x1: 0, x2: 0, y1: 0, y2: 0 }];

	const { score, paperWorth, total } = makeScorer(tagCount, size, combos);
	const full = (s: number): boolean => s > (total - 1) * paperWorth;
	const random = mulberry32(0x5eed + tagCount);
	const pick = (): number => Math.floor(random() * size);
	const steps = Math.max(1000, Math.floor(SEARCH_BUDGET / RESTARTS / (size * size)));
	// From accepting the loss of one paper to accepting a single grid step.
	const hot = paperWorth;
	const cooling = Math.pow(0.5 / hot, 1 / steps);

	let best: Box[] = [];
	let bestScore = -Infinity;
	for (let r = 0; r < RESTARTS && !full(bestScore); r++) {
		const boxes = Array.from({ length: tagCount }, (_, t) => {
			// The first attempt starts from a diagonal staircase, so neighbours overlap.
			const a = Math.min(2 * t, size - 1);
			const b = Math.min(a + 2, size - 1);
			return r === 0 ? { x1: a, x2: b, y1: a, y2: b } : randomBox(pick);
		});
		let current = score(boxes);
		let temperature = hot;
		for (let step = 0; step < steps; step++, temperature *= cooling) {
			const box = boxes[Math.floor(random() * tagCount)];
			const before = { ...box };
			const end = (["x1", "x2", "y1", "y2"] as const)[Math.floor(random() * 4)];
			box[end] = pick();
			if (box.x1 > box.x2) [box.x1, box.x2] = [box.x2, box.x1];
			if (box.y1 > box.y2) [box.y1, box.y2] = [box.y2, box.y1];
			const next = score(boxes);
			if (next >= current || random() < Math.exp((next - current) / temperature)) {
				current = next;
				if (current > bestScore) {
					bestScore = current;
					best = boxes.map((x) => ({ ...x }));
				}
			} else Object.assign(box, before);
		}
	}
	return best;
}

function randomBox(pick: () => number): Box {
	const [x1, x2] = [pick(), pick()].sort((a, b) => a - b);
	const [y1, y2] = [pick(), pick()].sort((a, b) => a - b);
	return { x1, x2, y1, y2 };
}

/** Small seeded PRNG; Math.random would make every run lay out differently. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
