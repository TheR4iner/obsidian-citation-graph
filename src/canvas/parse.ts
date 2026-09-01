import type { CanvasData } from "../types";

/**
 * Read canvas JSON the way Obsidian actually stores it.
 *
 * A canvas Obsidian has just created is a zero-byte file, and one whose nodes
 * have all been removed can come back as `{}`. Neither parses into an object
 * with `nodes` and `edges` arrays, so a bare `JSON.parse` at the call site
 * fails with "Unexpected end of JSON input" or a later "cannot read properties
 * of undefined". Both shapes mean the same thing to every command here: a
 * canvas with no papers on it. Missing arrays are filled in so callers can
 * iterate unconditionally; any other key (notably `citationGraphMeta`) is
 * preserved.
 *
 * Content that is present but not a JSON object is a genuinely broken file and
 * still throws, with the path in the message so the user can find it.
 */
export function parseCanvasData<T = unknown>(
  content: string,
  path: string
): CanvasData & T {
  const trimmed = content.trim();
  if (trimmed === "") {
    return { nodes: [], edges: [] } as CanvasData & T;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`${path} is not valid canvas JSON: ${detail}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${path} is not valid canvas JSON: expected an object, got ${
        Array.isArray(parsed) ? "an array" : typeof parsed
      }.`
    );
  }

  const data = parsed as Partial<CanvasData> & Record<string, unknown>;
  return {
    ...data,
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    edges: Array.isArray(data.edges) ? data.edges : [],
  } as CanvasData & T;
}
