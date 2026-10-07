import { describe, expect, it, vi } from "vitest";
import type { S2Paper } from "../types";
import { DEFAULT_SETTINGS } from "../types";

/**
 * Built from the reference list of 10.1038/s42005-023-01233-w as the three
 * sources really return it, cut down to the entries that exercise each rule.
 * Crossref is the real client over a canned response, so its parsing is
 * covered too; the other two are fakes returning their parsed lists.
 */
const CROSSREF_REFERENCES = [
  {
    unstructured:
      "Wang, J., Lu, S., Wang, S.-H. & Zhang, Y.-D. Multimedia Tools and Applications 1–50, https://link.springer.com/article/10.1007/s11042-021-11007-7 (2021).",
  },
  {
    unstructured:
      "Jaeger, H. The “echo state” approach to analysing and training recurrent neural networks-with an erratum note. GMD Technical Report. Vol. 148 (2001).",
  },
  {
    // The publisher deposited the DOI of a different npj QI paper here.
    DOI: "10.1038/s41534-018-0113-z",
    unstructured:
      "Ghosh, S., Opala, A., Matuszewski, M., Paterek, T. & Liew, T. C. H. Quantum reservoir processing. npj Quant. Inf. 5, 1–6 (2019).",
  },
  {
    DOI: "10.1007/978-981-13-1687-6_18",
    unstructured: "Fujii, K. & Nakajima, K. Reservoir Computing, 423–450 (Springer, 2021).",
  },
  {
    DOI: "10.1137/1.9780898718027",
    unstructured:
      "Higham, N. J. Accuracy and Stability of Numerical Algorithms (Society for Industrial and Applied Mathematics, 2002).",
  },
  {
    DOI: "10.48550/arXiv.1509.07347",
    unstructured:
      "Casazza, P. G. & Lynch, R. G. A brief introduction to hilbert space frame theory and its applications. arXiv (2015).",
  },
];

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestUrl: async () => ({ json: { message: { reference: CROSSREF_REFERENCES } } }),
}));

const { fetchRefsAndCitations } = await import("./multi-source");
const { CrossRefClient } = await import("./crossref");
const { S2RateLimitError } = await import("./semantic-scholar");
type MultiSourceClients = import("./multi-source").MultiSourceClients;

const paper = (paperId: string, title: string, externalIds: S2Paper["externalIds"]): S2Paper => ({
  paperId,
  externalIds,
  title,
  year: null,
  authors: [],
  abstract: null,
  citationCount: null,
});

const S2_REFERENCES = [
  paper("s2-wang", "A review on extreme learning machine", { DOI: "10.1007/s11042-021-11007-7" }),
  paper("s2-echo", "The''echo state''approach to analysing and training recurrent neural networks", {}),
  paper("s2-qrp", "Quantum reservoir processing", { DOI: "10.1038/s41534-019-0149-8" }),
  paper("s2-sound", "Soundness and completeness of quantum root-mean-square errors", {
    DOI: "10.1038/s41534-018-0113-z",
  }),
  paper(
    "s2-fujii",
    "Quantum Reservoir Computing: A Reservoir Approach Toward Quantum Machine Learning on Near-Term Quantum Devices",
    { DOI: "10.1007/978-981-13-1687-6_18" }
  ),
  paper("s2-higham", "accuracy and stability of numerical algorithms", {}),
  paper("s2-casazza", "A brief introduction to Hilbert space frame theory and its applications", {
    ArXiv: "1509.07347",
  }),
];

const OPENALEX_REFERENCES = [
  paper("doi:10.1137/1.9780898718027", "Accuracy and Stability of Numerical Algorithms", {
    DOI: "10.1137/1.9780898718027",
  }),
];

function clients(s2Fails = false): MultiSourceClients {
  const fakes = {
    s2: {
      getPaperWithRefs: async () => {
        if (s2Fails) throw new S2RateLimitError("fetching references");
        return { ...paper("s2-self", "Potential and limitations", null), references: S2_REFERENCES, citations: [] };
      },
    },
    openalex: {
      getReferencesForDoi: async () => OPENALEX_REFERENCES,
      getCitationsForDoi: async () => [],
    },
    crossref: new CrossRefClient(),
  };
  return fakes as unknown as MultiSourceClients;
}

const fetch = (s2Fails = false) =>
  fetchRefsAndCitations("10.1038/s42005-023-01233-w", null, null, DEFAULT_SETTINGS, clients(s2Fails));

describe("fetchRefsAndCitations", () => {
  it("numbers references by the paper's bibliography, trusting the entry's title over a wrong DOI", async () => {
    const result = await fetch();
    const order = Object.fromEntries(result!.references.map((p) => [p.paperId, p.referenceIndex]));
    expect(order).toEqual({
      "s2-wang": 0, // DOI found in the citation's URL
      "s2-echo": 1, // no DOI, placed by title
      "s2-qrp": 2, // the paper the entry names, not the one its DOI points to
      "s2-sound": undefined,
      "s2-fujii": 3, // the entry names only the book, so its DOI stands
      "s2-higham": 4, // the DOI-less copy folded into OpenAlex's
      "s2-casazza": 5, // matched through its arXiv ID
    });
    expect(result!.failed).toEqual([]);
  });

  it("reports a failed source instead of passing off a partial list as complete", async () => {
    const result = await fetch(true);
    expect(result!.failed).toEqual(["Semantic Scholar"]);
    expect(result!.references.length).toBeGreaterThan(0);
  });
});
