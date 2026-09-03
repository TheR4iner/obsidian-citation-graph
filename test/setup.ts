/**
 * Obsidian supplies a global `sleep(ms)` at runtime (declared in
 * obsidian.d.ts). Node does not, so anything throttled would hit a
 * ReferenceError under vitest instead of the behaviour it has in the app.
 */
globalThis.sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
