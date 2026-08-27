import { requestUrl } from "obsidian";
import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Paper, CitationGraphSettings, LlmResponse } from "../types";

/** Default models per provider (used when settings.llmModel is empty) */
const DEFAULT_MODELS: Record<string, string> = {
	anthropic: "claude-sonnet-5",
	openai: "gpt-4o",
	google: "gemini-2.5-flash",
	"claude-cli": "claude-sonnet-5",
};

/**
 * Largest PDF we will read into memory and ship to a provider.
 *
 * The file is held twice over (raw Buffer plus a base64 string ~4/3 its size)
 * inside the Electron renderer, and every provider rejects oversized documents
 * anyway -- Gemini's inline_data cap is the tightest at 20 MB. Failing here
 * gives the user an actionable message instead of an OOM or an opaque 400.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Read a PDF as base64, refusing anything past MAX_PDF_BYTES. */
function readPdfBase64(pdfPath: string): string {
	const { size } = fs.statSync(pdfPath);
	if (size > MAX_PDF_BYTES) {
		throw new Error(
			`PDF is too large to summarize (${Math.round(size / 1024 / 1024)} MB; ` +
			`limit ${MAX_PDF_BYTES / 1024 / 1024} MB): ${path.basename(pdfPath)}`,
		);
	}
	return fs.readFileSync(pdfPath).toString("base64");
}

/**
 * Summarize a paper PDF using the configured LLM provider.
 * Returns the summary text and token usage (zeros for Claude CLI).
 */
export async function summarizePaper(
	paper: Paper,
	pdfPath: string,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	const prompt = buildSummaryPrompt(paper, settings.summaryPrompt);

	switch (settings.llmProvider) {
		case "anthropic":
			return callAnthropic(prompt, pdfPath, settings);
		case "openai":
			return callOpenAI(prompt, pdfPath, settings);
		case "google":
			return callGoogle(prompt, pdfPath, settings);
		case "claude-cli":
			return callClaudeCli(prompt, pdfPath, settings);
	}
}

/** Return the default model name for a provider. */
export function defaultModelForProvider(
	provider: CitationGraphSettings["llmProvider"],
): string {
	return DEFAULT_MODELS[provider] ?? "";
}

// ─── Prompt ────────────────────────────────────────────────────

/**
 * Build the prompt sent to the LLM for paper summarization.
 * If the user provided a custom prompt template, substitute {title}, {authors},
 * and {year} placeholders in it. Otherwise fall back to the built-in default.
 */
function buildSummaryPrompt(paper: Paper, custom: string): string {
	const authors = paper.authors.join(", ");
	const customTrimmed = custom?.trim();
	if (customTrimmed) {
		return customTrimmed
			.replace(/\{title\}/g, paper.title || "")
			.replace(/\{authors\}/g, authors)
			.replace(/\{year\}/g, String(paper.year || ""));
	}
	return `You are summarizing an academic paper for a researcher's Obsidian literature notes.

Paper: "${paper.title}" by ${authors} (${paper.year})

Write a clear, well-structured summary following these guidelines:

1. Structure (use ### headings, omit any that don't apply):
   - Main Contribution: 1-2 sentences on what this paper does/proposes
   - Key Ideas: the core concepts, methods, or theoretical framework (3-5 bullet points)
   - Results: main findings or experimental results (2-4 bullet points)
   - Limitations & Future Work: noted limitations or open questions (if discussed)

2. Style:
   - Optimize for a researcher who wants to quickly recall what this paper is about
   - Be precise but concise, aim for 200-400 words total
   - Use MathJax notation ($..$ for inline, $$...$$ for display) for key equations that are central to the paper's contribution
   - Only include equations that are essential for understanding; explain what they mean in plain language
   - Do not reproduce every formula, only the ones needed to convey the main results

3. Format: Output raw Markdown only. No code fences, no preamble, no closing remarks.
   Start directly with ### Main Contribution (or the first applicable subsection).`;
}

// ─── Anthropic ─────────────────────────────────────────────────

async function callAnthropic(
	prompt: string,
	pdfPath: string,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	if (!settings.llmApiKey) {
		throw new Error("Anthropic API key is not configured. Set it in the plugin settings.");
	}

	const pdfBase64 = readPdfBase64(pdfPath);
	const model = settings.llmModel || DEFAULT_MODELS.anthropic;

	const body = {
		model,
		max_tokens: settings.llmMaxOutputTokens,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "document",
						source: {
							type: "base64",
							media_type: "application/pdf",
							data: pdfBase64,
						},
					},
					{
						type: "text",
						text: prompt,
					},
				],
			},
		],
	};

	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": settings.llmApiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
	});

	const json = response.json;
	const text = json.content?.[0]?.text ?? "";
	return {
		text,
		inputTokens: json.usage?.input_tokens ?? 0,
		outputTokens: json.usage?.output_tokens ?? 0,
	};
}

// ─── OpenAI ────────────────────────────────────────────────────

async function callOpenAI(
	prompt: string,
	pdfPath: string,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	if (!settings.llmApiKey) {
		throw new Error("OpenAI API key is not configured. Set it in the plugin settings.");
	}

	const pdfBase64 = readPdfBase64(pdfPath);
	const model = settings.llmModel || DEFAULT_MODELS.openai;

	const body = {
		model,
		max_completion_tokens: settings.llmMaxOutputTokens,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "file",
						file: {
							filename: "paper.pdf",
							file_data: `data:application/pdf;base64,${pdfBase64}`,
						},
					},
					{
						type: "text",
						text: prompt,
					},
				],
			},
		],
	};

	const response = await requestUrl({
		url: "https://api.openai.com/v1/chat/completions",
		method: "POST",
		headers: {
			"content-type": "application/json",
			"authorization": `Bearer ${settings.llmApiKey}`,
		},
		body: JSON.stringify(body),
	});

	const json = response.json;
	const text = json.choices?.[0]?.message?.content ?? "";
	return {
		text,
		inputTokens: json.usage?.prompt_tokens ?? 0,
		outputTokens: json.usage?.completion_tokens ?? 0,
	};
}

// ─── Google Gemini ─────────────────────────────────────────────

async function callGoogle(
	prompt: string,
	pdfPath: string,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	if (!settings.llmApiKey) {
		throw new Error("Google Gemini API key is not configured. Set it in the plugin settings.");
	}

	const pdfBase64 = readPdfBase64(pdfPath);
	const model = settings.llmModel || DEFAULT_MODELS.google;

	const body = {
		contents: [
			{
				parts: [
					{
						inline_data: {
							mime_type: "application/pdf",
							data: pdfBase64,
						},
					},
					{
						text: prompt,
					},
				],
			},
		],
		generationConfig: {
			maxOutputTokens: settings.llmMaxOutputTokens,
		},
	};

	// The API key goes in a header, never the query string: a URL carrying it
	// ends up in proxy logs and, more immediately, inside the message of any
	// error requestUrl throws. `model` is user-editable, so encode it too so it
	// cannot escape its path segment with "?" or "#".
	const url =
		"https://generativelanguage.googleapis.com/v1beta/models/" +
		`${encodeURIComponent(model)}:generateContent`;

	const response = await requestUrl({
		url,
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-goog-api-key": settings.llmApiKey,
		},
		body: JSON.stringify(body),
	});

	const json = response.json;
	const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	return {
		text,
		inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
		outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
	};
}

// ─── Claude CLI (legacy) ──────────────────────────────────────
// Uses child_process.execFile (not exec) with an argument array,
// so there is no shell interpolation and no injection risk.

/**
 * Pick which claude binary to invoke. Order of preference:
 *   1. User-configured absolute path (settings.claudeCliPath)
 *   2. ~/.local/bin/claude -- the canonical path the official installer uses
 *      on Linux/macOS. Electron's inherited PATH typically excludes this dir,
 *      so we check it explicitly before falling back to PATH lookup.
 *   3. "claude" via PATH (may resolve to a system-wide install)
 */
function resolveClaudeCliPath(settings: CitationGraphSettings): string {
	const configured = settings.claudeCliPath?.trim();
	if (configured) return configured;

	try {
		const userLocal = path.join(os.homedir(), ".local", "bin", "claude");
		if (fs.existsSync(userLocal)) return userLocal;
	} catch {
		// os.homedir() can throw in unusual environments; fall through
	}

	return "claude";
}

function callClaudeCli(
	prompt: string,
	pdfPath: string,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	const executable = resolveClaudeCliPath(settings);
	// Honour the configured model; the hardcoded default applies only when the
	// Model setting is blank.
	const model = settings.llmModel || DEFAULT_MODELS["claude-cli"];
	return new Promise<LlmResponse>((resolve, reject) => {
		child_process.execFile(
			executable,
			["-p", "--model", model, prompt, pdfPath],
			{ timeout: 300000, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT") {
						reject(new Error(
							`Could not find claude binary (tried "${executable}"). ` +
							`Set "Claude CLI path" in plugin settings to the absolute path of your claude binary.`
						));
					} else {
						reject(new Error(stderr || error.message));
					}
				} else {
					resolve({
						text: stdout.trim(),
						inputTokens: 0,
						outputTokens: 0,
					});
				}
			},
		);
	});
}
