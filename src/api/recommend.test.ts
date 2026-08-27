import { describe, expect, it } from "vitest";
import {
  buildRecommendPrompt,
  defaultRecommendInstructions,
  formatCanvasPapers,
  isAlreadyOnCanvas,
  normalizeArxiv,
  normalizeDoi,
  parseRecommendations,
  titleSimilarity,
  titlesMatch,
} from "./recommend";
import type { CanvasPaperSummary, Recommendation } from "./recommend";

const canvasPaper = (over: Partial<CanvasPaperSummary> = {}): CanvasPaperSummary => ({
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  doi: "10.5555/3295222.3295349",
  arxiv: "1706.03762",
  ...over,
});

const recommendation = (over: Partial<Recommendation> = {}): Recommendation => ({
  title: "Deep Residual Learning for Image Recognition",
  authors: ["Kaiming He"],
  year: 2016,
  doi: null,
  arxiv: null,
  reason: "",
  ...over,
});

describe("parseRecommendations", () => {
  it("reads a bare JSON array", () => {
    const recs = parseRecommendations(
      '[{"title":"BERT","authors":["Devlin"],"year":2019,"doi":"10.18653/v1/N19-1423","arxiv":null,"reason":"foundational"}]'
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe("BERT");
    expect(recs[0].doi).toBe("10.18653/v1/N19-1423");
    expect(recs[0].reason).toBe("foundational");
  });

  it("reads an array wrapped in a code fence", () => {
    const recs = parseRecommendations('```json\n[{"title":"BERT"}]\n```');
    expect(recs.map((r) => r.title)).toEqual(["BERT"]);
  });

  it("reads an array surrounded by prose", () => {
    const recs = parseRecommendations(
      'Here are my suggestions:\n[{"title":"BERT"}]\nHope that helps.'
    );
    expect(recs.map((r) => r.title)).toEqual(["BERT"]);
  });

  it("unwraps an object that holds the array", () => {
    const recs = parseRecommendations('{"recommendations":[{"title":"BERT"}]}');
    expect(recs.map((r) => r.title)).toEqual(["BERT"]);
  });

  it("drops entries with no title, since nothing can verify them", () => {
    const recs = parseRecommendations('[{"title":""},{"authors":["X"]},{"title":"BERT"}]');
    expect(recs.map((r) => r.title)).toEqual(["BERT"]);
  });

  it("accepts a year given as a string", () => {
    expect(parseRecommendations('[{"title":"BERT","year":"2019"}]')[0].year).toBe(2019);
  });

  it("nulls a year that is not a number", () => {
    expect(parseRecommendations('[{"title":"BERT","year":"n.d."}]')[0].year).toBeNull();
  });

  it("defaults missing authors and reason rather than dropping the entry", () => {
    const rec = parseRecommendations('[{"title":"BERT"}]')[0];
    expect(rec.authors).toEqual([]);
    expect(rec.reason).toBe("");
  });

  it("returns nothing for a non-JSON reply", () => {
    expect(parseRecommendations("I could not find any relevant papers.")).toEqual([]);
  });

  it("returns nothing for malformed JSON", () => {
    expect(parseRecommendations('[{"title": "BERT"')).toEqual([]);
  });

  it("returns nothing for an empty reply", () => {
    expect(parseRecommendations("")).toEqual([]);
  });
});

describe("normalizeDoi", () => {
  it("keeps a bare DOI", () => {
    expect(normalizeDoi("10.1038/nature14539")).toBe("10.1038/nature14539");
  });

  it("strips a doi.org URL", () => {
    expect(normalizeDoi("https://doi.org/10.1038/nature14539")).toBe("10.1038/nature14539");
  });

  it("strips a doi: prefix", () => {
    expect(normalizeDoi("doi:10.1038/nature14539")).toBe("10.1038/nature14539");
  });

  it("rejects the literal string null the model may emit", () => {
    expect(normalizeDoi("null")).toBeNull();
  });

  it("rejects something that is not a DOI", () => {
    expect(normalizeDoi("see the arXiv version")).toBeNull();
  });

  it("rejects a non-string", () => {
    expect(normalizeDoi(42)).toBeNull();
  });
});

describe("normalizeArxiv", () => {
  it("keeps a modern identifier", () => {
    expect(normalizeArxiv("1706.03762")).toBe("1706.03762");
  });

  it("keeps a versioned identifier", () => {
    expect(normalizeArxiv("1706.03762v5")).toBe("1706.03762v5");
  });

  it("strips an abs URL", () => {
    expect(normalizeArxiv("https://arxiv.org/abs/1706.03762")).toBe("1706.03762");
  });

  it("strips a pdf URL", () => {
    expect(normalizeArxiv("https://arxiv.org/pdf/1706.03762.pdf")).toBe("1706.03762");
  });

  it("strips an arXiv: prefix", () => {
    expect(normalizeArxiv("arXiv:1706.03762")).toBe("1706.03762");
  });

  it("keeps a pre-2007 identifier", () => {
    expect(normalizeArxiv("hep-th/9711200")).toBe("hep-th/9711200");
  });

  it("rejects junk", () => {
    expect(normalizeArxiv("not-an-id")).toBeNull();
  });
});

describe("titleSimilarity", () => {
  it("scores an exact title 1", () => {
    expect(titleSimilarity("Attention Is All You Need", "Attention is all you need")).toBe(1);
  });

  it("ignores punctuation differences", () => {
    expect(titleSimilarity("BERT: Pre-training of Deep Transformers", "BERT Pretraining of Deep Transformers")).toBeGreaterThan(0.7);
  });

  it("scores unrelated titles low", () => {
    expect(titleSimilarity("Attention Is All You Need", "Deep Residual Learning")).toBeLessThan(0.3);
  });

  it("scores 0 when one title has no content words", () => {
    expect(titleSimilarity("of the and", "Attention Is All You Need")).toBe(0);
  });
});

describe("titlesMatch", () => {
  it("matches a title that lost its subtitle", () => {
    expect(
      titlesMatch(
        "ImageNet Classification with Deep Convolutional Neural Networks",
        "ImageNet Classification with Deep Convolutional Neural Networks (AlexNet)"
      )
    ).toBe(true);
  });

  it("rejects a different paper by the same group", () => {
    expect(titlesMatch("Attention Is All You Need", "Neural Machine Translation by Jointly Learning to Align and Translate")).toBe(false);
  });
});

describe("isAlreadyOnCanvas", () => {
  const canvas = [canvasPaper()];

  it("matches on DOI regardless of case", () => {
    expect(isAlreadyOnCanvas(recommendation({ doi: "10.5555/3295222.3295349", title: "Something else entirely" }), canvas)).toBe(true);
  });

  it("matches on arXiv ID", () => {
    expect(isAlreadyOnCanvas(recommendation({ arxiv: "1706.03762", title: "Something else entirely" }), canvas)).toBe(true);
  });

  it("matches on title when no identifier is given", () => {
    expect(isAlreadyOnCanvas(recommendation({ title: "Attention is all you need" }), canvas)).toBe(true);
  });

  it("passes a genuinely new paper through", () => {
    expect(isAlreadyOnCanvas(recommendation(), canvas)).toBe(false);
  });
});

describe("formatCanvasPapers", () => {
  it("numbers papers and lists their identifiers", () => {
    const text = formatCanvasPapers([canvasPaper()]);
    expect(text).toContain('1. "Attention Is All You Need"');
    expect(text).toContain("Ashish Vaswani, Noam Shazeer (2017)");
    expect(text).toContain("DOI 10.5555/3295222.3295349");
    expect(text).toContain("arXiv 1706.03762");
  });

  it("copes with a paper that has neither authors nor a year", () => {
    const text = formatCanvasPapers([canvasPaper({ authors: [], year: null, doi: null, arxiv: null })]);
    expect(text).toContain("unknown authors (n.d.)");
    expect(text).not.toContain("[");
  });

  it("omits abstracts that were not requested", () => {
    expect(formatCanvasPapers([canvasPaper()])).not.toContain("Abstract:");
  });

  it("includes an abstract when one is attached", () => {
    const text = formatCanvasPapers([canvasPaper({ abstract: "We propose a new architecture." })]);
    expect(text).toContain("Abstract: We propose a new architecture.");
  });

  it("truncates a long abstract", () => {
    const text = formatCanvasPapers([canvasPaper({ abstract: "x".repeat(5000) })]);
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(2000);
  });
});

describe("buildRecommendPrompt", () => {
  const papers = [canvasPaper()];

  it("asks for the requested number of papers", () => {
    expect(defaultRecommendInstructions(7, false)).toContain("Suggest 7 further papers");
  });

  it("only tells the model to search when search is available", () => {
    expect(defaultRecommendInstructions(5, true)).toContain("Search the web");
    expect(defaultRecommendInstructions(5, false)).not.toContain("Search the web");
  });

  it("includes the canvas listing and the JSON contract", () => {
    const prompt = buildRecommendPrompt({ papers, count: 5, webSearch: false });
    expect(prompt).toContain("Papers currently on the canvas:");
    expect(prompt).toContain("Attention Is All You Need");
    expect(prompt).toContain("Reply with JSON and nothing else");
  });

  it("keeps the canvas listing and JSON contract under a custom prompt", () => {
    const prompt = buildRecommendPrompt({
      papers,
      count: 5,
      webSearch: false,
      custom: "Only suggest papers about optimizers.",
    });
    expect(prompt).toContain("Only suggest papers about optimizers.");
    expect(prompt).not.toContain("Suggest 5 further papers");
    expect(prompt).toContain("Papers currently on the canvas:");
    expect(prompt).toContain("Reply with JSON and nothing else");
  });

  it("falls back to the default when the custom prompt is whitespace", () => {
    const prompt = buildRecommendPrompt({ papers, count: 5, webSearch: false, custom: "   " });
    expect(prompt).toContain("Suggest 5 further papers");
  });
});
