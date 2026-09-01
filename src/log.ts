import { Notice, normalizePath, type DataAdapter } from "obsidian";

/** Written inside the plugin's own folder, beside the Semantic Scholar cache. */
const LOG_FILE = "citation-graph.log";

/** Rotate when the log reaches this size so it doesn't grow unbounded. */
const MAX_LOG_BYTES = 1_000_000;

let adapter: DataAdapter | null = null;
let logFilePath: string | null = null;
/** Whether the log file is known to exist, so the check runs once, not per line. */
let fileReady = false;

/**
 * Appends are serialized behind this promise.
 *
 * Every log call is synchronous at the call site but asynchronous underneath,
 * so two notices raised in the same tick would otherwise race: the adapter
 * reads, appends and writes back, and the loser of that race silently drops
 * its line. Chaining keeps them in call order at the cost of nothing the user
 * can perceive.
 */
let pending: Promise<void> = Promise.resolve();

/** Call once at plugin load to set the log file location. */
export function initLog(fileAdapter: DataAdapter, pluginDir: string): void {
  adapter = fileAdapter;
  logFilePath = normalizePath(`${pluginDir}/${LOG_FILE}`);
  fileReady = false;
  enqueue(rotateIfOversized);
}

/**
 * Run one log-file operation after all earlier ones, reporting any failure to
 * the console. Logging must never block the UI or throw into a command, but a
 * log that quietly stops recording is worse than no log at all, so the error
 * is surfaced rather than swallowed.
 */
function enqueue(op: () => Promise<void>): void {
  pending = pending
    .then(op)
    .catch((e) => console.error("Citation Graph: could not write to the log file", e));
}

async function rotateIfOversized(): Promise<void> {
  if (!adapter || !logFilePath) return;
  const stat = await adapter.stat(logFilePath);
  if (!stat || stat.size < MAX_LOG_BYTES) return;
  const rotated = `${logFilePath}.1`;
  // rename() will not overwrite, so the previous rotation has to go first.
  if (await adapter.exists(rotated)) await adapter.remove(rotated);
  await adapter.rename(logFilePath, rotated);
  fileReady = false;
}

/** Create the log file if it is not there, so the first append has a target. */
async function ensureFile(): Promise<void> {
  if (fileReady || !adapter || !logFilePath) return;
  if (!(await adapter.exists(logFilePath))) await adapter.write(logFilePath, "");
  fileReady = true;
}

function appendToLog(message: string): void {
  if (!adapter || !logFilePath) return;
  const timestamp = new Date().toISOString();
  // Messages carry remote-sourced text (paper titles, API error bodies). A
  // newline in one would otherwise start what looks like a fresh timestamped
  // entry, letting a crafted title forge log lines. Keep multi-line notices
  // readable by indenting continuations instead of collapsing them.
  const safe = message.replace(/\r\n?/g, "\n").replace(/\n/g, "\n    ");
  enqueue(async () => {
    await ensureFile();
    await adapter!.append(logFilePath!, `[${timestamp}] ${safe}\n`);
  });
}

/**
 * Write to the log file without showing a notice. For detail a user only wants
 * when something looks wrong: raw model replies, per-item rejection reasons.
 */
export function logOnly(message: string): void {
  appendToLog(message);
}

/**
 * Drop-in replacement for `new Notice(...)` that also writes to the log file.
 * Returns the Notice instance so callers can chain if needed.
 */
export function logNotice(message: string, durationMs?: number): Notice {
  appendToLog(message);
  return new Notice(message, durationMs);
}
