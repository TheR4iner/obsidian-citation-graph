/**
 * Extension point for a secondary PDF source.
 *
 * `downloadPapers` tries arXiv first. When arXiv has nothing (or fails), it
 * asks ./fallback-source.ts for a secondary source and, if one is configured,
 * hands the paper to it.
 *
 * This file declares the contract only. Which fallback (if any) a build ships
 * is decided in ./fallback-source.ts, and the download command's control flow,
 * error reporting and UI gating are identical either way: adding a source means
 * implementing this interface, not threading a second code path through the
 * picker.
 */

import type { Paper } from "../types";

export interface FallbackContext {
  /** Absolute path to this plugin's own directory, for bundled helper scripts. */
  pluginDir: string;
}

export interface DownloadFallback {
  /** Source name, shown to the user in progress and error messages. */
  readonly name: string;

  /**
   * Probed once per download run, before any paper is attempted. Return false
   * when a prerequisite is missing; every paper then skips the fallback and
   * `setupHint` is what the user is told.
   */
  isAvailable(): Promise<boolean>;

  /** Shown when `isAvailable()` resolved false and arXiv had nothing. */
  readonly setupHint: string;

  /**
   * Whether this paper carries an identifier the fallback can look up. Called
   * synchronously by the picker to decide which rows are selectable, so it
   * must not do I/O.
   */
  canAttempt(paper: Paper): boolean;

  /** Shown when `canAttempt()` is false and arXiv had nothing. */
  readonly missingIdentifierHint: string;

  /**
   * Attempt the download. Resolve with the saved file's path, or null when the
   * paper simply is not there (an expected outcome, not an error). Throw with a
   * short user-facing `message` on a real failure.
   */
  download(paper: Paper, outputDir: string, ctx: FallbackContext): Promise<string | null>;

  /**
   * Whether a thrown message describes a setup problem rather than a
   * paper-specific one. Setup errors apply to every paper in the run, so the
   * picker surfaces them once instead of one Notice per paper.
   */
  isSetupError(message: string): boolean;
}
