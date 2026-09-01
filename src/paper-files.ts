import * as os from "os";
import * as path from "path";

/**
 * Every path this plugin touches outside the vault is built here.
 *
 * PDFs are not notes, so they cannot live in the vault, and reading one back
 * to send to a model means leaving Obsidian's API behind. Confining the path
 * arithmetic to one module makes "what can this plugin reach on my disk?" a
 * question with a single, enforced answer rather than a described one: a
 * folder the user named, and files directly inside it.
 *
 * That matters because the names come from somewhere else. A paper's title,
 * its arXiv ID and its authors all arrive from a remote API, and they end up
 * in filenames. Sanitising them is necessary but is the kind of thing that
 * quietly stops being true; asserting containment afterwards is what actually
 * holds.
 */

/**
 * Expand a leading "~" to the user's home directory. Node's fs/path never do
 * this (it is a shell convention), so an unexpanded "~/papers" would otherwise
 * create a literal "~" folder in the working directory. Bare "~" and "~/..."
 * are handled; "~user" syntax is not, since other users' homes cannot be
 * resolved from here.
 */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Turn a folder the user typed into an absolute path.
 *
 * Every other function here takes its `folder` from this one, so a relative
 * path can never reach the filesystem: it would resolve against Obsidian's
 * working directory, which is not anywhere the user meant.
 */
export function resolveFolder(raw: string): string {
  return path.resolve(expandTilde(raw));
}

/**
 * The path of `name` directly inside `folder`, or an error.
 *
 * `name` is treated as a filename and nothing else. A value carrying a
 * separator, a parent reference, or an absolute root would otherwise place the
 * file somewhere the user never named, so those are refused rather than
 * stripped: a caller passing one has a bug, and silently writing to a
 * different file than it asked for is the worse outcome.
 */
export function fileInFolder(folder: string, name: string): string {
  const root = path.resolve(folder);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) {
    throw new Error(`Refusing to use "${name}" as a filename inside ${root}`);
  }
  return target;
}

/**
 * Return `target` when it lies inside one of `folders`, or throw.
 *
 * The last gate before a file outside the vault is read. Callers hold the list
 * of folders the user actually named, so this is what keeps a path assembled
 * elsewhere, or carried in a canvas file written by someone else, from
 * reaching the disk.
 */
export function assertInsideFolders(target: string, folders: string[]): string {
  const resolved = path.resolve(target);
  const allowed = folders
    .filter((f) => f.trim() !== "")
    .some((folder) => isInside(resolved, resolveFolder(folder)));
  if (!allowed) {
    throw new Error(
      `Refusing to read "${resolved}": it is outside every folder configured for downloads.`
    );
  }
  return resolved;
}

/** Whether `target` is `root` itself or sits somewhere beneath it. */
export function isInside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
