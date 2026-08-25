import { describe, expect, it } from "vitest";
import { hasSummarySection, insertSummaryText } from "./summary-text";

const SUMMARY = "Transformers replace recurrence with attention.";

const note = (body: string) => `# Attention Is All You Need

**Year**: 2017
${body}`;

describe("hasSummarySection", () => {
	it("finds a generated summary heading", () => {
		expect(hasSummarySection(note("## Summary\n\nold text\n"))).toBe(true);
	});

	it("tolerates trailing whitespace and a CR on the heading line", () => {
		expect(hasSummarySection(note("## Summary  \n"))).toBe(true);
		expect(hasSummarySection(note("## Summary\r\n"))).toBe(true);
	});

	it("is false for a note with no summary", () => {
		expect(hasSummarySection(note("## Notes\n\nmine\n"))).toBe(false);
	});

	it("does not match a deeper heading that merely starts the same way", () => {
		// Plain indexOf("## Summary") matches one character into
		// "### Summary of results", and splicing from there rewrites the
		// wrong heading.
		expect(hasSummarySection(note("### Summary of results\n"))).toBe(false);
	});

	it("does not match a heading with trailing words", () => {
		expect(hasSummarySection(note("## Summary of results\n"))).toBe(false);
	});
});

describe("insertSummaryText, mode 'new'", () => {
	it("inserts above the '## Notes' heading, leaving the user's notes below", () => {
		const result = insertSummaryText(note("## Notes\n\nmy thoughts\n"), SUMMARY, "new");
		expect(result).toBe(note(`## Summary\n\n${SUMMARY}\n\n## Notes\n\nmy thoughts\n`));
	});

	it("recognises a '## Notes' heading the user appended text to", () => {
		const result = insertSummaryText(note("## Notes on method\n\nmine\n"), SUMMARY, "new");
		expect(result).toContain(`## Summary\n\n${SUMMARY}\n\n## Notes on method`);
	});

	it("appends a new section when the note has no '## Notes' heading", () => {
		const result = insertSummaryText(note("some prose\n"), SUMMARY, "new");
		expect(result).toBe(note("some prose") + `\n\n## Summary\n\n${SUMMARY}\n`);
	});

	it("does not leave a run of blank lines when appending", () => {
		const result = insertSummaryText(note("some prose\n\n\n\n"), SUMMARY, "new");
		expect(result).not.toMatch(/\n{3}/);
	});
});

describe("insertSummaryText, mode 'append'", () => {
	it("adds a rule and the new text below the existing summary", () => {
		const result = insertSummaryText(note("## Summary\n\nold text\n"), SUMMARY, "append");
		expect(result).toBe(note(`## Summary\n\nold text\n\n---\n\n${SUMMARY}\n`));
	});

	it("stays inside the summary section, above the next heading", () => {
		const result = insertSummaryText(
			note("## Summary\n\nold text\n\n## Notes\n\nmine\n"),
			SUMMARY,
			"append"
		);
		expect(result).toBe(
			note(`## Summary\n\nold text\n\n---\n\n${SUMMARY}\n\n## Notes\n\nmine\n`)
		);
	});

	it("degrades to appending a new section when the summary was edited away", () => {
		// The note is re-read between the hasSummarySection() check and this
		// call, so it may have lost its summary in the meantime. Splicing at
		// offset -1 would corrupt it.
		const result = insertSummaryText(note("## Notes\n\nmine\n"), SUMMARY, "append");
		expect(result).toBe(note("## Notes\n\nmine") + `\n\n## Summary\n\n${SUMMARY}\n`);
	});
});

describe("insertSummaryText, mode 'replace'", () => {
	it("replaces the summary and keeps the following section", () => {
		const result = insertSummaryText(
			note("## Summary\n\nold text\n\n## Notes\n\nmine\n"),
			SUMMARY,
			"replace"
		);
		expect(result).toBe(note(`## Summary\n\n${SUMMARY}\n\n## Notes\n\nmine\n`));
	});

	it("replaces a summary that is the last section in the note", () => {
		const result = insertSummaryText(note("## Summary\n\nold text\n"), SUMMARY, "replace");
		expect(result).toBe(note(`## Summary\n\n${SUMMARY}\n`));
		expect(result).not.toContain("old text");
	});

	it("replaces a multi-paragraph summary in full", () => {
		const old = "## Summary\n\npara one\n\npara two\n\n- a point\n\n## Notes\n\nmine\n";
		const result = insertSummaryText(note(old), SUMMARY, "replace");
		expect(result).toBe(note(`## Summary\n\n${SUMMARY}\n\n## Notes\n\nmine\n`));
	});

	it("leaves everything above the summary untouched", () => {
		const result = insertSummaryText(
			note("## Notes\n\nmine\n\n## Summary\n\nold text\n"),
			SUMMARY,
			"replace"
		);
		expect(result).toBe(note(`## Notes\n\nmine\n\n## Summary\n\n${SUMMARY}\n`));
	});

	it("does not rewrite a deeper heading that starts the same way", () => {
		const body = "### Summary of results\n\nkeep me\n\n## Summary\n\nold text\n";
		const result = insertSummaryText(note(body), SUMMARY, "replace");
		expect(result).toContain("### Summary of results\n\nkeep me");
		expect(result).not.toContain("old text");
	});

	it("degrades to appending a new section when the summary was edited away", () => {
		const result = insertSummaryText(note("## Notes\n\nmine\n"), SUMMARY, "replace");
		expect(result).toBe(note("## Notes\n\nmine") + `\n\n## Summary\n\n${SUMMARY}\n`);
	});
});
