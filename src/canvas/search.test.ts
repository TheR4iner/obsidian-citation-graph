import { describe, expect, it } from "vitest";
import { matchesPaperQuery } from "./search";

const paper = {
	title: "Attention Is All You Need",
	authors: ["Ashish Vaswani", "Erwin Schrödinger"],
};

describe("matchesPaperQuery", () => {
	it("matches title and author words in any order, ignoring case", () => {
		expect(matchesPaperQuery(paper, "attention")).toBe(true);
		expect(matchesPaperQuery(paper, "vaswani ATTENTION")).toBe(true);
	});

	it("needs every word to match", () => {
		expect(matchesPaperQuery(paper, "attention transformer")).toBe(false);
	});

	it("ignores accents", () => {
		expect(matchesPaperQuery(paper, "schrodinger")).toBe(true);
	});

	it("matches nothing for an empty query", () => {
		expect(matchesPaperQuery(paper, "   ")).toBe(false);
	});
});
