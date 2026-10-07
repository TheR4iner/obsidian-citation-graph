import { describe, expect, it } from "vitest";
import type { S2Paper } from "../types";
import type { PaperChoice } from "./paper-picker";
import { sortChoices } from "./expand-picker";

function choice(id: string, fields: Partial<S2Paper>): PaperChoice {
  return {
    paper: {
      paperId: id,
      externalIds: null,
      title: "",
      year: null,
      authors: [],
      abstract: null,
      citationCount: null,
      ...fields,
    },
    selected: false,
    banned: false,
    alreadyOnCanvas: false,
  };
}

const ids = (choices: PaperChoice[]) => choices.map((c) => c.paper.paperId);

describe("sortChoices", () => {
  const make = () => [
    choice("a", { title: "beta", year: 2001, citationCount: 5, referenceIndex: 2 }),
    choice("b", { title: "Alpha", year: null, citationCount: 50, referenceIndex: 0 }),
    choice("c", { title: "", year: 1999, citationCount: null }),
    choice("d", { title: "gamma 10", year: 2020, citationCount: 0, referenceIndex: 7 }),
  ];

  it.each([
    ["citations", "desc", ["b", "a", "d", "c"]],
    ["citations", "asc", ["d", "a", "b", "c"]],
    ["year", "desc", ["d", "a", "c", "b"]],
    ["year", "asc", ["c", "a", "d", "b"]],
    ["title", "asc", ["b", "a", "d", "c"]],
    ["title", "desc", ["d", "a", "b", "c"]],
    ["paper", "asc", ["b", "a", "d", "c"]],
    ["paper", "desc", ["d", "a", "b", "c"]],
  ] as const)("%s %s puts missing values last", (key, direction, expected) => {
    const choices = make();
    sortChoices(choices, key, direction);
    expect(ids(choices)).toEqual(expected);
  });
});
