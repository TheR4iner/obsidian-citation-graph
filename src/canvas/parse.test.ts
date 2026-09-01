import { describe, expect, it } from "vitest";
import { parseCanvasData } from "./parse";

describe("parseCanvasData", () => {
	it("reads the empty file Obsidian writes for a new canvas as an empty graph", () => {
		expect(parseCanvasData("", "Papers/new.canvas")).toEqual({
			nodes: [],
			edges: [],
		});
	});

	it("treats a whitespace-only file the same way", () => {
		expect(parseCanvasData("\n  \n", "Papers/new.canvas")).toEqual({
			nodes: [],
			edges: [],
		});
	});

	it("fills in nodes and edges missing from an otherwise valid canvas", () => {
		expect(parseCanvasData("{}", "Papers/emptied.canvas")).toEqual({
			nodes: [],
			edges: [],
		});
	});

	it("keeps nodes, edges and the citation graph metadata block", () => {
		const content = JSON.stringify({
			nodes: [{ id: "cg-1", x: 0, y: 0, width: 600, height: 800, type: "file", file: "a.md" }],
			edges: [{ id: "e1", fromNode: "cg-1", fromSide: "right", toNode: "cg-2", toSide: "left" }],
			citationGraphMeta: { collectionName: "Quantum" },
		});
		const parsed = parseCanvasData<{ citationGraphMeta?: { collectionName: string } }>(
			content,
			"Papers/full.canvas"
		);
		expect(parsed.nodes).toHaveLength(1);
		expect(parsed.edges).toHaveLength(1);
		expect(parsed.citationGraphMeta?.collectionName).toBe("Quantum");
	});

	it("names the file when the content is not valid JSON", () => {
		expect(() => parseCanvasData("{ nope", "Papers/broken.canvas")).toThrow(
			/Papers\/broken\.canvas is not valid canvas JSON/
		);
	});

	it("rejects valid JSON that is not a canvas object", () => {
		expect(() => parseCanvasData("[1, 2]", "Papers/array.canvas")).toThrow(
			/expected an object, got an array/
		);
	});
});
