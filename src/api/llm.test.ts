import { describe, expect, it } from "vitest";
import { describeCliEvent, defaultModelForProvider, effectiveModel, providerSupportsWebSearch } from "./llm";
import { DEFAULT_SETTINGS } from "../types";
import type { CitationGraphSettings } from "../types";

const settings = (over: Partial<CitationGraphSettings> = {}): CitationGraphSettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

/**
 * The event shapes below were captured from a real `claude -p
 * --output-format stream-json --verbose` run, not written from memory.
 */
describe("describeCliEvent", () => {
  it("reports a web search with its query", () => {
    expect(
      describeCliEvent({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "WebSearch", input: { query: "2024 Nobel Prize in Physics winners" } },
          ],
        },
      })
    ).toBe("Searching the web: 2024 Nobel Prize in Physics winners");
  });

  it("truncates a very long query", () => {
    const activity = describeCliEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "x".repeat(500) } }] },
    });
    expect(activity!.length).toBeLessThan(100);
  });

  it("reports a fetched URL", () => {
    expect(
      describeCliEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "WebFetch", input: { url: "https://arxiv.org/abs/1706.03762" } }] },
      })
    ).toBe("Reading https://arxiv.org/abs/1706.03762");
  });

  it("names a tool it does not know about", () => {
    expect(
      describeCliEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "ToolSearch", input: { query: "select:WebSearch" } }] },
      })
    ).toBe("Using ToolSearch");
  });

  it("reports thinking with its token estimate", () => {
    expect(
      describeCliEvent({ type: "system", subtype: "thinking_tokens", estimated_tokens: 155 })
    ).toBe("Thinking (155 tokens)");
  });

  it("reports the model writing its answer", () => {
    expect(
      describeCliEvent({ type: "assistant", message: { content: [{ type: "text", text: "[{" }] } })
    ).toBe("Writing the answer");
  });

  it("ignores an empty text block", () => {
    expect(
      describeCliEvent({ type: "assistant", message: { content: [{ type: "text", text: "  " }] } })
    ).toBeNull();
  });

  it("ignores a thinking block, which carries no progress the user can read", () => {
    expect(
      describeCliEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } })
    ).toBeNull();
  });

  it("ignores session bookkeeping", () => {
    expect(describeCliEvent({ type: "system", subtype: "init", tools: [] })).toBeNull();
    expect(describeCliEvent({ type: "rate_limit_event", rate_limit_info: {} })).toBeNull();
    expect(describeCliEvent({ type: "user", message: { content: [] } })).toBeNull();
  });

  it("survives an event with no content array", () => {
    expect(describeCliEvent({ type: "assistant", message: {} })).toBeNull();
  });
});

describe("provider capabilities", () => {
  it("reports web search for every provider that has one", () => {
    expect(providerSupportsWebSearch(settings({ llmProvider: "claude-cli" }))).toBe(true);
    expect(providerSupportsWebSearch(settings({ llmProvider: "anthropic" }))).toBe(true);
    expect(providerSupportsWebSearch(settings({ llmProvider: "google" }))).toBe(true);
  });

  it("reports no web search for the OpenAI endpoint used here", () => {
    expect(providerSupportsWebSearch(settings({ llmProvider: "openai" }))).toBe(false);
  });

  it("falls back to the provider default when no model is configured", () => {
    expect(effectiveModel(settings({ llmProvider: "google", llmModel: "" }))).toBe(
      defaultModelForProvider("google")
    );
  });

  it("uses the configured model when there is one", () => {
    expect(effectiveModel(settings({ llmProvider: "google", llmModel: "gemini-3-pro" }))).toBe("gemini-3-pro");
  });
});
