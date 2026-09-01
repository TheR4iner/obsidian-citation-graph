import type { App, TFile } from "obsidian";

/** A note as the fake vault holds it: frontmatter plus body text. */
export interface FakeNote {
	/** null models a note with no frontmatter block at all. */
	fm: Record<string, unknown> | null;
	body: string;
}

export interface FakeVault {
	app: App;
	/** Every note in the fake vault, keyed by path, in insertion order. */
	notes: Map<string, FakeNote>;
	files: TFile[];
	/** The TFile for a path already added to the vault. */
	file(path: string): TFile;
	/** Every path passed to `vault.createFolder`, in call order. */
	createdFolders: string[];
	/**
	 * Pin `metadataCache` to the frontmatter as it stands right now, so later
	 * writes are invisible to it.
	 *
	 * Obsidian refreshes the metadata cache asynchronously after
	 * `processFrontMatter`, so code that writes a note and then reads the cache
	 * sees what was there before the write. This models that, for the tests
	 * that need to prove they do not depend on it.
	 */
	freezeCache(): void;
}

/**
 * Build a fake `App` exposing just the three surfaces LiteratureNoteManager
 * touches: `metadataCache`, `vault` and `fileManager`.
 *
 * `processFrontMatter` mutates the stored frontmatter synchronously, so a test
 * can read what was written straight back off `notes.get(path)!.fm`. Real
 * Obsidian is not synchronous here -- it refreshes `metadataCache`
 * asynchronously after the callback returns, which is precisely why
 * `displayStatusFor` exists alongside `getDisplayStatus`. Do not write tests
 * that rely on the cache being fresh after a write; the fake is more
 * forgiving than the app.
 *
 * A single cast at the boundary keeps the fake out of the type system. The
 * structural type of the literal is checked below it, so a typo in a method
 * name still fails to compile at the call sites in the tests.
 */
export function makeVault(notes: Record<string, Partial<FakeNote>>): FakeVault {
	const stored = new Map<string, FakeNote>();
	const files = new Map<string, TFile>();
	const folders = new Set<string>();
	const createdFolders: string[] = [];

	for (const [path, note] of Object.entries(notes)) {
		stored.set(path, { fm: note.fm ?? null, body: note.body ?? "" });
		const basename = path.replace(/^.*\//, "").replace(/\.md$/, "");
		files.set(path, { path, basename, extension: "md" } as TFile);
	}

	const noteFor = (file: TFile): FakeNote => {
		const note = stored.get(file.path);
		if (!note) throw new Error(`fake vault has no note at ${file.path}`);
		return note;
	};

	let frozen: Map<string, Record<string, unknown> | null> | null = null;

	const app = {
		metadataCache: {
			getFileCache: (file: TFile) => {
				const fm = frozen
					? (frozen.get(file.path) ?? null)
					: noteFor(file).fm;
				return fm ? { frontmatter: fm } : {};
			},
		},
		vault: {
			cachedRead: async (file: TFile) => noteFor(file).body,
			read: async (file: TFile) => noteFor(file).body,
			modify: async (file: TFile, content: string) => {
				noteFor(file).body = content;
			},
			process: async (file: TFile, fn: (data: string) => string) => {
				const note = noteFor(file);
				note.body = fn(note.body);
				return note.body;
			},
			getMarkdownFiles: () => [...files.values()],
			getAbstractFileByPath: (path: string) =>
				files.get(path) ?? (folders.has(path) ? ({ path } as unknown as TFile) : null),
			create: async (path: string, content: string) => {
				const basename = path.replace(/^.*\//, "").replace(/\.md$/, "");
				const file = { path, basename, extension: "md" } as TFile;
				files.set(path, file);
				stored.set(path, { fm: null, body: content });
				return file;
			},
			createFolder: async (path: string) => {
				createdFolders.push(path);
				folders.add(path);
			},
		},
		fileManager: {
			processFrontMatter: async (
				file: TFile,
				cb: (fm: Record<string, unknown>) => void
			) => {
				const note = noteFor(file);
				// Obsidian creates the frontmatter block if the note lacks one.
				note.fm ??= {};
				cb(note.fm);
			},
		},
	} as unknown as App;

	return {
		app,
		notes: stored,
		files: [...files.values()],
		file: (path: string) => {
			const file = files.get(path);
			if (!file) throw new Error(`fake vault has no note at ${path}`);
			return file;
		},
		createdFolders,
		freezeCache: () => {
			frozen = new Map(
				[...stored].map(([path, note]) => [
					path,
					note.fm ? { ...note.fm } : null,
				])
			);
		},
	};
}

/** A vault holding exactly one note at "papers/Paper.md". */
export function makeNote(note: Partial<FakeNote> = {}): {
	app: App;
	file: TFile;
	/** The stored frontmatter, mutated in place by processFrontMatter. */
	fm: () => Record<string, unknown> | null;
	body: () => string;
	/** See FakeVault#freezeCache. */
	freezeCache: () => void;
} {
	const vault = makeVault({ "papers/Paper.md": note });
	return {
		app: vault.app,
		file: vault.file("papers/Paper.md"),
		fm: () => vault.notes.get("papers/Paper.md")!.fm,
		body: () => vault.notes.get("papers/Paper.md")!.body,
		freezeCache: vault.freezeCache,
	};
}
