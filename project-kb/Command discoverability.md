# Command discoverability

## Overview

The plugin now registers sixteen commands, which is enough that the command palette became hard to scan. This note records what Obsidian actually offers for organising commands and what the plugin does about it.

## What Obsidian offers

Nothing native. The `Command` interface in `obsidian.d.ts` carries `id`, `name`, `icon`, `mobileOnly`, `repeatable`, the callback variants and `hotkeys`. There is no category, group, or submenu field, and the palette's only automatic grouping is the `Citation Graph:` prefix it derives from the manifest name. Verified against the bundled typings, not from memory.

Three levers exist instead:

1. **`checkCallback`**, which hides a command from the palette when it returns false. This is the only mechanism Obsidian genuinely provides for shortening the list.
2. **A pseudo-group in the command name.** The palette fuzzy-matches the whole displayed string, so a second prefix behaves like a group.
3. **Context menus**, which move per-object actions off the palette entirely.

## Current solution

All three levers, applied together.

**Availability gating.** The thirteen commands that need a canvas are registered through `canvasCommand()`, a wrapper returning a `checkCallback` that reports the command unavailable whenever `findActiveCanvas()` finds nothing. The gate deliberately reuses the very lookup the commands themselves perform, so a command is offered exactly when it would find a canvas to act on: any other predicate would drift. Only *Create from collection*, *Create from tag* and *Clear Semantic Scholar cache* are always available.

Gating does not remove a command from Settings, Hotkeys, and an assigned hotkey still exists; it simply does nothing while no canvas is open. The `logNotice("Open a citation graph canvas first...")` guards inside the commands were kept, since the context menu and any future caller can still reach them.

While wiring this up, seven byte-identical copies of the "active file, else any open canvas leaf" search were replaced by the existing `findActiveCanvas()` helper. They were what the gate had to agree with, and seven copies could not have stayed in agreement.

**Name prefixes.** Every command name carries a group prefix: `Canvas:`, `Papers:`, `Reading:`, `PDFs:`, `Maintenance:`. Command IDs were deliberately left alone, so user hotkeys survive the rename. The README refers to commands by their short name and says so once, which keeps prose references valid without rewriting forty italicised mentions.

**Canvas context menu.** `src/canvas/node-menu.ts` registers the per-paper actions on right-click of a canvas node, in addition to the palette rather than instead of it. Points worth knowing:

- The events used, `canvas:node-menu` and `canvas:selection-menu`, are real but absent from Obsidian's published typings. They are declared through a `declare module "obsidian"` augmentation rather than a cast, so the node and canvas shapes stay typed. If a future Obsidian release renames them, the listeners silently never fire and every action is still reachable from the palette.
- Actions receive the clicked node's path explicitly. Right-click does appear to select a canvas node, but nothing in the API guarantees it, so the menu path does not rely on the selection at all.
- To make that possible, the per-paper commands grew an optional target-list parameter, resolved by `resolveTargetPaths()`: explicit paths when given, else the canvas selection, always filtered to nodes actually on the canvas. `expandPaper` takes a single `notePath` instead, since it acts on one paper.
- Non-paper nodes (text cards, images, the user's own notes) get no entries at all. The gate is `LiteratureNoteManager.isPaperNote`, a metadata-cache lookup, rebuilt per call so a changed collections folder needs no reload.

## Open questions

- `findActiveCanvas()` accepts a canvas open in any leaf, not only the active one, so the gate keeps the commands visible while a canvas sits in a background tab. That matches what the commands then do, but it means the palette does not shorten in a workspace that always has a canvas open somewhere.
- The prefixes fight Obsidian's own style guide, which asks for plain sentence-case command names. Accepted deliberately: sixteen ungrouped commands were worse.

## History

### 2026-08-27

Added the group prefixes, the canvas context menu and the `checkCallback` gating, and deduplicated the canvas lookup. Seven unit tests cover the pure parts of the menu module: path extraction from either field Obsidian populates, selection collection, the non-paper gate, and the single-versus-multi entry sets.
