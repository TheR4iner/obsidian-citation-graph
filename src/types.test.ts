import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	isCustomColor,
	nextStatusInCycle,
	parsePaperStatus,
	parseStatusColor,
	statusColor,
} from "./types";
import type { CitationGraphSettings, PaperStatus } from "./types";

describe("parsePaperStatus", () => {
	it("parses a valid status", () => {
		expect(parsePaperStatus("reading")).toBe("reading");
		expect(parsePaperStatus("abandoned")).toBe("abandoned");
	});

	it("is case and space tolerant", () => {
		expect(parsePaperStatus("  READING ")).toBe("reading");
		expect(parsePaperStatus("Read")).toBe("read");
	});

	it("rejects 'annotated', which is derived and never stored", () => {
		expect(parsePaperStatus("annotated")).toBeNull();
	});

	it("rejects junk, booleans and undefined", () => {
		expect(parsePaperStatus("finished")).toBeNull();
		expect(parsePaperStatus(true)).toBeNull();
		expect(parsePaperStatus(undefined)).toBeNull();
		expect(parsePaperStatus(null)).toBeNull();
		expect(parsePaperStatus(3)).toBeNull();
	});
});

describe("nextStatusInCycle", () => {
	it("cycles unread -> reading -> read -> unread", () => {
		expect(nextStatusInCycle("unread")).toBe("reading");
		expect(nextStatusInCycle("reading")).toBe("read");
		expect(nextStatusInCycle("read")).toBe("unread");
	});

	it("re-enters the cycle at unread from abandoned", () => {
		expect(nextStatusInCycle("abandoned")).toBe("unread");
	});
});

describe("parseStatusColor", () => {
	it("passes a preset ID through", () => {
		expect(parseStatusColor("3")).toBe("3");
		expect(parseStatusColor("6")).toBe("6");
	});

	it("treats the empty string as no colour", () => {
		expect(parseStatusColor("")).toBe("");
	});

	it("accepts a full hex colour", () => {
		expect(parseStatusColor("#a1b2c3")).toBe("#a1b2c3");
	});

	it("normalizes uppercase hex to lowercase", () => {
		expect(parseStatusColor("#A1B2C3")).toBe("#a1b2c3");
	});

	it("trims surrounding whitespace", () => {
		expect(parseStatusColor("  #a1b2c3  ")).toBe("#a1b2c3");
		expect(parseStatusColor(" 4 ")).toBe("4");
	});

	it("rejects 3-digit and 8-digit hex", () => {
		expect(parseStatusColor("#abc")).toBe("");
		expect(parseStatusColor("#a1b2c3d4")).toBe("");
	});

	it("rejects hex without the leading hash", () => {
		expect(parseStatusColor("a1b2c3")).toBe("");
	});

	it("rejects non-hex letters", () => {
		expect(parseStatusColor("#gggggg")).toBe("");
	});

	it("rejects a partially typed value", () => {
		// The settings field validates on every keystroke, so half-typed hex
		// must not be accepted as a colour and written to a canvas.
		expect(parseStatusColor("#")).toBe("");
		expect(parseStatusColor("#a1b")).toBe("");
		expect(parseStatusColor("#a1b2c")).toBe("");
	});

	it("rejects an out-of-range preset ID", () => {
		expect(parseStatusColor("7")).toBe("");
		expect(parseStatusColor("0")).toBe("");
		expect(parseStatusColor("-1")).toBe("");
	});

	it("rejects a CSS injection attempt", () => {
		// The result is written into the user's .canvas file, so anything that
		// is not a colour is data corruption at best.
		expect(parseStatusColor("red; --x:1")).toBe("");
		expect(parseStatusColor("#a1b2c3; --x:1")).toBe("");
		expect(parseStatusColor("var(--danger)")).toBe("");
	});

	it("rejects non-string values", () => {
		expect(parseStatusColor(3)).toBe("");
		expect(parseStatusColor(null)).toBe("");
		expect(parseStatusColor(undefined)).toBe("");
		expect(parseStatusColor({ toString: () => "#a1b2c3" })).toBe("");
	});
});

describe("isCustomColor", () => {
	it("is true for hex", () => {
		expect(isCustomColor("#a1b2c3")).toBe(true);
		expect(isCustomColor("#A1B2C3")).toBe(true);
	});

	it("is false for a preset ID", () => {
		expect(isCustomColor("3")).toBe(false);
	});

	it("is false for the empty string", () => {
		expect(isCustomColor("")).toBe(false);
	});
});

describe("statusColor", () => {
	const settings = (overrides: Partial<CitationGraphSettings>): CitationGraphSettings => ({
		...DEFAULT_SETTINGS,
		...overrides,
	});

	it("returns a configured hex colour", () => {
		expect(statusColor(settings({ colorReading: "#a1b2c3" }), "reading")).toBe("#a1b2c3");
	});

	it("returns no colour for the default unread status", () => {
		expect(statusColor(DEFAULT_SETTINGS, "unread")).toBe("");
	});

	it("falls back to no colour for a corrupt stored value", () => {
		// data.json is hand-editable, so an invalid colour must not reach the
		// canvas file.
		const corrupt = settings({ colorRead: "red; --x:1" as CitationGraphSettings["colorRead"] });
		expect(statusColor(corrupt, "read")).toBe("");
	});

	it("covers every display status", () => {
		const statuses: PaperStatus[] = ["unread", "reading", "read", "abandoned"];
		for (const status of [...statuses, "annotated" as const]) {
			expect(typeof statusColor(DEFAULT_SETTINGS, status)).toBe("string");
		}
	});
});
