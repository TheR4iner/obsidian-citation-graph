import { describe, expect, it } from "vitest";
import {
	layoutByTag,
	TAG_GROUP_PREFIX,
	TOO_MANY_TAGS_LABEL,
	UNDRAWABLE_LABEL,
	UNTAGGED_LABEL,
} from "./tag-layout";
import type { CanvasNode } from "../types";
import { UPDATE_GROUP_PREFIX } from "./layout";

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

const contains = (g: CanvasNode, n: CanvasNode): boolean =>
	n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;

const overlaps = (a: CanvasNode, b: CanvasNode): boolean =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Papers built from a tag list each, laid out, with the result indexed. */
function run(spec: Record<string, string[]>, extra: CanvasNode[] = []) {
	const cards = Object.keys(spec).map((id, i) => card(id, i * 700, 0));
	const tagOf = new Map(Object.entries(spec).map(([id, tags]) => [`papers/${id}.md`, tags]));
	const result = layoutByTag([...cards, ...extra], tagOf);
	const groups = result.nodes.filter((n) => n.type === "group" && n.id.startsWith(TAG_GROUP_PREFIX));
	const byId = new Map(result.nodes.map((n) => [n.id, n]));
	return { cards, tagOf, result, groups, byId };
}

/**
 * The property every layout must have: each card is fully inside or fully
 * clear of every group, and the groups it is inside are exactly its tags
 * (or exactly the one fallback group it was sent to).
 */
function expectExactMembership(r: ReturnType<typeof run>, spec: Record<string, string[]>): void {
	const fallback = new Set([...r.result.tooManyTags, ...r.result.undrawable]);
	for (const [id, tags] of Object.entries(spec)) {
		const node = r.byId.get(id)!;
		const inside: string[] = [];
		for (const g of r.groups) {
			if (contains(g, node)) inside.push(g.label!);
			else expect(overlaps(g, node), `${id} straddles ${g.label}`).toBe(false);
		}
		const expected =
			tags.length === 0
				? [UNTAGGED_LABEL]
				: fallback.has(node.file!)
					? [r.result.tooManyTags.includes(node.file!) ? TOO_MANY_TAGS_LABEL : UNDRAWABLE_LABEL]
					: tags.map((t) => `#${t}`);
		expect(inside.sort(), id).toEqual(expected.sort());
	}
}

describe("layoutByTag", () => {
	it("draws separate groups for tags no paper shares", () => {
		const spec = { a: ["optics"], b: ["ml"], c: ["optics"], d: [] };
		const r = run(spec);
		expect(r.groups.map((g) => g.label)).toEqual(["#ml", "#optics", UNTAGGED_LABEL]);
		for (const [i, g] of r.groups.entries()) {
			for (const h of r.groups.slice(i + 1)) expect(overlaps(g, h)).toBe(false);
		}
		expectExactMembership(r, spec);
	});

	it("puts a two-tag paper where both groups overlap, and single-tag papers outside the other", () => {
		const spec = { ab: ["A", "B"], a: ["A"], b: ["B"] };
		expectExactMembership(run(spec), spec);
	});

	it("draws every combination of three tags, triple included", () => {
		const spec = {
			a: ["A"], b: ["B"], c: ["C"],
			ab: ["A", "B"], bc: ["B", "C"], ac: ["A", "C"],
			abc: ["A", "B", "C"],
		};
		const r = run(spec);
		expect(r.result.undrawable).toEqual([]);
		expectExactMembership(r, spec);
	});

	it("treats tags case-insensitively and ignores a repeated tag", () => {
		const spec = { a: ["ML"], b: ["ml", "ml"] };
		const r = run(spec);
		expect(r.groups.map((g) => g.label)).toEqual(["#ML"]);
	});

	it("sends a paper with more than three tags to its own group and reports it", () => {
		const spec = { many: ["A", "B", "C", "D"], a: ["A"] };
		const r = run(spec);
		expect(r.result.tooManyTags).toEqual(["papers/many.md"]);
		expectExactMembership(r, spec);
	});

	it("reports a combination no rectangles can draw, and never puts it in a group it lacks", () => {
		// n rectangles divide the plane into at most 2n^2 - 2n + 2 regions (each
		// pair of borders crosses at most four times), so 12 tags have at most
		// 266 regions. All 220 triples plus 66 pairs need 286 distinct ones.
		const tags = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
		const spec: Record<string, string[]> = {};
		for (let i = 0; i < 12; i++) {
			for (let j = i + 1; j < 12; j++) {
				spec[`p${i}-${j}`] = [tags[i], tags[j]];
				for (let k = j + 1; k < 12; k++) spec[`p${i}-${j}-${k}`] = [tags[i], tags[j], tags[k]];
			}
		}
		const r = run(spec);
		expect(r.result.undrawable.length).toBeGreaterThan(0);
		expect(r.result.undrawable.length).toBeLessThan(Object.keys(spec).length);
		expectExactMembership(r, spec);
	});

	const shared = (): CanvasNode[] => [
		{ id: "mine", type: "text", text: "my note", x: -5000, y: -5000, width: 200, height: 100 },
		card("own", -4000, -4000),
		{ id: "g1", type: "group", label: "Mine", x: -9000, y: 0, width: 10, height: 10 },
	];

	it("keeps IDs, colours and non-paper nodes untouched", () => {
		const extra = shared();
		const spec = { a: ["A", "B"], b: ["B"] };
		const cards = [card("a", 0, 0, { color: "4" }), card("b", 700, 0)];
		const tagOf = new Map(Object.entries(spec).map(([id, t]) => [`papers/${id}.md`, t]));
		const out = layoutByTag([...cards, ...extra], tagOf).nodes;
		expect(out.find((n) => n.id === "a")!.color).toBe("4");
		for (const n of extra) expect(out).toContainEqual(n);
	});

	it("lists groups before cards, so cards are drawn on top", () => {
		const { result } = run({ a: ["A", "B"], b: ["B"], c: [] });
		const firstCard = result.nodes.findIndex((n) => n.type !== "group");
		expect(result.nodes.slice(firstCard).some((n) => n.type === "group")).toBe(false);
	});

	it("is idempotent: a second run reproduces the first", () => {
		const spec = { a: ["A", "B"], b: ["B", "C"], c: ["C"], d: ["A"], e: [], f: ["A", "B"] };
		const r = run(spec, shared());
		expect(layoutByTag(r.result.nodes, r.tagOf)).toEqual(r.result);
	});

	it("keeps publication order inside a cell, filling columns left to right", () => {
		const spec = { y1: ["t"], y2: ["t"], y3: ["t"], y4: ["t"], y5: ["t"] };
		const out = run(spec).result.nodes.filter((n) => n.type === "file");
		const order = [...out].sort((a, b) => a.x - b.x || a.y - b.y).map((n) => n.id);
		expect(order).toEqual(["y1", "y2", "y3", "y4", "y5"]);
		expect(new Set(out.map((n) => n.x)).size).toBe(3);
	});

	it("leaves a canvas with no papers alone", () => {
		const extra = shared();
		expect(layoutByTag(extra, new Map()).nodes).toEqual(extra);
	});
});

describe("layoutByTag and other groups", () => {
	const group = (id: string): CanvasNode => ({ id, type: "group", label: id, x: 5000, y: 0, width: 800, height: 1000 });

	it("drops the group Update from collection drew, since its papers move out", () => {
		const { result, byId } = run({ a: ["x"] }, [group(`${UPDATE_GROUP_PREFIX}abc`)]);
		expect(byId.has(`${UPDATE_GROUP_PREFIX}abc`)).toBe(false);
		expect(result.nodes.some((n) => n.id === "a")).toBe(true);
	});

	it("keeps a group the user drew", () => {
		const { byId } = run({ a: ["x"] }, [group("mine")]);
		expect(byId.get("mine")).toEqual(group("mine"));
	});
});
