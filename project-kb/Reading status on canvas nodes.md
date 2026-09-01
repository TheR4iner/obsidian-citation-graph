# Reading status on canvas nodes

## Overview

A paper's reading status is stored as `status:` in its literature note frontmatter. It reaches the canvas two ways, and the split matters:

- **Colour** is written to the node's `color` field in the `.canvas` file and rendered by Obsidian. Any of the six presets, a custom hex, or none.
- **Label, frame and fade** come from a `citation-graph-status-*` class the plugin writes into the note's `cssclasses`, styled by fixed rules in `styles.css`.

`annotated` is never stored in `status:`. It is derived at paint time from **both** halves of what its label claims: the stored status is `read`, *and* the note body has content beyond the generated scaffold. It is written as a class like any other display status.

## Current solution

One function owns both halves. `resolveStatusColors` in `src/main.ts` reads each paper note once, derives its `DisplayStatus`, puts the colour in a map for the canvas write, and calls `noteManager.syncNoteClass(file, display)` to bring the class into step. No extra file lookup: the read was happening anyway.

`withNoteClass(existing, status?)` in `src/notes/literature.ts` rewrites `cssclasses` to exactly `[NOTE_CLASS, status class, ...the user's own]`, dropping any stale `citation-graph-status-*`. Omitting the status strips the class instead of writing one.

`setStatus` writes the *stored* status as a class, because `processFrontMatter`'s callback is synchronous and cannot read the body to tell `read` from `annotated`. `applyStatusToPapers` follows up with `syncNoteClass(file, display)`, which upgrades it. That second call is a no-op when the two agree.

`src/canvas/status-classes.test.ts` reads `styles.css` off disk and asserts it styles exactly the statuses in `STATUS_LABELS`, with matching label text. The class names and the labels live in two files nothing else checks against each other; that test is the check.

## Why there is no generated stylesheet

Obsidian's plugin review rejects `document.createElement("style")` outright (`obsidianmd/no-forbidden-elements`, an error with no exceptions, checked by [`eslint-plugin-obsidianmd`](https://github.com/obsidianmd/eslint-plugin)). Every rule therefore has to be static, which rules out keying on the user's chosen colours.

Two alternatives were weighed and rejected. Setting custom properties on `document.body` with rules keyed on Obsidian's colour classes works for the six presets but not for custom hex values: every custom colour shares `.mod-canvas-color-custom`, so a static stylesheet cannot tell one from another. Dropping the labels entirely loses the feature.

## How Obsidian exposes a node's colour

No longer load-bearing, since nothing matches on the colour any more, but verified against Obsidian 1.13.7's `app.js` and `app.css` and worth keeping:

- **Preset (`"1"`..`"6"`)**: `.canvas-node` gets `.mod-canvas-color-<n>`. Obsidian's CSS resolves `--canvas-color: var(--canvas-color-<n>)` to a theme colour. **The preset ID never appears as a value anywhere.**
- **Custom hex**: `.mod-canvas-color-custom` plus an inline `--canvas-color`, normalised by Obsidian to lowercase six-digit hex. Every custom colour shares that one class.
- **No colour**: no class; `--canvas-color` is inherited from `body`, where Obsidian sets a grey. It is *not* empty.

`styles.css` still reads `--canvas-color` through the registered `@property --cg-status-color` to paint the frame, which is why that property is still there.

## History

**2026-09-01 (later) — two bugs behind a frozen reading list.** A paper with a summary showed *Read + notes written* whatever it was set to, so cycling it did nothing visible, and before the `syncNoteClass` fix below it flipped between two labels at random.

Two independent causes, both now covered by tests that fail against the previous code:

1. `displayStatusFor` derived `annotated` from the note body alone, ignoring the stored status. Now it requires `read` as well.
2. The cycle read the current status through `getStatus`, which goes to `metadataCache`. Obsidian refreshes that asynchronously, so two presses in quick succession both decided from the status before the first press. `updateStatus(file, next)` now reads the stored status and writes the answer inside one `processFrontMatter` call, so the decision cannot be separated from the write.

The same stale-cache trap had just been fixed in `syncNoteClass`, which had compared against `metadataCache` and skipped the write that would have corrected a class `setStatus` had left behind. Three instances of one hazard: **anything that reads a note back immediately after writing it must read the file, not the cache.**

**2026-09-01 — the runtime stylesheet is gone.** Obsidian's review forbids creating a `<style>` element, so the generated sheet had to go. Status moved back onto the note as a cssclass and `styles.css` became fully static, deleting `src/canvas/status-styles.ts`, its test, `applyStatusStyles`, `statusStyleEl`, the `onunload` cleanup, and every `@container style()` query along with the lowercase-hex coupling they depended on. See [[Community plugin submission]].

Appearance is unchanged. Two behaviours improved as a side effect: two statuses sharing a colour are now told apart by their labels, and a status left on *No colour* is labelled correctly instead of falling back to "To read". The settings tab's colour-clash warning was reworded to match.

This reverses the earlier move away from cssclasses (see below). What changed in between is that a single function now owns both the colour and the class and writes them in one pass over the note, so "the same fact in two places, kept in step by hand" no longer describes it. It adds no file lookup that was not already happening.

**2026-09-01 — presentation moved out of the generated sheet** (superseded hours later by the above). The sheet had emitted whole rule bodies including `border-width: 5px !important` and `opacity: 0.55`, putting four visual constants where no theme could reach them.

**2026-08-27 — labels and the abandoned style silently stopped working.** Every paper kept the "To read" label whatever its colour, and abandoned papers showed a solid red frame instead of a dashed, dimmed one. Only the frame colour tracked the status, because that comes from a direct `var(--canvas-color)` substitution in `styles.css` rather than from the generated rules.

Cause: the generated rules were `@container style(--canvas-color: 1)`, a style query for the *preset ID*. Obsidian never exposes the ID as a value (see above), so no rule ever matched. The default settings use presets throughout, so the whole runtime stylesheet was dead. Custom hex colours would have worked; nobody was using one.

A code comment asserted that "style queries match on computed value, so this does not care how Obsidian formats the inline style". That was the wrong end of the problem: the formatting was never the issue, the ID simply is not a value.

Fixed by splitting presets (matched by class) from custom colours (matched by value, under a style query), and extracting the generator into `src/canvas/status-styles.ts` so it was testable without an Obsidian runtime. That whole mechanism is now deleted.

**Earlier**: status was carried by a per-status `cssclasses` entry, matched with `.canvas-node:has(.citation-graph-abandoned)`. Replaced by the colour-derived scheme so the `.canvas` file would be the single source of truth. Now back, for the reason above.

## Deriving `annotated`

`displayStatusFor(file, status)` returns `annotated` only when `status === "read"` and `hasUserNotes(file)`. Both conditions matter:

- Requiring `read` is what makes the label honest. The plugin's own *Write summary* puts a `## Summary` section in the note, so deriving `annotated` from content alone marked papers as read that had never been opened.
- Requiring content is what makes it derived rather than stored, so writing notes into a paper changes its appearance with no command involved. That is what *Refresh reading status* is for.

Because `annotated` is reachable only from `read`, the cycle command moves cleanly through `unread → reading → read` and the canvas shows the third step as `annotated` when the note has content. Deriving it from content alone froze the cycle: every summarised paper displayed the same status whatever it was set to.

## Open questions

- The `@property --cg-status-color` fallback (`#424242`) in `styles.css` is unreachable, since `body` always supplies a `--canvas-color`. Kept as a guard against a future Obsidian that stops doing so.
- The status label is not shown at low zoom, where Obsidian swaps the node for a placeholder. Not investigated.
- A user who edits `status:` by hand sees the label lag until a plugin command repaints the canvas. The node colour has always had the same lag, so this is not a new class of problem, but it is now visible in two places instead of one.
