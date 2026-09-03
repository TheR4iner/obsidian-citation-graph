import { requestUrl } from "obsidian";
import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Paper, CitationGraphSettings, LlmResponse } from "../types";
import { asNumber, asRecordArray, asString, parseJson, pick } from "./json";

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

/** How many searches a single web-search-enabled request may run. */
const WEB_SEARCH_MAX_USES = 8;

/**
 * Cap on how many times we resume a turn the provider paused (Anthropic
 * returns `pause_turn` when a server-side tool run is long). Each iteration is
 * a fresh billed request, so this is a cost ceiling as much as a loop guard.
 */
const MAX_PAUSED_TURNS = 4;

/** Default wall-clock limit for a Claude CLI invocation. */
const CLI_TIMEOUT_MS = 300000;

/** How much of the CLI's stderr to keep for the error message, in characters. */
const CLI_STDERR_KEEP_CHARS = 4000;

/**
 * Read a PDF as base64, refusing anything past MAX_PDF_BYTES.
 *
 * The path is expected to have been checked against the folders the user
 * configured for downloads before it gets here; `main.ts` is the only producer
 * and does that with `assertInsideFolders`.
 */
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

/** One call to the configured provider. */
export interface LlmRequest {
	/** The full user-visible prompt. */
	prompt: string;
	/** PDF to attach to the message, for tasks that read a paper. */
	pdfPath?: string | null;
	/**
	 * Ask the provider to run its own web search tool. Silently ignored by
	 * providers that have none -- call providerSupportsWebSearch() first if the
	 * user needs to know.
	 */
	webSearch?: boolean;
	/** Overrides settings.llmMaxOutputTokens for this call. */
	maxOutputTokens?: number;
	/** Wall-clock limit, honoured by the Claude CLI provider. */
	timeoutMs?: number;
	/**
	 * Called as the provider works, with a short description of what it is
	 * doing ("Searching the web: ..."). Only the Claude CLI reports this: the
	 * HTTP providers are called through Obsidian's requestUrl, which returns
	 * the whole response at once and cannot stream.
	 */
	onActivity?: (activity: string) => void;
}

/**
 * Call the configured LLM provider once. Returns the response text and token
 * usage (zeros for Claude CLI, which reports none).
 */
export async function callLlm(
	request: LlmRequest,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	switch (settings.llmProvider) {
		case "anthropic":
			return callAnthropic(request, settings);
		case "openai":
			return callOpenAI(request, settings);
		case "google":
			return callGoogle(request, settings);
		case "claude-cli":
			return callClaudeCli(request, settings);
	}
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
	return callLlm(
		{ prompt: buildSummaryPrompt(paper, settings.summaryPrompt), pdfPath },
		settings,
	);
}

/** Return the default model name for a provider. */
export function defaultModelForProvider(
	provider: CitationGraphSettings["llmProvider"],
): string {
	return DEFAULT_MODELS[provider] ?? "";
}

/** The model a call will actually use, honouring the blank-means-default rule. */
export function effectiveModel(settings: CitationGraphSettings): string {
	return settings.llmModel || DEFAULT_MODELS[settings.llmProvider] || "";
}

/**
 * Whether the configured provider can search the web during a call.
 *
 * Anthropic and Google expose a server-side search tool, and the Claude CLI
 * has WebSearch built in. OpenAI's chat/completions endpoint -- the one this
 * plugin talks to -- has none, so requests there answer from training data
 * alone.
 */
export function providerSupportsWebSearch(
	settings: CitationGraphSettings,
): boolean {
	return settings.llmProvider !== "openai";
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

/**
 * Model families that take the dynamic-filtering web search tool. Everything
 * else gets the original tool, which every search-capable model accepts. The
 * model name is user-editable, so an unknown name falls back to the older tool
 * rather than failing the request outright.
 */
const ANTHROPIC_DYNAMIC_SEARCH =
	/^claude-(fable-5|mythos-5|opus-(5|4-8|4-7|4-6)|sonnet-(5|4-6))/;

function anthropicWebSearchTool(model: string): Record<string, unknown> {
	return {
		type: ANTHROPIC_DYNAMIC_SEARCH.test(model)
			? "web_search_20260209"
			: "web_search_20250305",
		name: "web_search",
		max_uses: WEB_SEARCH_MAX_USES,
	};
}

/** Concatenate every text block of an Anthropic response. */
function anthropicText(content: unknown): string {
	return asRecordArray(content)
		.filter((block) => asString(block.type) === "text")
		.map((block) => asString(block.text) ?? "")
		.join("");
}

async function callAnthropic(
	request: LlmRequest,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	if (!settings.llmApiKey) {
		throw new Error("Anthropic API key is not configured. Set it in the plugin settings.");
	}

	const model = effectiveModel(settings);

	const content: Record<string, unknown>[] = [];
	if (request.pdfPath) {
		content.push({
			type: "document",
			source: {
				type: "base64",
				media_type: "application/pdf",
				data: readPdfBase64(request.pdfPath),
			},
		});
	}
	content.push({ type: "text", text: request.prompt });

	const messages: Record<string, unknown>[] = [{ role: "user", content }];

	let text = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let stopReason: string | undefined;

	// A server-side search can outlast one response; Anthropic then returns
	// stop_reason "pause_turn" and expects the partial assistant turn handed
	// back so it can continue. Dropping it here would silently truncate the
	// answer, which for a JSON payload means an unparseable one.
	for (let turn = 0; turn < MAX_PAUSED_TURNS; turn++) {
		const body: Record<string, unknown> = {
			model,
			max_tokens: request.maxOutputTokens ?? settings.llmMaxOutputTokens,
			messages,
		};
		if (request.webSearch) body.tools = [anthropicWebSearchTool(model)];

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

		const json: unknown = response.json;
		text += anthropicText(pick(json, "content"));
		inputTokens += asNumber(pick(json, "usage", "input_tokens")) ?? 0;
		outputTokens += asNumber(pick(json, "usage", "output_tokens")) ?? 0;
		stopReason = asString(pick(json, "stop_reason")) ?? undefined;

		if (stopReason !== "pause_turn") break;
		messages.push({ role: "assistant", content: pick(json, "content") });
	}

	return { text, inputTokens, outputTokens, stopReason };
}

// ─── OpenAI ────────────────────────────────────────────────────

async function callOpenAI(
	request: LlmRequest,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	if (!settings.llmApiKey) {
		throw new Error("OpenAI API key is not configured. Set it in the plugin settings.");
	}

	const model = effectiveModel(settings);

	const content: Record<string, unknown>[] = [];
	if (request.pdfPath) {
		content.push({
			type: "file",
			file: {
				filename: "paper.pdf",
				file_data: `data:application/pdf;base64,${readPdfBase64(request.pdfPath)}`,
			},
		});
	}
	content.push({ type: "text", text: request.prompt });

	const body = {
		model,
		max_completion_tokens: request.maxOutputTokens ?? settings.llmMaxOutputTokens,
		messages: [{ role: "user", content }],
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

	const json: unknown = response.json;
	const choice = pick(json, "choices", "0");
	return {
		text: asString(pick(choice, "message", "content")) ?? "",
		inputTokens: asNumber(pick(json, "usage", "prompt_tokens")) ?? 0,
		outputTokens: asNumber(pick(json, "usage", "completion_tokens")) ?? 0,
		stopReason: asString(pick(choice, "finish_reason")) ?? undefined,
	};
}

// ─── Google Gemini ─────────────────────────────────────────────

/**
 * Gemini renamed its search tool between generations: 1.5 models take
 * `google_search_retrieval`, 2.x and later take `google_search`. Sending the
 * wrong one is a 400.
 */
function googleSearchTool(model: string): Record<string, unknown> {
	return /^gemini-1\./.test(model)
		? { google_search_retrieval: {} }
		: { google_search: {} };
}

async function callGoogle(
	request: LlmRequest,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	if (!settings.llmApiKey) {
		throw new Error("Google Gemini API key is not configured. Set it in the plugin settings.");
	}

	const model = effectiveModel(settings);

	const parts: Record<string, unknown>[] = [];
	if (request.pdfPath) {
		parts.push({
			inline_data: {
				mime_type: "application/pdf",
				data: readPdfBase64(request.pdfPath),
			},
		});
	}
	parts.push({ text: request.prompt });

	const body: Record<string, unknown> = {
		contents: [{ parts }],
		generationConfig: {
			maxOutputTokens: request.maxOutputTokens ?? settings.llmMaxOutputTokens,
		},
	};
	if (request.webSearch) body.tools = [googleSearchTool(model)];

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

	const json: unknown = response.json;
	const candidate = pick(json, "candidates", "0");
	// Grounded answers arrive split across several parts; taking only the first
	// truncates the response at the first citation boundary.
	const text = asRecordArray(pick(candidate, "content", "parts"))
		.map((part) => asString(part.text) ?? "")
		.join("");
	return {
		text,
		inputTokens: asNumber(pick(json, "usageMetadata", "promptTokenCount")) ?? 0,
		outputTokens: asNumber(pick(json, "usageMetadata", "candidatesTokenCount")) ?? 0,
		stopReason: asString(pick(candidate, "finishReason")) ?? undefined,
	};
}

// ─── Claude CLI ───────────────────────────────────────────────
//
// This is the only place the plugin runs a program. Three things keep that
// narrow, and all three are enforced rather than assumed:
//
//   - It runs only when the user has picked "claude-cli" as their provider.
//   - It runs only the claude binary: spawn with an argument array and no
//     shell, so nothing in a prompt or a paper title can become a command,
//     and a configured path is validated before it is handed over.
//   - It is given a curated environment, not Obsidian's whole one.

/**
 * The environment variables the CLI is given.
 *
 * A child process inherits its parent's environment by default, which here
 * would hand a third-party binary every secret the user has exported: their
 * Zotero key, their OpenAI key, whatever else is in the shell Obsidian was
 * launched from. The CLI needs to find the user's home, a PATH, a temporary
 * directory and its own configuration, so that is what it gets.
 */
const CLI_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TERM",
	"TMPDIR",
	"TMP",
	"TEMP",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	// Windows needs these to resolve a home directory and run at all.
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"SystemRoot",
	"SystemDrive",
	"ComSpec",
	"PATHEXT",
] as const;

/** Whole families the CLI configures itself with. */
const CLI_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_"] as const;

/** Build the child's environment from an allow-list. Exported for testing. */
export function cliEnvironment(
	parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value === undefined) continue;
		const allowed =
			(CLI_ENV_ALLOWLIST as readonly string[]).includes(key) ||
			CLI_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
		if (allowed) env[key] = value;
	}
	return env;
}

/**
 * Reject a configured path that cannot be a plain executable path.
 *
 * The setting is the one place this plugin will run something the user chose,
 * so it is worth being exact. spawn without a shell already makes injection
 * impossible, which is why this checks shape rather than escaping: a value
 * carrying a newline, a null byte or a shell operator was not a path the user
 * meant to type, and running it anyway is the wrong response to a typo.
 */
export function isUsableCliPath(value: string): boolean {
	if (value === "" || value.length > 4096) return false;
	if (/[\0\n\r]/.test(value)) return false;
	if (/[;&|<>$`"'*?]/.test(value)) return false;
	// Either the bare command name, resolved through PATH, or a full path.
	return value === "claude" || path.isAbsolute(value);
}

/**
 * Pick which claude binary to invoke. Order of preference:
 *   1. The configured path (settings.claudeCliPath), if it is usable and the
 *      file is actually there.
 *   2. ~/.local/bin/claude -- the canonical path the official installer uses
 *      on Linux/macOS. Electron's inherited PATH typically excludes this dir,
 *      so we check it explicitly before falling back to PATH lookup.
 *   3. "claude" via PATH (may resolve to a system-wide install)
 *
 * Throws rather than falling through when the configured path is unusable:
 * quietly running a different binary than the one named in the settings is
 * exactly the surprise this whole section exists to avoid.
 */
function resolveClaudeCliPath(settings: CitationGraphSettings): string {
	const configured = settings.claudeCliPath?.trim();
	if (configured) {
		if (!isUsableCliPath(configured)) {
			throw new Error(
				`"Claude CLI path" is not a usable path to an executable: ${configured}`
			);
		}
		if (path.isAbsolute(configured) && !isExecutableFile(configured)) {
			throw new Error(`No file found at the configured Claude CLI path: ${configured}`);
		}
		return configured;
	}

	try {
		const userLocal = path.join(os.homedir(), ".local", "bin", "claude");
		if (isExecutableFile(userLocal)) return userLocal;
	} catch {
		// os.homedir() can throw in unusual environments; fall through
	}

	return "claude";
}

/** Whether a path names a file that exists (a directory is not runnable). */
function isExecutableFile(target: string): boolean {
	try {
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

/**
 * Turn one streamed CLI event into a line for the progress notice.
 *
 * The events are read as `unknown` and narrowed field by field. They come from
 * a separate program on its own release schedule, and a shape change should
 * cost the progress line, not the summary that is being written.
 */
export function describeCliEvent(event: unknown): string | null {
	if (
		asString(pick(event, "type")) === "system" &&
		asString(pick(event, "subtype")) === "thinking_tokens"
	) {
		return `Thinking (${asNumber(pick(event, "estimated_tokens")) ?? 0} tokens)`;
	}
	if (asString(pick(event, "type")) !== "assistant") return null;

	for (const block of asRecordArray(pick(event, "message", "content"))) {
		const kind = asString(block.type);
		if (kind === "tool_use" || kind === "server_tool_use") {
			const name = asString(block.name) ?? "a tool";
			const query = asString(pick(block, "input", "query"));
			if (name === "WebSearch" && query) {
				return `Searching the web: ${query.slice(0, 60)}`;
			}
			const url = asString(pick(block, "input", "url"));
			if (name === "WebFetch" && url) {
				return `Reading ${url.slice(0, 60)}`;
			}
			return `Using ${name}`;
		}
		if (kind === "text" && asString(block.text)?.trim()) {
			return "Writing the answer";
		}
	}
	return null;
}

/**
 * Run the Claude CLI, streaming its events back as progress.
 *
 * spawn rather than execFile: --output-format stream-json emits one JSON event
 * per line as the model works, which is the only way any provider here can say
 * what it is doing mid-run. It also removes execFile's output buffer cap, which
 * a long summary could previously have hit.
 */
function callClaudeCli(
	request: LlmRequest,
	settings: CitationGraphSettings,
): Promise<LlmResponse> {
	const executable = resolveClaudeCliPath(settings);
	// Honour the configured model; the hardcoded default applies only when the
	// Model setting is blank.
	const model = effectiveModel(settings);

	const args = ["-p", "--model", model, "--output-format", "stream-json", "--verbose"];
	// In print mode a tool the user has not allowed is auto-denied rather than
	// prompted for, so search has to be named explicitly or the CLI answers
	// from training data alone.
	if (request.webSearch) args.push("--allowedTools", "WebSearch,WebFetch");
	// --allowedTools is variadic: without this separator it swallows the prompt
	// as another tool name, and the CLI then waits on stdin for a prompt that
	// never comes.
	args.push("--", request.prompt);
	if (request.pdfPath) args.push(request.pdfPath);

	return new Promise<LlmResponse>((resolve, reject) => {
		const child = child_process.spawn(executable, args, {
			timeout: request.timeoutMs ?? CLI_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
			// No shell: the arguments carry a prompt and a paper title, both of
			// which contain arbitrary text from remote sources. Passed as an
			// array to a shell-less spawn they are inert.
			shell: false,
			env: cliEnvironment(),
			windowsHide: true,
		});

		let buffer = "";
		let stderr = "";
		let result: LlmResponse | null = null;
		let failure: string | null = null;

		const handleLine = (line: string): void => {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) return;
			// Not every line is an event; warnings share the stream.
			const event = parseJson(trimmed);
			if (event === undefined) return;

			if (asString(pick(event, "type")) === "result") {
				const text = asString(pick(event, "result")) ?? "";
				if (pick(event, "is_error") === true) {
					const subtype = asString(pick(event, "subtype")) ?? "unknown";
					failure = text || `claude reported an error (${subtype})`;
				} else {
					// Token counts stay zero for this provider, as the batch
					// token budget documents: the CLI bills through the user's
					// subscription, not through this plugin's key.
					result = {
						text: text.trim(),
						inputTokens: 0,
						outputTokens: 0,
						stopReason: asString(pick(event, "stop_reason")) ?? undefined,
					};
				}
				return;
			}

			if (request.onActivity) {
				const activity = describeCliEvent(event);
				if (activity) request.onActivity(activity);
			}
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			// Only the tail is ever reported, and an interactive shell profile
			// can spew unbounded noise here; keep the last few KB and no more.
			stderr = (stderr + chunk).slice(-CLI_STDERR_KEEP_CHARS);
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				reject(new Error(
					`Could not find claude binary (tried "${executable}"). ` +
					`Set "Claude CLI path" in plugin settings to the absolute path of your claude binary.`
				));
			} else {
				reject(new Error(error.message));
			}
		});

		child.on("close", (code, signal) => {
			if (buffer.trim()) handleLine(buffer);
			if (failure) {
				reject(new Error(failure));
			} else if (result) {
				resolve(result);
			} else if (signal) {
				reject(new Error(
					`claude was stopped (${signal}) before it answered. ` +
					"It may have hit the time limit; try again or narrow the request."
				));
			} else {
				reject(new Error(stderr.trim() || `claude exited with code ${code} and no answer.`));
			}
		});
	});
}
