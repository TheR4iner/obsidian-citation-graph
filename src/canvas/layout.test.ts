import { describe, expect, it } from "vitest";
import {
	hasPaperNode,
	legacyPaperNodeId,
	paperNodeId,
	paperNodeIdCandidates,
	resolvePaperNodeId,
} from "./layout";
import type { Paper } from "../types";

const paper = (overrides: Partial<Paper> = {}): Paper => ({
	id: "s2:abc",
	title: "Attention Is All You Need",
	authors: ["A. Vaswani"],
	year: 2017,
	doi: null,
	arxiv: null,
	citekey: null,
	semanticScholarId: null,
	abstract: null,
	citationCount: null,
	notePath: null,
	...overrides,
});

describe("paperNodeId", () => {
	it("is stable across calls", () => {
		const p = paper({ doi: "10.1000/xyz" });
		expect(paperNodeId(p)).toBe(paperNodeId(paper({ doi: "10.1000/xyz" })));
	});

	it("is prefixed and fixed-width, so IDs stay recognisable in a .canvas file", () => {
		expect(paperNodeId(paper({ doi: "10.1000/xyz" }))).toMatch(/^cg-[0-9a-z]{14}$/);
	});

	it("keys on the DOI in preference to every other identifier", () => {
		const withDoi = paper({ doi: "10.1000/xyz", arxiv: "1706.03762", semanticScholarId: "abc" });
		const doiOnly = paper({ doi: "10.1000/xyz" });
		expect(paperNodeId(withDoi)).toBe(paperNodeId(doiOnly));
	});

	it("falls back to arXiv, then S2 ID, then the paper's own id", () => {
		expect(paperNodeId(paper({ arxiv: "1706.03762", semanticScholarId: "abc" }))).toBe(
			paperNodeId(paper({ arxiv: "1706.03762" }))
		);
		expect(paperNodeId(paper({ semanticScholarId: "abc" }))).toBe(
			paperNodeId(paper({ id: "abc", semanticScholarId: "abc" }))
		);
		expect(paperNodeId(paper({ id: "fallback" }))).toMatch(/^cg-/);
	});

	it("distinguishes papers that differ only slightly", () => {
		// A collision is silent: two papers share one node, so one of them
		// simply never appears on the canvas.
		const ids = new Set(
			["10.1000/xyz1", "10.1000/xyz2", "10.1000/xyy1", "10.1000/zyx1"].map((doi) =>
				paperNodeId(paper({ doi }))
			)
		);
		expect(ids.size).toBe(4);
	});

	it("does not collide across a large synthetic corpus", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 20000; i++) ids.add(paperNodeId(paper({ doi: `10.1000/paper.${i}` })));
		expect(ids.size).toBe(20000);
	});

	it("differs from the pre-widening ID for the same paper", () => {
		const p = paper({ doi: "10.1000/xyz" });
		expect(paperNodeId(p)).not.toBe(legacyPaperNodeId(p));
	});
});

describe("legacyPaperNodeId", () => {
	it("is stable, because it is persisted in the user's .canvas files", () => {
		// This is a storage format, not an internal detail: canvases written
		// before the hash was widened still carry these IDs forever.
		expect(legacyPaperNodeId(paper({ doi: "10.1000/xyz" }))).toBe("cg-5hadaw");
		expect(legacyPaperNodeId(paper({ arxiv: "1706.03762" }))).toBe("cg-uuzbzm");
	});

	it("keys on the same identifier precedence as the current scheme", () => {
		const withDoi = paper({ doi: "10.1000/xyz", arxiv: "1706.03762" });
		expect(legacyPaperNodeId(withDoi)).toBe(legacyPaperNodeId(paper({ doi: "10.1000/xyz" })));
	});
});

describe("paperNodeIdCandidates", () => {
	it("offers the current scheme first, then the legacy one", () => {
		const p = paper({ doi: "10.1000/xyz" });
		expect(paperNodeIdCandidates(p)).toEqual([paperNodeId(p), legacyPaperNodeId(p)]);
	});
});

describe("hasPaperNode", () => {
	const p = paper({ doi: "10.1000/xyz" });

	it("finds a node stored under the current ID", () => {
		expect(hasPaperNode(p, new Set([paperNodeId(p)]))).toBe(true);
	});

	it("finds a node stored under the legacy ID", () => {
		// Without this fallback, expandCanvas re-adds every paper on a canvas
		// written before the widening, duplicating the whole thing.
		expect(hasPaperNode(p, new Set([legacyPaperNodeId(p)]))).toBe(true);
	});

	it("is false on an empty canvas", () => {
		expect(hasPaperNode(p, new Set())).toBe(false);
	});

	it("is false when the canvas holds a different paper", () => {
		expect(hasPaperNode(p, new Set([paperNodeId(paper({ doi: "10.1000/abc" }))]))).toBe(false);
	});
});

describe("resolvePaperNodeId", () => {
	const p = paper({ doi: "10.1000/xyz" });

	it("returns the current ID when the canvas already uses it", () => {
		expect(resolvePaperNodeId(p, new Set([paperNodeId(p)]))).toBe(paperNodeId(p));
	});

	it("returns the legacy ID when that is the one on the canvas", () => {
		// Updating a node's colour must address the node that is actually
		// there, rather than writing a second one alongside it.
		expect(resolvePaperNodeId(p, new Set([legacyPaperNodeId(p)]))).toBe(legacyPaperNodeId(p));
	});

	it("prefers the current ID when a canvas somehow carries both", () => {
		const ids = new Set([paperNodeId(p), legacyPaperNodeId(p)]);
		expect(resolvePaperNodeId(p, ids)).toBe(paperNodeId(p));
	});

	it("falls back to the current ID for a paper not on the canvas yet", () => {
		expect(resolvePaperNodeId(p, new Set())).toBe(paperNodeId(p));
	});
});
