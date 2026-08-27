import * as fs from "fs";
import * as path from "path";
import { Notice } from "obsidian";

let logFilePath: string | null = null;

/** Rotate when the log reaches this size so it doesn't grow unbounded. */
const MAX_LOG_BYTES = 1_000_000;

/** Call once at plugin load to set the log file location. */
export function initLog(pluginDir: string, vaultBasePath: string): void {
  logFilePath = path.join(vaultBasePath, pluginDir, "citation-graph.log");
  rotateIfOversized();
}

function rotateIfOversized(): void {
  if (!logFilePath) return;
  fs.stat(logFilePath, (err, stats) => {
    if (err || !stats) return;
    if (stats.size < MAX_LOG_BYTES) return;
    const rotated = `${logFilePath}.1`;
    fs.rename(logFilePath!, rotated, () => {
      // Ignore errors: next append will recreate the file.
    });
  });
}

function appendToLog(message: string): void {
  if (!logFilePath) return;
  const timestamp = new Date().toISOString();
  // Messages carry remote-sourced text (paper titles, API error bodies). A
  // newline in one would otherwise start what looks like a fresh timestamped
  // entry, letting a crafted title forge log lines. Keep multi-line notices
  // readable by indenting continuations instead of collapsing them.
  const safe = message.replace(/\r\n?/g, "\n").replace(/\n/g, "\n    ");
  fs.appendFile(logFilePath, `[${timestamp}] ${safe}\n`, () => {
    // Fire and forget: logging must not block the UI or throw.
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
