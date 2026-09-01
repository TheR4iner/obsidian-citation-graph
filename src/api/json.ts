/**
 * Narrowing helpers for JSON that arrived over the network.
 *
 * Every response body here starts as `unknown`, which is the truth about it:
 * the shape is whatever the remote service felt like sending, and a field that
 * has been a string for years is one deploy away from being null. Reading
 * through these turns a surprise into a missing value rather than a crash
 * three frames away in a mapper, and it stops the `any` that `requestUrl`
 * hands back from spreading into everything that touches a response.
 *
 * They are deliberately forgiving about the container and strict about the
 * value: a missing object reads as an empty one, but a number where a string
 * was expected reads as null rather than being coerced.
 */

/** The value at `path` inside `value`, or undefined if any step is missing. */
export function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** `value` as a plain object, or null. Arrays are not objects for this purpose. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** `value` as a non-empty string, trimmed of nothing, or null. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * `value` as a finite number, or null.
 *
 * A numeric string counts: several of these APIs quote years and counts, and
 * rejecting those would lose data that is plainly present.
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `value` as an array, or an empty one, so callers can iterate unconditionally. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The object entries of an array, skipping anything that is not one. */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (record) records.push(record);
  }
  return records;
}

/** The string entries of an array, skipping anything that is not one. */
export function asStringArray(value: unknown): string[] {
  const strings: string[] = [];
  for (const entry of asArray(value)) {
    const text = asString(entry);
    if (text !== null) strings.push(text);
  }
  return strings;
}

/**
 * Parse JSON text without throwing.
 *
 * The result is `unknown` rather than `any`, so a caller has to narrow it
 * before use. That is the whole point: `JSON.parse` returning `any` is where
 * most of the untyped values in a plugin like this come from.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
