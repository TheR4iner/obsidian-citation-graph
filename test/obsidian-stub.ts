/**
 * Runtime stand-in for the `obsidian` module, wired up by `resolve.alias` in
 * vitest.config.ts.
 *
 * Deliberately minimal. Type-checking still uses the real `obsidian`
 * declarations (tsconfig does not alias the module), so this file only has to
 * satisfy the *runtime* references the tested modules make: `extends`,
 * `instanceof`, and calls. Growing it into a re-implementation would start
 * asserting things about Obsidian's behaviour that may not be true, and the
 * tests would then pass against the stub rather than against the app.
 */

export class App {}

export class TFile {
	path = "";
	basename = "";
	extension = "md";
}

/** Obsidian collapses duplicate separators and strips a leading slash; the
 *  tested paths never exercise that, so identity is enough. */
export const normalizePath = (p: string): string => p;

/**
 * Every message passed to `new Notice(...)`, oldest first.
 *
 * Failure reporting in the download path goes to the user through Notices and
 * nowhere else, so a test that wants to assert on what the user is told has to
 * read them from somewhere. Import this from the stub's own path (not from
 * "obsidian", whose real type declarations do not have it) and clear it in a
 * `beforeEach`.
 */
export const noticeLog: string[] = [];

export class Notice {
	constructor(message: string, public duration?: number) {
		noticeLog.push(message);
	}
}

/** Constructed and extended by the modals, never driven, in these tests. */
export class Modal {
	constructor(public app: App) {}
}

export class ButtonComponent {
	constructor(public containerEl: unknown) {}
}
