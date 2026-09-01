import { describe, expect, it } from "vitest";
import { expandCanvas, resolveNewEdges } from "./builder";
import { paperNodeId } from "./layout";
import type { CanvasData, CanvasEdge, CitationEdge, Paper } from "../types";

const paper = (overrides: Partial<Paper> = {}): Paper => ({
	id: "10.1000/existing",
	title: "How Much Structure Is Needed",
	authors: ["S. Aaronson"],
	year: 2022,
	doi: "10.1000/existing",
	arxiv: null,
	citekey: null,
	semanticScholarId: null,
	abstract: null,
	citationCount: null,
	notePath: "papers/existing.md",
	...overrides,
});

const canvasWith = (p: Paper): CanvasData => ({
	nodes: [
		{
			id: paperNodeId(p),
			x: 0,
			y: 0,
			width: 600,
			height: 800,
			type: "file",
			file: p.notePath || "",
		},
	],
	edges: [],
});

const index = (papers: Paper[]): Map<string, Paper> => {
	const map = new Map<string, Paper>();
	for (const p of papers) {
		map.set(p.id, p);
		if (p.semanticScholarId) map.set(p.semanticScholarId, p);
	}
	return map;
};

describe("expandCanvas", () => {
	it("adds an edge when both endpoints name a paper's id", () => {
		const existing = paper();
		const added = paper({
			id: "10.1000/added",
			doi: "10.1000/added",
			title: "Entanglement-assisted quantum speedup",
			notePath: "papers/added.md",
		});

		const edges: CitationEdge[] = [{ fromId: added.id, toId: existing.id }];
		const result = expandCanvas(
			canvasWith(existing),
			[added],
			edges,
			index([existing, added]),
			600,
			800
		);

		expect(result.nodes).toHaveLength(2);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]).toMatchObject({
			fromNode: paperNodeId(added),
			toNode: paperNodeId(existing),
			toEnd: "arrow",
		});
	});

	it("resolves an endpoint naming a paper's Semantic Scholar id", () => {
		const existing = paper({ semanticScholarId: "s2-existing" });
		const added = paper({
			id: "10.1000/added",
			doi: "10.1000/added",
			semanticScholarId: "s2-added",
			notePath: "papers/added.md",
		});

		const result = expandCanvas(
			canvasWith(existing),
			[added],
			[{ fromId: "s2-added", toId: "s2-existing" }],
			index([existing, added]),
			600,
			800
		);

		expect(result.edges).toHaveLength(1);
		expect(result.edges[0].fromNode).toBe(paperNodeId(added));
	});

	// The bug this guards: a fallback source hands back a synthetic paperId
	// ("doi:…", "openalex:…") that s2PaperToPaper drops, so an edge built from
	// the raw paperId names an identifier no paper is indexed under. The paper
	// still lands on the canvas; only the arrow goes missing.
	it("drops an edge whose endpoint names an unindexed identifier", () => {
		const existing = paper();
		const added = paper({
			id: "10.1000/added",
			doi: "10.1000/added",
			notePath: "papers/added.md",
		});

		const result = expandCanvas(
			canvasWith(existing),
			[added],
			[{ fromId: "doi:10.1000/added", toId: existing.id }],
			index([existing, added]),
			600,
			800
		);

		expect(result.nodes).toHaveLength(2);
		expect(result.edges).toHaveLength(0);
	});

	it("does not duplicate an edge the canvas already carries", () => {
		const existing = paper();
		const added = paper({
			id: "10.1000/added",
			doi: "10.1000/added",
			notePath: "papers/added.md",
		});
		const canvas = canvasWith(existing);

		const first = expandCanvas(
			canvas,
			[added],
			[{ fromId: added.id, toId: existing.id }],
			index([existing, added]),
			600,
			800
		);
		const second = expandCanvas(
			first,
			[added],
			[{ fromId: added.id, toId: existing.id }],
			index([existing, added]),
			600,
			800
		);

		expect(second.nodes).toHaveLength(2);
		expect(second.edges).toHaveLength(1);
	});
});

describe("resolveNewEdges", () => {
	const a = paper({ id: "10.1000/a", doi: "10.1000/a", notePath: "papers/a.md" });
	const b = paper({ id: "10.1000/b", doi: "10.1000/b", notePath: "papers/b.md" });
	const nodeIds = new Set([paperNodeId(a), paperNodeId(b)]);

	it("returns the edges a canvas is missing", () => {
		const added = resolveNewEdges(
			[],
			nodeIds,
			[{ fromId: a.id, toId: b.id }],
			index([a, b])
		);

		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({
			fromNode: paperNodeId(a),
			toNode: paperNodeId(b),
			toEnd: "arrow",
		});
	});

	it("skips an edge the canvas already carries", () => {
		const existing: CanvasEdge[] = [
			{
				id: "whatever-obsidian-called-it",
				fromNode: paperNodeId(a),
				toNode: paperNodeId(b),
				fromSide: "left",
				toSide: "right",
				toEnd: "arrow",
			},
		];

		const added = resolveNewEdges(
			existing,
			nodeIds,
			[{ fromId: a.id, toId: b.id }],
			index([a, b])
		);

		expect(added).toHaveLength(0);
	});

	// Walking every paper sees each pair twice: once as A's reference, once as
	// B's citation.
	it("collapses the same edge offered twice in one run", () => {
		const added = resolveNewEdges(
			[],
			nodeIds,
			[
				{ fromId: a.id, toId: b.id },
				{ fromId: a.id, toId: b.id },
			],
			index([a, b])
		);

		expect(added).toHaveLength(1);
	});

	it("keeps both directions of a mutual citation", () => {
		const added = resolveNewEdges(
			[],
			nodeIds,
			[
				{ fromId: a.id, toId: b.id },
				{ fromId: b.id, toId: a.id },
			],
			index([a, b])
		);

		expect(added).toHaveLength(2);
	});

	it("drops an edge to a paper that has no node on the canvas", () => {
		const offCanvas = paper({ id: "10.1000/c", doi: "10.1000/c" });

		const added = resolveNewEdges(
			[],
			nodeIds,
			[{ fromId: a.id, toId: offCanvas.id }],
			index([a, b, offCanvas])
		);

		expect(added).toHaveLength(0);
	});
});
