import { describe, expect, it, vi } from "vitest";
import type { Paper } from "../types";
import type { S2Paper } from "../types";
import {
	arxivIdFromDoi,
	arxivIdFromUrl,
	findArxivId,
	titlesIdentical,
} from "./arxiv-lookup";
import type { ArxivMetadataClient } from "./arxiv-metadata";
import type { OpenAlexClient } from "./openalex";

function makePaper(overrides: Partial<Paper> = {}): Paper {
	return {
		id: "p1",
		title: "Attention Is All You Need",
		authors: ["Vaswani"],
		year: 2017,
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

function makeClients(opts: { urls?: string[]; hits?: S2Paper[] } = {}) {
	const getLocationUrlsForDoi = vi.fn(async () => opts.urls ?? []);
	const searchByTitle = vi.fn(async () => opts.hits ?? []);
	return {
		clients: {
			openalex: { getLocationUrlsForDoi } as unknown as OpenAlexClient,
			arxiv: { searchByTitle } as unknown as ArxivMetadataClient,
		},
		getLocationUrlsForDoi,
		searchByTitle,
	};
}

function makeHit(arxiv: string, title: string): S2Paper {
	return {
		paperId: `arxiv:${arxiv}`,
		externalIds: { ArXiv: arxiv },
		title,
		year: 2017,
		authors: [],
		abstract: null,
		citationCount: null,
	};
}

describe("arxivIdFromDoi", () => {
	it("reads the ID out of an arXiv-minted DOI", () => {
		expect(arxivIdFromDoi("10.48550/arXiv.1706.03762")).toBe("1706.03762");
	});

	it("is case-insensitive about the arXiv segment", () => {
		expect(arxivIdFromDoi("10.48550/ARXIV.1706.03762")).toBe("1706.03762");
	});

	it("returns null for a publisher DOI", () => {
		expect(arxivIdFromDoi("10.1103/PhysRevX.1.011001")).toBeNull();
	});

	it("returns null for nothing at all", () => {
		expect(arxivIdFromDoi(null)).toBeNull();
	});
});

describe("arxivIdFromUrl", () => {
	it("reads an abs URL", () => {
		expect(arxivIdFromUrl("https://arxiv.org/abs/1706.03762")).toBe("1706.03762");
	});

	it("reads a versioned pdf URL", () => {
		expect(arxivIdFromUrl("http://arxiv.org/pdf/1706.03762v5")).toBe("1706.03762v5");
	});

	it("ignores a URL somewhere else entirely", () => {
		expect(arxivIdFromUrl("https://link.aps.org/doi/10.1103/PhysRevX.1.011001")).toBeNull();
	});

	// A host merely ending in the string is a different site.
	it("ignores a lookalike host", () => {
		expect(arxivIdFromUrl("https://notarxiv.org.example.com/abs/1706.03762")).toBeNull();
	});
});

describe("titlesIdentical", () => {
	it("ignores case, punctuation and spacing", () => {
		expect(titlesIdentical("Attention Is All You Need", "attention is all you need.")).toBe(true);
		expect(titlesIdentical("Non-Local Neural Networks", "Non Local Neural Networks")).toBe(true);
	});

	it("rejects a prefix, which is a different paper", () => {
		expect(titlesIdentical("Attention Is All You Need", "Attention Is All You Need II")).toBe(false);
	});

	it("rejects two empty titles rather than calling them equal", () => {
		expect(titlesIdentical("", "")).toBe(false);
	});
});

describe("findArxivId", () => {
	it("uses an ID the paper already carries without asking anyone", async () => {
		const { clients, getLocationUrlsForDoi, searchByTitle } = makeClients();

		expect(await findArxivId(makePaper({ arxiv: "1706.03762" }), clients)).toBe("1706.03762");
		expect(getLocationUrlsForDoi).not.toHaveBeenCalled();
		expect(searchByTitle).not.toHaveBeenCalled();
	});

	it("reads an arXiv-minted DOI without a network call", async () => {
		const { clients, getLocationUrlsForDoi } = makeClients();
		const paper = makePaper({ doi: "10.48550/arXiv.1706.03762" });

		expect(await findArxivId(paper, clients)).toBe("1706.03762");
		expect(getLocationUrlsForDoi).not.toHaveBeenCalled();
	});

	// The case the whole module exists for.
	it("finds the preprint behind a publisher DOI via OpenAlex", async () => {
		const { clients, searchByTitle } = makeClients({
			urls: [
				"https://link.aps.org/doi/10.1103/PhysRevX.1.011001",
				"https://arxiv.org/abs/1706.03762",
			],
		});

		expect(await findArxivId(makePaper({ doi: "10.1103/PhysRevX.1.011001" }), clients)).toBe(
			"1706.03762",
		);
		// OpenAlex answered, so the slower title search is never reached.
		expect(searchByTitle).not.toHaveBeenCalled();
	});

	it("falls back to a title search when OpenAlex knows no arXiv copy", async () => {
		const { clients } = makeClients({
			urls: ["https://link.aps.org/doi/10.1103/PhysRevX.1.011001"],
			hits: [makeHit("1706.03762", "Attention is all you need")],
		});

		expect(await findArxivId(makePaper({ doi: "10.1103/PhysRevX.1.011001" }), clients)).toBe(
			"1706.03762",
		);
	});

	// A title search returns near misses; accepting one would download the
	// wrong paper and file it under this note.
	it("rejects a search hit whose title is a different paper", async () => {
		const { clients } = makeClients({
			hits: [makeHit("1234.56789", "Attention Is All You Need For Speech Recognition")],
		});

		expect(await findArxivId(makePaper(), clients)).toBeNull();
	});

	it("returns null when arXiv simply does not have the paper", async () => {
		const { clients } = makeClients();

		expect(await findArxivId(makePaper({ doi: "10.1103/PhysRevX.1.011001" }), clients)).toBeNull();
	});
});
