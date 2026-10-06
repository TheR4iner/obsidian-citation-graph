import { describe, expect, it } from "vitest";
import * as os from "os";
import * as path from "path";
import { estimatePdfPages, fileInFolder, isInside, truncateToBytes, vaultFolder } from "./paper-files";

const home = os.homedir();
const vault = path.join(home, "vaults", "research");

describe("vaultFolder", () => {
	it("keeps a vault-relative folder", () => {
		expect(vaultFolder("Papers/PDFs", vault)).toBe("Papers/PDFs");
	});

	it("tidies separators, dot segments and surrounding space", () => {
		expect(vaultFolder("  Papers//./PDFs/ ", vault)).toBe("Papers/PDFs");
		expect(vaultFolder("Papers\\PDFs", vault)).toBe("Papers/PDFs");
	});

	it("reads an empty folder as the vault root", () => {
		expect(vaultFolder("", vault)).toBe("");
	});

	it("refuses a parent reference", () => {
		expect(() => vaultFolder("Papers/../../outside", vault)).toThrow(/\.\./);
	});

	// Settings and canvases written before PDFs moved into the vault carry
	// absolute paths. One inside the vault keeps working.
	it("converts an absolute path inside the vault", () => {
		expect(vaultFolder(path.join(vault, "Papers", "PDFs"), vault)).toBe("Papers/PDFs");
	});

	it("converts a tilde path inside the vault", () => {
		expect(vaultFolder("~/vaults/research/Papers", vault)).toBe("Papers");
	});

	it("refuses an absolute path outside the vault and says what to do", () => {
		expect(() => vaultFolder("/srv/papers", vault)).toThrow(/outside this vault.*folder inside the vault/);
	});

	it("refuses a tilde path outside the vault", () => {
		expect(() => vaultFolder("~/Downloads/papers", vault)).toThrow(/outside this vault/);
	});

	// "research-old" starts with "research" and is a different folder.
	it("refuses a sibling of the vault whose name starts the same", () => {
		expect(() => vaultFolder(vault + "-old/Papers", vault)).toThrow(/outside this vault/);
	});
});

describe("fileInFolder", () => {
	it("places a plain filename in the folder", () => {
		expect(fileInFolder("Papers/PDFs", "A Paper (Curie) (1903).pdf")).toBe(
			"Papers/PDFs/A Paper (Curie) (1903).pdf",
		);
	});

	it("places a filename at the vault root", () => {
		expect(fileInFolder("", "a.pdf")).toBe("a.pdf");
	});

	// The names come from remote metadata, so these are the cases that matter.
	it("refuses a parent reference", () => {
		expect(() => fileInFolder("Papers", "../secrets.pdf")).toThrow(/Refusing/);
		expect(() => fileInFolder("Papers", "..")).toThrow(/Refusing/);
	});

	it("refuses a nested path", () => {
		expect(() => fileInFolder("Papers", "sub/paper.pdf")).toThrow(/Refusing/);
		expect(() => fileInFolder("Papers", "sub\\paper.pdf")).toThrow(/Refusing/);
	});

	it("refuses an absolute path", () => {
		expect(() => fileInFolder("Papers", "/srv/secret.pdf")).toThrow(/Refusing/);
	});

	it("refuses the folder itself and an empty name", () => {
		expect(() => fileInFolder("Papers", ".")).toThrow(/Refusing/);
		expect(() => fileInFolder("Papers", "")).toThrow(/Refusing/);
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

describe("estimatePdfPages", () => {
	const pdf = (text: string) => new TextEncoder().encode(text).buffer;

	it("counts page objects but not the page tree", () => {
		expect(estimatePdfPages(pdf("<< /Type /Pages >> << /Type /Page >> << /Type/Page /X >>"))).toBe(2);
	});

	it("reads zero from something with no page objects", () => {
		expect(estimatePdfPages(pdf("%PDF-1.4"))).toBe(0);
	});
});

describe("truncateToBytes", () => {
	it("leaves a name that already fits", () => {
		expect(truncateToBytes("short.pdf", 200)).toBe("short.pdf");
	});

	it("cuts to the byte budget, not the character count", () => {
		// Each "é" is two UTF-8 bytes, so five of them fill a 10-byte budget.
		const cut = truncateToBytes("é".repeat(20), 10);
		expect(cut).toBe("é".repeat(5));
		expect(Buffer.byteLength(cut, "utf8")).toBe(10);
	});

	it("never splits a multi-byte code point", () => {
		// A 4-byte emoji cannot fit in the last 3 bytes of an 11-byte budget.
		const cut = truncateToBytes("ab" + "\u{1F600}".repeat(3), 11);
		expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(11);
		expect(cut).toBe("ab" + "\u{1F600}".repeat(2));
	});

	it("drops the trailing space a cut can leave behind", () => {
		expect(truncateToBytes("abcd efgh", 5)).toBe("abcd");
	});
});
