import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Paper } from "../types";
import type { DownloadFallback } from "../api/download-fallback";
import { noticeLog } from "../../test/obsidian-stub";

// Which source a build ships is decided by this one function, so the tests
// drive it directly instead of reaching for a real one over the network.
const getDownloadFallback = vi.hoisted(() =>
	vi.fn<() => DownloadFallback | null>(() => null),
);
vi.mock("../api/fallback-source", () => ({ getDownloadFallback }));

import { buildPaperFilename, downloadPapers } from "./download-picker";

function makePaper(overrides: Partial<Paper> = {}): Paper {
	return {
		id: "p1",
		title: "A Paper",
		authors: ["Curie"],
		year: 1903,
		doi: null,
		arxiv: null,
		citekey: null,
		semanticScholarId: null,
		abstract: null,
		citationCount: null,
		notePath: null,
		...overrides,
	};
}

function makeFallback(overrides: Partial<DownloadFallback> = {}): DownloadFallback {
	return {
		name: "Test Source",
		isAvailable: async () => true,
		setupHint: "Install the prerequisite.",
		canAttempt: () => true,
		missingIdentifierHint: "This paper has no identifier the source can use.",
		download: async () => null,
		isSetupError: () => false,
		...overrides,
	};
}

/** The reason reported for a failed paper, without the "Failed: <title>" line. */
function lastFailureReason(): string {
	const failure = [...noticeLog].reverse().find((m) => m.startsWith("Failed: "));
	return failure ? failure.split("\n").slice(1).join("\n") : "";
}

describe("downloadPapers", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "citation-graph-test-"));
		noticeLog.length = 0;
		getDownloadFallback.mockReturnValue(null);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// No arXiv ID and no fallback is the public build's only failure mode, so
	// the message has to say that rather than blaming the paper.
	it("reports that no source is configured when the build has no fallback", async () => {
		const result = await downloadPapers([makePaper()], dir, "/plugin");

		expect(result).toEqual({ downloaded: 0, failed: ["A Paper"] });
		expect(lastFailureReason()).toContain("no other source is configured");
	});

	it("reports the fallback's setup hint when it is unavailable", async () => {
		getDownloadFallback.mockReturnValue(
			makeFallback({ isAvailable: async () => false }),
		);

		await downloadPapers([makePaper()], dir, "/plugin");

		expect(lastFailureReason()).toContain("Install the prerequisite.");
	});

	it("reports the fallback's identifier hint when it cannot attempt the paper", async () => {
		getDownloadFallback.mockReturnValue(
			makeFallback({ canAttempt: () => false }),
		);

		await downloadPapers([makePaper()], dir, "/plugin");

		expect(lastFailureReason()).toContain("no identifier the source can use");
	});

	it("names the source when it was tried and came back empty", async () => {
		getDownloadFallback.mockReturnValue(makeFallback());

		await downloadPapers([makePaper()], dir, "/plugin");

		expect(lastFailureReason()).toContain("Not available on arXiv or Test Source.");
	});

	// A missing prerequisite is true of every paper in the run. Reporting it
	// once per paper buries the one message that matters under N copies.
	it("surfaces a setup error once, however many papers hit it", async () => {
		getDownloadFallback.mockReturnValue(
			makeFallback({
				download: async () => {
					throw new Error("the prerequisite is not installed");
				},
				isSetupError: (message) => /not installed/.test(message),
			}),
		);

		const papers = [
			makePaper({ id: "a", title: "First" }),
			makePaper({ id: "b", title: "Second" }),
			makePaper({ id: "c", title: "Third" }),
		];
		const result = await downloadPapers(papers, dir, "/plugin");

		expect(result.failed).toEqual(["First", "Second", "Third"]);
		expect(noticeLog.filter((m) => m.includes("the prerequisite is not installed")))
			.toHaveLength(1);
	});

	// A per-paper error is not deduplicated: each one describes a different paper.
	it("surfaces a non-setup error for every paper", async () => {
		getDownloadFallback.mockReturnValue(
			makeFallback({
				download: async () => {
					throw new Error("that mirror refused the request");
				},
			}),
		);

		const papers = [makePaper({ id: "a" }), makePaper({ id: "b" })];
		await downloadPapers(papers, dir, "/plugin");

		expect(noticeLog.filter((m) => m.includes("that mirror refused"))).toHaveLength(2);
	});

	it("renames what the fallback saved to the formatted filename", async () => {
		const paper = makePaper({ title: "On Radioactivity", authors: ["Curie"], year: 1903 });
		getDownloadFallback.mockReturnValue(
			makeFallback({
				download: async (_paper, outputDir) => {
					const saved = path.join(outputDir, "raw-download.pdf");
					fs.writeFileSync(saved, "%PDF-1.4");
					return saved;
				},
			}),
		);

		const result = await downloadPapers([paper], dir, "/plugin");

		expect(result).toEqual({ downloaded: 1, failed: [] });
		expect(fs.readdirSync(dir)).toEqual([buildPaperFilename(paper, ".pdf")]);
	});

	it("passes the plugin directory to the fallback", async () => {
		const download = vi.fn(async () => null);
		getDownloadFallback.mockReturnValue(makeFallback({ download }));

		await downloadPapers([makePaper()], dir, "/vault/.obsidian/plugins/citation-graph");

		expect(download).toHaveBeenCalledWith(expect.anything(), dir, {
			pluginDir: "/vault/.obsidian/plugins/citation-graph",
		});
	});

	it("fails every paper when the download folder cannot be used", async () => {
		const unusable = path.join(dir, "a-file");
		fs.writeFileSync(unusable, "not a directory");

		const result = await downloadPapers([makePaper()], unusable, "/plugin");

		expect(result).toEqual({ downloaded: 0, failed: ["A Paper"] });
	});
});
