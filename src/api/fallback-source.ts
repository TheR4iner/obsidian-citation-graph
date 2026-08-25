/**
 * Which secondary PDF source this build ships, if any.
 *
 * This is the one file a variant of this plugin needs to change to add a
 * source. Everything else in the download path is written against the
 * `DownloadFallback` interface in ./download-fallback.ts and does not care what
 * (or whether) a source exists.
 *
 * This build ships none: arXiv is the only source, and papers arXiv does not
 * carry are reported as unavailable. To add one, implement the interface in its
 * own module and return an instance here.
 */

import type { DownloadFallback } from "./download-fallback";

export function getDownloadFallback(): DownloadFallback | null {
  return null;
}
