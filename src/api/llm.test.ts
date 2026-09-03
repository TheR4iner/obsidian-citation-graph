import { describe, expect, it } from "vitest";
import {
  cliEnvironment,
  describeCliEvent,
  defaultModelForProvider,
  effectiveModel,
  isUsableCliPath,
  providerSupportsWebSearch,
} from "./llm";
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

/**
 * The Claude CLI is the only program this plugin runs, so what it is given
 * matters more than anywhere else in the codebase.
 */
describe("cliEnvironment", () => {
  const BIN = "/opt/bin";

  it("passes through what the CLI needs to run and find its config", () => {
    const env = cliEnvironment({
      PATH: BIN,
      HOME: "/home/someone",
      ANTHROPIC_API_KEY: "sk-ant-x",
      CLAUDE_CONFIG_DIR: "/home/someone/.claude",
    });

    expect(env).toEqual({
      PATH: BIN,
      HOME: "/home/someone",
      ANTHROPIC_API_KEY: "sk-ant-x",
      CLAUDE_CONFIG_DIR: "/home/someone/.claude",
    });
  });

  // The point of the allow-list: a child process inherits everything by
  // default, which would hand a third-party binary every secret in the shell
  // Obsidian was launched from.
  it("withholds secrets that are nothing to do with it", () => {
    const env = cliEnvironment({
      PATH: BIN,
      ZOTERO_API_KEY: "zot-secret",
      OPENAI_API_KEY: "sk-openai",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "ghp_secret",
    });

    expect(env).toEqual({ PATH: BIN });
  });

  it("drops variables with no value rather than passing undefined", () => {
    expect(cliEnvironment({ PATH: undefined, HOME: "/home/someone" })).toEqual({
      HOME: "/home/someone",
    });
  });
});

describe("isUsableCliPath", () => {
  it("accepts an absolute path", () => {
    expect(isUsableCliPath("/home/someone/.local/bin/claude")).toBe(true);
  });

  it("accepts the bare command name, resolved through PATH", () => {
    expect(isUsableCliPath("claude")).toBe(true);
  });

  it("rejects another bare name, which PATH could resolve anywhere", () => {
    expect(isUsableCliPath("curl")).toBe(false);
  });

  it("rejects a relative path", () => {
    expect(isUsableCliPath("./claude")).toBe(false);
    expect(isUsableCliPath("../../bin/claude")).toBe(false);
  });

  // spawn runs without a shell, so none of these could execute; they are
  // refused because a path containing them was not what the user meant.
  it("rejects shell operators and control characters", () => {
    expect(isUsableCliPath("/opt/claude; echo hi")).toBe(false);
    expect(isUsableCliPath("/opt/claude && echo hi")).toBe(false);
    expect(isUsableCliPath("/opt/claude | tee")).toBe(false);
    expect(isUsableCliPath("/opt/claude\nrm")).toBe(false);
    expect(isUsableCliPath("/opt/claude\0")).toBe(false);
  });

  it("rejects an empty setting", () => {
    expect(isUsableCliPath("")).toBe(false);
  });
});
