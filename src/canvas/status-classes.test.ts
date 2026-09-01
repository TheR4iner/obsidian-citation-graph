import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { STATUS_LABELS } from "../types";
import type { DisplayStatus } from "../types";
import { withNoteClass } from "../notes/literature";

/**
 * Reading status is drawn entirely by `styles.css`, keyed on the cssclass the
 * plugin writes into each literature note. That split is what lets a theme
 * restyle a status, and it is what keeps the plugin from generating CSS at
 * runtime, which Obsidian does not allow.
 *
 * The cost of the split is that the class names and the label text live in two
 * files that no compiler checks against each other. These tests are that check.
 */
const stylesheet = fs.readFileSync(
	path.join(__dirname, "..", "..", "styles.css"),
	"utf8",
);

const STATUSES = Object.keys(STATUS_LABELS) as DisplayStatus[];

describe("status classes and styles.css", () => {
	it.each(STATUSES)("styles the class written for %s", (status) => {
		const [, statusClass] = withNoteClass([], status);
		expect(statusClass).toBe(`citation-graph-status-${status}`);
		expect(stylesheet).toContain(`.canvas-node:has(.${statusClass})`);
	});

	it.each(STATUSES)("labels %s with the text the rest of the UI uses", (status) => {
		expect(stylesheet).toContain(`--cg-status-label: "${STATUS_LABELS[status]}"`);
	});

	// The stylesheet must not name a status that no longer exists: such a rule
	// would never match and would quietly rot.
	it("styles no class the plugin does not write", () => {
		const styled = [
			...stylesheet.matchAll(/citation-graph-status-([a-z-]+)/g),
		].map((m) => m[1]);
		expect(new Set(styled)).toEqual(new Set(STATUSES));
	});

	// A node carrying two status classes would take whichever rule came last.
	it("never puts two status classes on one note", () => {
		const classes = withNoteClass(
			["citation-graph-status-read", "citation-graph-status-abandoned"],
			"reading",
		);
		expect(classes.filter((c) => c.startsWith("citation-graph-status-"))).toEqual([
			"citation-graph-status-reading",
		]);
	});
});
