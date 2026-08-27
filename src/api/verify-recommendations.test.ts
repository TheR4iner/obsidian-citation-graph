import { describe, expect, it } from "vitest";
import { verifyRecommendations } from "./recommend";
import type { Recommendation } from "./recommend";
import type { ResolverClients } from "./multi-source";
import { S2RateLimitError } from "./semantic-scholar";
import type { S2Paper } from "../types";

/**
 * These exercise the guard that stops invented papers reaching the canvas.
 *
 * The fakes only implement what resolvePaperWithRefs actually reaches for: a
 * Semantic Scholar hit short-circuits the whole resolver, so a fake `s2` plus
 * inert fallbacks covers every path here without mocking modules.
 */

const s2Paper = (over: Partial<S2Paper> & { paperId: string; title: string }): S2Paper => ({
  externalIds: null,
  year: 2020,
  authors: [],
  abstract: null,
  citationCount: 0,
  ...over,
});

interface FakeSources {
  /** Keyed by the S2 query string, e.g. "DOI:10.1/x". */
  byQuery?: Record<string, S2Paper>;
  /** Keyed by the exact suggested title. */
  byTitle?: Record<string, S2Paper>;
  /** Start refusing, as an exhausted rate limit does, from this call onward. */
  rateLimitFromCall?: number;
}

const makeClients = (sources: FakeSources): ResolverClients => {
  const calls: string[] = [];
  const clients = {
    s2: {
      getPaperWithRefs: async (query: string) => {
        calls.push(query);
        if (
          sources.rateLimitFromCall !== undefined &&
          calls.length >= sources.rateLimitFromCall
        ) {
          throw new S2RateLimitError("looking up " + query);
        }
        return sources.byQuery?.[query] ?? null;
      },
      matchTitle: async (title: string) => {
        if (
          sources.rateLimitFromCall !== undefined &&
          calls.length >= sources.rateLimitFromCall
        ) {
          throw new S2RateLimitError(`searching for "${title}"`);
        }
        return sources.byTitle?.[title] ?? null;
      },
    },
    openalex: {
      getMetadataForDoi: async () => null,
      getReferencesForDoi: async () => [],
      getCitationsForDoi: async () => [],
    },
    crossref: {
      getMetadataForDoi: async () => null,
      getReferencesForDoi: async () => [],
    },
    arxiv: { getMetadata: async () => null },
  };
  return clients as unknown as ResolverClients;
};

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  title: "Deep Residual Learning for Image Recognition",
  authors: ["Kaiming He"],
  year: 2016,
  doi: null,
  arxiv: null,
  reason: "",
  ...over,
});

const resnet = s2Paper({
  paperId: "resnet-id",
  title: "Deep Residual Learning for Image Recognition",
});

describe("verifyRecommendations", () => {
  it("keeps a suggestion whose DOI resolves to the paper it names", async () => {
    const clients = makeClients({ byQuery: { "DOI:10.1/resnet": resnet } });
    const { verified, dropped } = await verifyRecommendations(
      [rec({ doi: "10.1/resnet" })],
      clients
    );
    expect(dropped).toHaveLength(0);
    expect(verified).toHaveLength(1);
    expect(verified[0].resolved.paper.paperId).toBe("resnet-id");
  });

  it("keeps a suggestion with no identifier when the title matches", async () => {
    const clients = makeClients({
      byTitle: { "Deep Residual Learning for Image Recognition": resnet },
      byQuery: { "resnet-id": resnet },
    });
    const { verified } = await verifyRecommendations([rec()], clients);
    expect(verified).toHaveLength(1);
  });

  it("drops a suggestion no source can find", async () => {
    const clients = makeClients({});
    const { verified, dropped } = await verifyRecommendations(
      [rec({ title: "A Paper That Does Not Exist At All" })],
      clients
    );
    expect(verified).toHaveLength(0);
    expect(dropped[0].reason).toBe("unknown");
  });

  it("refuses a DOI that resolves to a different paper", async () => {
    const clients = makeClients({
      byQuery: {
        "DOI:10.1/wrong": s2Paper({
          paperId: "other-id",
          title: "Generative Adversarial Networks",
        }),
      },
    });
    const { verified, dropped } = await verifyRecommendations(
      [rec({ doi: "10.1/wrong" })],
      clients
    );
    expect(verified).toHaveLength(0);
    expect(dropped[0].reason).toBe("mismatch");
  });

  it("recovers a real paper whose DOI was wrong, via its title", async () => {
    const clients = makeClients({
      byQuery: {
        "DOI:10.1/wrong": s2Paper({
          paperId: "other-id",
          title: "Generative Adversarial Networks",
        }),
        "resnet-id": resnet,
      },
      byTitle: { "Deep Residual Learning for Image Recognition": resnet },
    });
    const { verified, dropped } = await verifyRecommendations(
      [rec({ doi: "10.1/wrong" })],
      clients
    );
    expect(dropped).toHaveLength(0);
    expect(verified[0].resolved.paper.paperId).toBe("resnet-id");
  });

  it("rejects a title match that is a different paper", async () => {
    const clients = makeClients({
      byTitle: {
        "Deep Residual Learning for Image Recognition": s2Paper({
          paperId: "other-id",
          title: "Attention Is All You Need",
        }),
      },
    });
    const { verified, dropped } = await verifyRecommendations([rec()], clients);
    expect(verified).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("keeps the same paper only once when two suggestions resolve to it", async () => {
    const clients = makeClients({
      byQuery: { "DOI:10.1/resnet": resnet, "resnet-id": resnet },
      byTitle: { "Deep Residual Learning for Image Recognition": resnet },
    });
    const { verified } = await verifyRecommendations(
      [rec({ doi: "10.1/resnet" }), rec()],
      clients
    );
    expect(verified).toHaveLength(1);
  });

  it("reports progress once per suggestion", async () => {
    const clients = makeClients({});
    const seen: Array<[number, number]> = [];
    await verifyRecommendations([rec({ title: "One" }), rec({ title: "Two" })], clients, (done, total) => {
      seen.push([done, total]);
    });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("stops on an exhausted rate limit instead of discarding the rest", async () => {
    const clients = makeClients({
      byQuery: { "DOI:10.1/resnet": resnet },
      rateLimitFromCall: 2,
    });
    const { verified, dropped, unchecked, stoppedReason } = await verifyRecommendations(
      [rec({ doi: "10.1/resnet" }), rec({ doi: "10.1/second", title: "Second Paper" }), rec({ doi: "10.1/third", title: "Third Paper" })],
      clients
    );
    expect(verified).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(unchecked.map((r) => r.title)).toEqual(["Second Paper", "Third Paper"]);
    expect(stoppedReason).toContain("rate limit");
  });

  it("reports nothing unchecked on a clean run", async () => {
    const clients = makeClients({ byQuery: { "DOI:10.1/resnet": resnet } });
    const result = await verifyRecommendations([rec({ doi: "10.1/resnet" })], clients);
    expect(result.unchecked).toEqual([]);
    expect(result.stoppedReason).toBeNull();
  });
});
