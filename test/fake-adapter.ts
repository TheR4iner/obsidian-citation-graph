import * as fs from "fs";
import * as path from "path";
import type { FileSystemAdapter } from "obsidian";

/**
 * A stand-in for Obsidian's FileSystemAdapter over a real directory, covering
 * the calls the download path makes. Paths are vault-relative, as the real
 * adapter takes them, and resolved against `basePath`.
 *
 * Backed by the disk rather than a map so a test can also play the part of a
 * download fallback, which runs outside Obsidian and writes files directly.
 */
export function makeFsAdapter(basePath: string): FileSystemAdapter {
	const full = (p: string) => path.join(basePath, p);
	const adapter = {
		getBasePath: () => basePath,
		getFullPath: full,
		exists: async (p: string) => fs.existsSync(full(p)),
		stat: async (p: string) => {
			if (!fs.existsSync(full(p))) return null;
			const st = fs.statSync(full(p));
			return { type: st.isDirectory() ? "folder" : "file", size: st.size, ctime: 0, mtime: 0 };
		},
		mkdir: async (p: string) => {
			fs.mkdirSync(full(p), { recursive: true });
		},
		writeBinary: async (p: string, data: ArrayBuffer) => {
			fs.writeFileSync(full(p), Buffer.from(data));
		},
		readBinary: async (p: string) => {
			const buf = fs.readFileSync(full(p));
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		},
		rename: async (from: string, to: string) => {
			fs.renameSync(full(from), full(to));
		},
		remove: async (p: string) => {
			fs.rmSync(full(p));
		},
	};
	return adapter as unknown as FileSystemAdapter;
}
