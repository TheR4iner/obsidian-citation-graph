import { describe, expect, it } from "vitest";
import {
	LiteratureNoteManager,
	bodyHasUserContent,
	readFrontmatterArxiv,
	withNoteClass,
} from "./literature";
import { makeNote } from "../../test/fakes";

const NOTE_CLASS = "citation-graph-note";

/** The note body createNote writes, before the user touches it. */
const scaffold = (opts: { doi?: boolean; arxiv?: boolean; notes?: string } = {}) =>
	`---
title: Attention Is All You Need
doi: 10.1000/xyz
status: unread
---

# Attention Is All You Need

**Authors**: A. Vaswani, N. Shazeer
**Year**: 2017
${opts.doi === false ? "" : "**DOI**: [10.1000/xyz](https://doi.org/10.1000/xyz)"}
${opts.arxiv === false ? "" : "**arXiv**: [1706.03762](https://arxiv.org/abs/1706.03762)"}

## Notes

${opts.notes ?? ""}`;

describe("bodyHasUserContent", () => {
	it("is false for an untouched generated note", () => {
		expect(bodyHasUserContent(scaffold())).toBe(false);
	});

	it("is false when the DOI and arXiv lines are blank", () => {
		expect(bodyHasUserContent(scaffold({ doi: false, arxiv: false }))).toBe(false);
	});

	it("is true for content written under '## Notes'", () => {
		expect(bodyHasUserContent(scaffold({ notes: "Key idea: scaled dot-product attention." }))).toBe(true);
	});

	it("counts a heading the user wrote in place of '## Notes', even when empty", () => {
		// Deliberate: only the exact generated `## Notes` heading is scaffold.
		// Renaming it is itself an act of engagement with the paper, so the
		// note counts as annotated before a word is written under it.
		expect(bodyHasUserContent(scaffold().replace("## Notes", "## Reading log"))).toBe(true);
	});

	it("is true for a custom heading with content under it", () => {
		const body = scaffold({ notes: "Dropped: no code." }).replace("## Notes", "## Reading log");
		expect(bodyHasUserContent(body)).toBe(true);
	});

	it("counts an LLM-written '## Summary' as content", () => {
		const body = scaffold().replace("## Notes", "## Summary\n\nTransformers replace recurrence.\n\n## Notes");
		expect(bodyHasUserContent(body)).toBe(true);
	});

	it("is false when '## Notes' is deleted entirely and nothing written", () => {
		expect(bodyHasUserContent(scaffold().replace("## Notes", ""))).toBe(false);
	});

	it("counts a checkbox list as content", () => {
		expect(bodyHasUserContent(scaffold({ notes: "- [ ] reread section 3" }))).toBe(true);
	});

	it("counts a blockquote as content", () => {
		expect(bodyHasUserContent(scaffold({ notes: "> attention is all you need" }))).toBe(true);
	});

	it("handles a note with no frontmatter at all", () => {
		const body = "# Attention Is All You Need\n\n**Year**: 2017\n\n## Notes\n";
		expect(bodyHasUserContent(body)).toBe(false);
		expect(bodyHasUserContent(body + "\nmy thoughts")).toBe(true);
	});

	it("is false for an untouched note with CRLF line endings", () => {
		expect(bodyHasUserContent(scaffold().replace(/\n/g, "\r\n"))).toBe(false);
	});

	it("is true for a CRLF note carrying notes", () => {
		const body = scaffold({ notes: "solid paper" }).replace(/\n/g, "\r\n");
		expect(bodyHasUserContent(body)).toBe(true);
	});

	it("is false for a title heading with no metadata lines", () => {
		expect(bodyHasUserContent("# Attention Is All You Need\n")).toBe(false);
	});

	it("counts a second '#' heading as content", () => {
		// Only the first `#` heading is the generated title; a second one is
		// something the user wrote.
		expect(bodyHasUserContent("# Attention Is All You Need\n\n# My take\n")).toBe(true);
	});

	it("ignores whitespace-only additions", () => {
		expect(bodyHasUserContent(scaffold({ notes: "   \n\t\n  " }))).toBe(false);
	});

	it("strips frontmatter containing '---' inside a value", () => {
		const body = `---
title: "A --- B"
doi: 10.1000/xyz
---

# A --- B

**Year**: 2017

## Notes
`;
		expect(bodyHasUserContent(body)).toBe(false);
	});
});

describe("readFrontmatterArxiv", () => {
	it("reads a quoted string through unchanged", () => {
		expect(readFrontmatterArxiv({ arxiv: "1706.03762" })).toBe("1706.03762");
	});

	it("stringifies a number, since YAML parses a bare arXiv ID as a float", () => {
		expect(readFrontmatterArxiv({ arxiv: 2108.07909 })).toBe("2108.07909");
	});

	it("returns null for missing, null and empty values", () => {
		expect(readFrontmatterArxiv({})).toBeNull();
		expect(readFrontmatterArxiv({ arxiv: null })).toBeNull();
		expect(readFrontmatterArxiv({ arxiv: "" })).toBeNull();
		expect(readFrontmatterArxiv(undefined)).toBeNull();
		expect(readFrontmatterArxiv(null)).toBeNull();
	});
});

describe("withNoteClass", () => {
	it("writes no per-status class", () => {
		// Status comes from the canvas node colour now, not a cssclass.
		expect(withNoteClass([])).toEqual([NOTE_CLASS]);
		expect(withNoteClass(["citation-graph-status-reading"])).toEqual([NOTE_CLASS]);
	});

	it("strips a stale status class but keeps the user's own", () => {
		expect(withNoteClass(["citation-graph-status-read", "wide-page"])).toEqual([
			NOTE_CLASS,
			"wide-page",
		]);
	});

	it("adds the marker class to an adopted note", () => {
		expect(withNoteClass(["wide-page"])).toEqual([NOTE_CLASS, "wide-page"]);
	});

	it("normalizes a string cssclasses value into a list", () => {
		expect(withNoteClass("wide-page")).toEqual([NOTE_CLASS, "wide-page"]);
	});

	it("does not duplicate the marker class", () => {
		expect(withNoteClass([NOTE_CLASS, "wide-page"])).toEqual([NOTE_CLASS, "wide-page"]);
	});

	it("drops empty entries and missing values", () => {
		expect(withNoteClass(["", "  ", "wide-page"])).toEqual([NOTE_CLASS, "wide-page"]);
		expect(withNoteClass(undefined)).toEqual([NOTE_CLASS]);
		expect(withNoteClass(null)).toEqual([NOTE_CLASS]);
	});
});

describe("LiteratureNoteManager.isPaperNote", () => {
	const isPaperNote = (fm: Record<string, unknown> | null): boolean => {
		const note = makeNote({ fm });
		return new LiteratureNoteManager(note.app, "papers").isPaperNote(note.file);
	};

	it("accepts a plugin-created note, whose id fields are present but null", () => {
		expect(
			isPaperNote({
				title: "Attention Is All You Need",
				doi: null,
				arxiv: null,
				citekey: null,
				semantic_scholar_id: null,
			})
		).toBe(true);
	});

	it("accepts an adopted note carrying a real DOI", () => {
		expect(isPaperNote({ title: "A paper", doi: "10.1000/xyz" })).toBe(true);
	});

	it("accepts an adopted note carrying only an arXiv ID", () => {
		expect(isPaperNote({ arxiv: "1706.03762" })).toBe(true);
	});

	it("accepts an adopted note carrying only a citekey", () => {
		expect(isPaperNote({ citekey: "vaswani2017attention" })).toBe(true);
	});

	it("rejects the user's own note, which has no id fields", () => {
		// A regression here stamped a user's note with a status they could not
		// change, and would have wiped a colour they set by hand.
		expect(isPaperNote({ title: "Thesis outline", tags: ["writing"] })).toBe(false);
	});

	it("rejects a note with unrelated frontmatter", () => {
		expect(isPaperNote({ aliases: ["outline"], cssclasses: ["wide-page"] })).toBe(false);
	});

	it("rejects a note with no frontmatter at all", () => {
		expect(isPaperNote(null)).toBe(false);
	});

	it("rejects a note titled like a paper but carrying no ids", () => {
		expect(isPaperNote({ title: "Attention Is All You Need", year: 2017 })).toBe(false);
	});
});

describe("LiteratureNoteManager.getStatus", () => {
	const getStatus = (fm: Record<string, unknown> | null) => {
		const note = makeNote({ fm });
		return new LiteratureNoteManager(note.app, "papers").getStatus(note.file);
	};

	it("reads a stored status", () => {
		expect(getStatus({ status: "reading" })).toBe("reading");
		expect(getStatus({ status: "abandoned" })).toBe("abandoned");
	});

	it("reads legacy 'read: true' as read", () => {
		expect(getStatus({ read: true })).toBe("read");
	});

	it("reads legacy 'read: false' as unread", () => {
		expect(getStatus({ read: false })).toBe("unread");
	});

	it("reads a note with no frontmatter as unread", () => {
		expect(getStatus(null)).toBe("unread");
	});

	it("prefers 'status' over the legacy 'read' field", () => {
		expect(getStatus({ status: "reading", read: true })).toBe("reading");
	});

	it("falls back to the legacy field when 'status' is junk", () => {
		expect(getStatus({ status: "finished", read: true })).toBe("read");
	});
});

describe("LiteratureNoteManager.setStatus", () => {
	it("writes the status and drops the legacy 'read' field", () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz", read: true } });
		const manager = new LiteratureNoteManager(note.app, "papers");
		return manager.setStatus(note.file, "reading").then(() => {
			expect(note.fm()).toEqual({
				doi: "10.1000/xyz",
				status: "reading",
				cssclasses: [NOTE_CLASS],
			});
		});
	});

	it("writes no per-status class", async () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz" } });
		await new LiteratureNoteManager(note.app, "papers").setStatus(note.file, "read");
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS]);
	});

	it("strips a stale status class and keeps the user's own", async () => {
		const note = makeNote({
			fm: { doi: "10.1000/xyz", cssclasses: ["citation-graph-status-unread", "wide-page"] },
		});
		await new LiteratureNoteManager(note.app, "papers").setStatus(note.file, "read");
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS, "wide-page"]);
	});

	it("gives an adopted note the marker class", async () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz" } });
		await new LiteratureNoteManager(note.app, "papers").setStatus(note.file, "unread");
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS]);
	});

	it("normalizes a string cssclasses value and preserves it", async () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz", cssclasses: "wide-page" } });
		await new LiteratureNoteManager(note.app, "papers").setStatus(note.file, "unread");
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS, "wide-page"]);
	});
});

describe("LiteratureNoteManager.syncNoteClass", () => {
	it("is a no-op when the note is already clean", async () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz", cssclasses: [NOTE_CLASS] } });
		const changed = await new LiteratureNoteManager(note.app, "papers").syncNoteClass(note.file);
		expect(changed).toBe(false);
	});

	it("rewrites a note carrying a stale status class", async () => {
		const note = makeNote({
			fm: { doi: "10.1000/xyz", cssclasses: [NOTE_CLASS, "citation-graph-status-read"] },
		});
		const changed = await new LiteratureNoteManager(note.app, "papers").syncNoteClass(note.file);
		expect(changed).toBe(true);
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS]);
	});

	it("leaves only the marker class behind", async () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz" } });
		await new LiteratureNoteManager(note.app, "papers").syncNoteClass(note.file);
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS]);
	});
});

describe("LiteratureNoteManager.ensureNoteClass", () => {
	it("adds the marker class to an adopted note", async () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz", cssclasses: ["wide-page"] } });
		await new LiteratureNoteManager(note.app, "papers").ensureNoteClass(note.file);
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS, "wide-page"]);
	});

	it("leaves a note that already carries it untouched", async () => {
		const note = makeNote({ fm: { doi: "10.1000/xyz", cssclasses: [NOTE_CLASS, "wide-page"] } });
		await new LiteratureNoteManager(note.app, "papers").ensureNoteClass(note.file);
		expect(note.fm()?.cssclasses).toEqual([NOTE_CLASS, "wide-page"]);
	});
});

describe("LiteratureNoteManager.displayStatusFor", () => {
	const displayStatus = (fm: Record<string, unknown>, body: string) => {
		const note = makeNote({ fm, body });
		const manager = new LiteratureNoteManager(note.app, "papers");
		return manager.displayStatusFor(note.file, manager.getStatus(note.file));
	};

	it("leaves 'read' alone on an empty note", async () => {
		expect(await displayStatus({ status: "read" }, scaffold())).toBe("read");
	});

	it("derives 'annotated' from a read note carrying notes", async () => {
		expect(await displayStatus({ status: "read" }, scaffold({ notes: "good" }))).toBe("annotated");
	});

	it("derives 'annotated' from an unread note carrying notes", async () => {
		expect(await displayStatus({ status: "unread" }, scaffold({ notes: "good" }))).toBe("annotated");
	});

	it("keeps an abandoned note abandoned even when it carries notes", async () => {
		// Notes on an abandoned paper are usually a record of why it was dropped.
		expect(await displayStatus({ status: "abandoned" }, scaffold({ notes: "no code" }))).toBe(
			"abandoned"
		);
	});

	it("leaves 'reading' alone on an empty note", async () => {
		expect(await displayStatus({ status: "reading" }, scaffold())).toBe("reading");
	});
});
