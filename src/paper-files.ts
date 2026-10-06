/// <reference types="node" />
import * as os from "os";
import * as path from "path";

/**
 * Every PDF path this plugin uses is built here, as a path inside the vault.
 *
 * PDFs live in a vault folder the user names and are read and written through
 * Obsidian's vault adapter, never through Node's filesystem module, so the
 * plugin cannot reach a file outside the vault. What remains to check is that
 * a folder the user typed, or one carried in a canvas file, really names a
 * folder in the vault, and that a filename built from remote metadata (a
 * paper's title, its authors, its arXiv ID) stays a single name inside it.
 * Sanitising those names is necessary but is the kind of thing that quietly
 * stops being true; refusing anything that is not a plain name is what holds.
 */

/**
 * Truncate to at most `maxBytes` of UTF-8 without splitting a code point.
 *
 * Names built from paper titles routinely exceed the 255-byte limit that ext4,
 * APFS and NTFS enforce on a single name, and the resulting ENAMETOOLONG
 * surfaces as an opaque per-file failure. Callers clean the result again
 * afterwards: cutting mid-string can expose a new trailing dot or space.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out.trimEnd();
}

/**
 * Turn a folder the user typed into a vault-relative folder path, or throw.
 *
 * Earlier versions stored PDFs anywhere on disk, so settings and canvases can
 * still carry an absolute or `~` path. One that points inside the vault is
 * converted, which keeps a setup that already kept its PDFs in the vault
 * working unchanged; one that points elsewhere is refused with a message
 * saying what to do. A relative path is read as relative to the vault root,
 * and a `..` segment is refused rather than resolved, since it can only be an
 * attempt to leave the folder it is written in.
 */
export function vaultFolder(raw: string, vaultBasePath: string): string {
  const trimmed = raw.trim();
  const expanded = expandTilde(trimmed);
  if (expanded !== trimmed || path.isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) {
    if (!isInside(expanded, vaultBasePath)) {
      throw new Error(
        `The download folder "${trimmed}" is outside this vault. PDFs are now kept in a vault folder: ` +
        "set a folder inside the vault (for example Papers/PDFs) and move any existing PDFs into it."
      );
    }
    return joinSegments(path.relative(path.resolve(vaultBasePath), path.resolve(expanded)));
  }
  return joinSegments(trimmed);
}

/** Collapse separators, drop "." segments and refuse "..". */
function joinSegments(relative: string): string {
  const segments = relative.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new Error(`The download folder "${relative}" must not contain "..".`);
  }
  return segments.join("/");
}

/** Expand a leading "~" to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The vault path of `name` directly inside `folder`, or an error.
 *
 * `name` is treated as a filename and nothing else. A value carrying a
 * separator or naming the folder itself or its parent would place the file
 * somewhere the user never named, so it is refused rather than stripped: a
 * caller passing one has a bug, and writing a different file than it asked
 * for is the worse outcome. An empty `folder` is the vault root.
 */
export function fileInFolder(folder: string, name: string): string {
  if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error(`Refusing to use "${name}" as a filename inside ${folder || "the vault root"}`);
  }
  return folder ? `${folder}/${name}` : name;
}

/** Whether OS path `target` is `root` itself or sits somewhere beneath it. */
export function isInside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Rough page count from the number of "/Type /Page" markers; 0 if unknown. */
export function estimatePdfPages(data: ArrayBuffer): number {
  const matches = new TextDecoder("latin1").decode(data).match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}
