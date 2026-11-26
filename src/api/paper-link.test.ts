import { describe, expect, it } from "vitest";
import type { S2Paper } from "../types";
import { paperLink } from "./paper-link";

function paper(paperId: string, externalIds: S2Paper["externalIds"]): S2Paper {
  return { paperId, externalIds, title: "", year: null, authors: [], abstract: null, citationCount: null };
}

describe("paperLink", () => {
  it("prefers arXiv over DOI", () => {
    expect(paperLink(paper("abc", { ArXiv: "1706.03762", DOI: "10.1/x" }))?.url).toBe(
      "https://arxiv.org/abs/1706.03762"
    );
  });

  it("falls back to the DOI", () => {
    expect(paperLink(paper("abc", { DOI: "10.1103/RevModPhys.81.865" }))?.url).toBe(
      "https://doi.org/10.1103/RevModPhys.81.865"
    );
  });

  it("reads identifiers the fallback sources put in paperId", () => {
    expect(paperLink(paper("arxiv:quant-ph/0702225", null))?.url).toBe(
      "https://arxiv.org/abs/quant-ph/0702225"
    );
    expect(paperLink(paper("openalex:W123", null))?.url).toBe("https://openalex.org/W123");
  });

  it("links a bare Semantic Scholar ID to its page", () => {
    expect(paperLink(paper("649def34", null))?.label).toBe("Semantic Scholar");
  });

  it("returns null with nothing to link", () => {
    expect(paperLink(paper("", null))).toBeNull();
  });
});
