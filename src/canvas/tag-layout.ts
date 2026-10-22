import type { CanvasNode } from "../types";

export const TAG_GROUP_PREFIX = "cg-tag-";
export const UNTAGGED_LABEL = "Untagged";

const CARD_GAP = 100;
const GROUP_PADDING = 100;
const GROUP_GAP = 400;

/** Whether a node is a group this module created. */
export function isTagGroup(node: CanvasNode): boolean {
	return node.type === "group" && node.id.startsWith(TAG_GROUP_PREFIX);
}

/**
 * Rearrange a canvas's paper cards into one labelled group per tag.
 *
 * `tagOf` maps each paper note's path to its grouping tag (null for an
 * untagged paper). File nodes absent from it are not papers and keep their
 * place, as do text, link and the user's own group nodes. Groups this function
 * created on an earlier run are replaced, so running it again is idempotent.
 *
 * Paper nodes are moved, never recreated, so their IDs (and with them every
 * edge) and their reading-status colours survive. Groups are laid out left to
 * right from the papers' previous top-left corner, alphabetically with
 * "Untagged" last; inside a group, cards keep their previous left-to-right,
 * top-to-bottom order (on a timeline canvas, publication order), filling a
 * roughly square grid column by column.
 */
export function layoutByTag(
	nodes: CanvasNode[],
	tagOf: ReadonlyMap<string, string | null>
): CanvasNode[] {
	const isPaper = (n: CanvasNode): boolean =>
		n.type === "file" && !!n.file && tagOf.has(n.file);
	const papers = nodes.filter(isPaper);
	const kept = nodes.filter((n) => !isPaper(n) && !isTagGroup(n));
	if (papers.length === 0) return kept;

	const byTag = new Map<string | null, CanvasNode[]>();
	for (const node of papers) {
		const tag = tagOf.get(node.file!) ?? null;
		const group = byTag.get(tag) ?? [];
		group.push(node);
		byTag.set(tag, group);
	}
	const tags = [...byTag.keys()].sort((a, b) => {
		if (a === null) return 1;
		if (b === null) return -1;
		return a.localeCompare(b);
	});

	// Anchored on the previous run's groups too, so a re-run does not creep
	// by the group padding each time.
	const anchor = [...papers, ...nodes.filter(isTagGroup)];
	let x = Math.min(...anchor.map((n) => n.x));
	const top = Math.min(...anchor.map((n) => n.y));
	const groups: CanvasNode[] = [];
	const placed: CanvasNode[] = [];

	tags.forEach((tag, i) => {
		const cards = byTag.get(tag)!.sort((a, b) => a.x - b.x || a.y - b.y);
		// Filled column by column, so the left-to-right sort above reproduces
		// this order on a re-run.
		const rows = Math.ceil(cards.length / Math.ceil(Math.sqrt(cards.length)));
		const cols = Math.ceil(cards.length / rows);
		const cellW = Math.max(...cards.map((n) => n.width)) + CARD_GAP;
		const cellH = Math.max(...cards.map((n) => n.height)) + CARD_GAP;

		cards.forEach((card, k) => {
			placed.push({
				...card,
				x: x + GROUP_PADDING + Math.floor(k / rows) * cellW,
				y: top + GROUP_PADDING + (k % rows) * cellH,
			});
		});

		const width = 2 * GROUP_PADDING + cols * cellW - CARD_GAP;
		groups.push({
			id: `${TAG_GROUP_PREFIX}${i}`,
			type: "group",
			label: tag === null ? UNTAGGED_LABEL : `#${tag}`,
			x,
			y: top,
			width,
			height: 2 * GROUP_PADDING + rows * cellH - CARD_GAP,
		});
		x += width + GROUP_GAP;
	});

	// Groups first: Obsidian draws nodes in file order, so a group listed
	// after its cards would be painted over them.
	return [...groups, ...kept, ...placed];
}
