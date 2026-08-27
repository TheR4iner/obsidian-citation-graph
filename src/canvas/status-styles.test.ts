import { describe, it, expect } from "vitest";
import { statusStyleRules } from "./status-styles";
import { DEFAULT_SETTINGS } from "../types";
import type { CitationGraphSettings } from "../types";

const settings = (over: Partial<CitationGraphSettings> = {}): CitationGraphSettings => ({
	...DEFAULT_SETTINGS,
	...over,
});

describe("statusStyleRules", () => {
	// The regression this file exists for: preset colours were once emitted as
	// a style query on the preset ID, which Obsidian never exposes as a value,
	// so every paper kept the default "To read" label whatever its colour.
	it("matches a preset colour by Obsidian's class, not by its ID", () => {
		const css = statusStyleRules(settings({ colorReading: "3" }));
		expect(css).toContain(".canvas-node.mod-canvas-color-3:has(.citation-graph-note)");
		expect(css).not.toContain("style(--canvas-color: 3)");
	});

	it("labels each configured status", () => {
		const css = statusStyleRules(
			settings({ colorReading: "3", colorRead: "5", colorAnnotated: "4", colorAbandoned: "1" })
		);
		expect(css).toContain('--cg-status-label: "Reading"');
		expect(css).toContain('--cg-status-label: "Read"');
		expect(css).toContain('--cg-status-label: "Read + notes written"');
		expect(css).toContain('--cg-status-label: "Abandoned"');
	});

	it("dashes and dims abandoned papers, and restores them on hover", () => {
		const css = statusStyleRules(settings({ colorAbandoned: "1" }));
		expect(css).toContain("border-style: dashed !important;");
		expect(css).toContain("opacity: 0.55;");
		expect(css).toContain(
			".canvas-node.mod-canvas-color-1:has(.citation-graph-note):hover .canvas-node-container { opacity: 1; }"
		);
	});

	it("leaves other statuses undashed", () => {
		const css = statusStyleRules(settings({ colorAbandoned: "", colorReading: "3" }));
		expect(css).not.toContain("dashed");
		expect(css).not.toContain("opacity");
	});

	// Custom colours all share one class, so only their value tells them apart.
	it("matches a custom colour by value under the custom class", () => {
		const css = statusStyleRules(settings({ colorRead: "#a1b2c3" }));
		expect(css).toContain("@container style(--canvas-color: #a1b2c3)");
		expect(css).toContain(".canvas-node.mod-canvas-color-custom:has(.citation-graph-note)");
	});

	// Obsidian normalises a custom colour to lowercase before setting it, so a
	// query built from an uppercase hex would never match.
	it("lowercases a custom colour so it matches what Obsidian sets", () => {
		const css = statusStyleRules(settings({ colorRead: "#A1B2C3" as `#${string}` }));
		expect(css).toContain("#a1b2c3");
		expect(css).not.toContain("#A1B2C3");
	});

	it("emits nothing for a status left on the uncoloured default", () => {
		const css = statusStyleRules(
			settings({ colorReading: "", colorRead: "", colorAnnotated: "", colorAbandoned: "" })
		);
		expect(css).toBe("");
	});
});
