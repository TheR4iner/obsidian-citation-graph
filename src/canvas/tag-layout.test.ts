import { describe, expect, it } from "vitest";
import { layoutByTag, TAG_GROUP_PREFIX } from "./tag-layout";
import type { CanvasNode } from "../types";

const card = (id: string, x = 0, y = 0, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	x,
	y,
	width: 600,
	height: 800,
	type: "file",
	file: `papers/${id}.md`,
	...extra,
});

const inside = (node: CanvasNode, group: CanvasNode): boolean =>
	node.x >= group.x &&
	node.y >= group.y &&
	node.x + node.width <= group.x + group.width &&
	node.y + node.height <= group.y + group.height;

const overlaps = (a: CanvasNode, b: CanvasNode): boolean =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("layoutByTag", () => {
	const nodes: CanvasNode[] = [
		card("a", 0, 0, { color: "4" }),
		card("b", 700, 0),
		card("c", 1400, 0),
		card("d", 2100, 0),
		{ id: "mine", type: "text", text: "my note", x: -5000, y: -5000, width: 200, height: 100 },
		card("own", -4000, -4000),
	];
	const tagOf = new Map<string, string | null>([
		["papers/a.md", "optics"],
		["papers/b.md", "ml"],
		["papers/c.md", "optics"],
		["papers/d.md", null],
	]);
	const out = layoutByTag(nodes, tagOf);
	const byId = new Map(out.map((n) => [n.id, n]));
	const groups = out.filter((n) => n.type === "group");

	it("makes one labelled group per tag, alphabetical, untagged last", () => {
		expect(groups.map((g) => g.label)).toEqual(["#ml", "#optics", "Untagged"]);
		expect(groups.every((g) => g.id.startsWith(TAG_GROUP_PREFIX))).toBe(true);
	});

	it("puts every paper inside its own group and nowhere else", () => {
		expect(inside(byId.get("b")!, groups[0])).toBe(true);
		expect(inside(byId.get("a")!, groups[1])).toBe(true);
		expect(inside(byId.get("c")!, groups[1])).toBe(true);
		expect(inside(byId.get("d")!, groups[2])).toBe(true);
		for (const [i, g] of groups.entries()) {
			for (const h of groups.slice(i + 1)) expect(overlaps(g, h)).toBe(false);
		}
		expect(overlaps(byId.get("a")!, byId.get("c")!)).toBe(false);
	});

	it("keeps IDs, colours and non-paper nodes untouched", () => {
		expect(out).toHaveLength(nodes.length + 3);
		expect(byId.get("a")!.color).toBe("4");
		expect(byId.get("mine")).toEqual(nodes[4]);
		expect(byId.get("own")).toEqual(nodes[5]);
	});

	it("lists groups before cards, so cards are drawn on top", () => {
		const firstCard = out.findIndex((n) => n.type !== "group");
		expect(out.slice(firstCard).some((n) => n.type === "group")).toBe(false);
	});

	it("is idempotent: a second run replaces its own groups", () => {
		expect(layoutByTag(out, tagOf)).toEqual(out);
	});

	it("keeps the user's own groups", () => {
		const theirs: CanvasNode = { id: "g1", type: "group", label: "Mine", x: 0, y: 0, width: 10, height: 10 };
		expect(layoutByTag([theirs, ...nodes], tagOf)).toContainEqual(theirs);
	});

	it("leaves a canvas with no papers alone", () => {
		expect(layoutByTag(nodes.slice(4), new Map())).toEqual(nodes.slice(4));
	});
});

describe("layoutByTag grid", () => {
	it("keeps publication order, filling columns left to right", () => {
		const years = ["y1", "y2", "y3", "y4", "y5"].map((id, i) => card(id, i * 700, 0));
		const tagOf = new Map(years.map((n) => [n.file!, "t"]));
		const out = layoutByTag(years, tagOf).filter((n) => n.type === "file");
		const order = [...out].sort((a, b) => a.x - b.x || a.y - b.y).map((n) => n.id);
		expect(order).toEqual(["y1", "y2", "y3", "y4", "y5"]);
		expect(new Set(out.map((n) => n.x)).size).toBe(3);
	});
});
