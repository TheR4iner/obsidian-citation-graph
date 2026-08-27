# Reading status on canvas nodes

## Overview

A paper's reading status is stored as `status:` in its literature note frontmatter and painted on the canvas as the node's `color` in the `.canvas` file. `annotated` is derived at paint time and never stored. The canvas node shows the status two ways: the frame colour, and a label spelled out along the bottom edge.

The label, the 5px frame and the dashed/dimmed treatment for `abandoned` come from a stylesheet the plugin injects at runtime (`statusStyleRules` in `src/canvas/status-styles.ts`, applied by `applyStatusStyles` in `src/main.ts`). It has to be generated because the colours are user-configurable. The static half lives in `styles.css`.

## How Obsidian exposes a node's colour

This is the fact the whole mechanism turns on, verified against Obsidian 1.13.7's `app.js` and `app.css`. A node's colour is applied by a helper that branches on whether the stored value is a bare integer:

- **Preset (`"1"`..`"6"`)**: the node element (`.canvas-node`) gets the class `.mod-canvas-color-<n>`. Nothing is set inline. Obsidian's own CSS then resolves `--canvas-color: var(--canvas-color-<n>)` down to a theme colour (`--color-red` and friends), which differs between light and dark theme and can be overridden by any theme or snippet. **The preset ID never appears as a value anywhere.**
- **Custom hex**: the node gets the class `.mod-canvas-color-custom` and an inline `--canvas-color`, normalised by Obsidian to lowercase six-digit hex. Every custom colour shares that one class.
- **No colour**: no class, and `--canvas-color` is inherited from `body`, where Obsidian sets a grey (`#c0c0c0` light, `#7e7e7e` dark). It is *not* empty.

Consequence: presets can only be matched **by class**, and custom colours only **by value** (a `@container style(--canvas-color: #hex)` query). One rule shape cannot serve both.

## Current solution

`statusStyleRules` emits, per configured status:

- preset → a plain rule keyed on `.canvas-node.mod-canvas-color-<n>:has(.citation-graph-note)`
- custom → the same rule keyed on `.mod-canvas-color-custom`, wrapped in `@container style(--canvas-color: <lowercase hex>)`

`parseStatusColor` already lowercases stored hex values, which is what makes the style query match Obsidian's normalised inline value. That coupling is load-bearing and is covered by a test.

Statuses left on the uncoloured default emit nothing: the static rule in `styles.css` labels those "To read".

## History

**2026-08-27 — labels and the abandoned style silently stopped working.** Every paper kept the "To read" label whatever its colour, and abandoned papers showed a solid red frame instead of a dashed, dimmed one. Only the frame colour tracked the status, because that comes from a direct `var(--canvas-color)` substitution in `styles.css` rather than from the generated rules.

Cause: the generated rules were `@container style(--canvas-color: 1)`, i.e. a style query for the *preset ID*. Obsidian never exposes the ID as a value (see above), so no rule ever matched. The default settings use presets throughout, so the whole runtime stylesheet was dead. Custom hex colours would have worked; nobody was using one.

A code comment asserted that "style queries match on computed value, so this does not care how Obsidian formats the inline style". That was the wrong end of the problem: the formatting was never the issue, the ID simply is not a value. Both comments have been corrected.

Fixed by splitting the two cases as described above, extracting the generator into `src/canvas/status-styles.ts` so it is testable without an Obsidian runtime, and adding `src/canvas/status-styles.test.ts` — including a test asserting no rule contains `style(--canvas-color: 3)`.

**Earlier**: status used to be carried by a per-status `cssclasses` entry in the note's frontmatter, matched with `.canvas-node:has(.citation-graph-abandoned)`. That was replaced by the colour-derived scheme so the `.canvas` file is the single source of truth; the old scheme stored the same fact twice and resolved through Obsidian's file lookup, which picks the wrong note when two filenames differ only in case.

## Open questions

- The `@property --cg-status-color` fallback (`#424242`) in `styles.css` is now unreachable, since `body` always supplies a `--canvas-color`. It is kept as a guard against a future Obsidian that stops doing so.
- The status label is not shown at low zoom, where Obsidian swaps the node for a placeholder. Not investigated.
