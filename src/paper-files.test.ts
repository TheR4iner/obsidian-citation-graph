import { describe, expect, it } from "vitest";
import * as os from "os";
import * as path from "path";
import {
	assertInsideFolders,
	expandTilde,
	fileInFolder,
	isInside,
	resolveFolder,
} from "./paper-files";

const home = os.homedir();

describe("expandTilde", () => {
	it("expands a bare tilde", () => {
		expect(expandTilde("~")).toBe(home);
	});

	it("expands a tilde-rooted path", () => {
		expect(expandTilde("~/papers")).toBe(path.join(home, "papers"));
	});

	// "~user" needs another user's home, which cannot be resolved from here.
	it("leaves ~user alone rather than guessing", () => {
		expect(expandTilde("~someone/papers")).toBe("~someone/papers");
	});

	it("leaves a tilde in the middle of a path alone", () => {
		expect(expandTilde("/srv/~backup")).toBe("/srv/~backup");
	});
});

describe("resolveFolder", () => {
	it("returns an absolute path", () => {
		expect(path.isAbsolute(resolveFolder("papers"))).toBe(true);
	});

	it("expands a tilde on the way", () => {
		expect(resolveFolder("~/papers")).toBe(path.join(home, "papers"));
	});
});

describe("fileInFolder", () => {
	it("places a plain filename in the folder", () => {
		expect(fileInFolder("/srv/papers", "A Paper (Curie) (1903).pdf")).toBe(
			path.join("/srv/papers", "A Paper (Curie) (1903).pdf"),
		);
	});

	// The names come from remote metadata, so these are the cases that matter.
	it("refuses a parent reference", () => {
		expect(() => fileInFolder("/srv/papers", "../secrets.pdf")).toThrow(/Refusing/);
	});

	it("refuses a nested path", () => {
		expect(() => fileInFolder("/srv/papers", "sub/paper.pdf")).toThrow(/Refusing/);
	});

	it("refuses an absolute path", () => {
		expect(() => fileInFolder("/srv/papers", "/etc/passwd")).toThrow(/Refusing/);
	});

	it("refuses a path that walks out and back to a sibling", () => {
		expect(() => fileInFolder("/srv/papers", "../notes/paper.pdf")).toThrow(/Refusing/);
	});

	it("refuses the folder itself", () => {
		expect(() => fileInFolder("/srv/papers", ".")).toThrow(/Refusing/);
	});
});

describe("isInside", () => {
	it("accepts a direct child", () => {
		expect(isInside("/srv/papers/a.pdf", "/srv/papers")).toBe(true);
	});

	it("accepts a deeper descendant", () => {
		expect(isInside("/srv/papers/2024/a.pdf", "/srv/papers")).toBe(true);
	});

	it("accepts the folder itself", () => {
		expect(isInside("/srv/papers", "/srv/papers")).toBe(true);
	});

	it("rejects a parent", () => {
		expect(isInside("/srv", "/srv/papers")).toBe(false);
	});

	// The reason this is not a string prefix test: "/srv/papers-private"
	// starts with "/srv/papers" and is a different folder.
	it("rejects a sibling whose name starts the same", () => {
		expect(isInside("/srv/papers-private/a.pdf", "/srv/papers")).toBe(false);
	});
});

describe("assertInsideFolders", () => {
	it("returns the resolved path when it is inside one of them", () => {
		expect(assertInsideFolders("/srv/papers/a.pdf", ["/tmp/x", "/srv/papers"])).toBe(
			path.resolve("/srv/papers/a.pdf"),
		);
	});

	it("throws when it is inside none of them", () => {
		expect(() => assertInsideFolders("/etc/passwd", ["/srv/papers"])).toThrow(
			/outside every folder/,
		);
	});

	it("ignores blank folders rather than treating them as the root", () => {
		expect(() => assertInsideFolders("/etc/passwd", ["", "   "])).toThrow(
			/outside every folder/,
		);
	});

	it("expands a tilde in the allowed folder", () => {
		const target = path.join(home, "papers", "a.pdf");
		expect(assertInsideFolders(target, ["~/papers"])).toBe(target);
	});
});
