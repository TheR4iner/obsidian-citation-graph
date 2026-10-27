# PDF viewer setting

## Overview

Obsidian has no option to open PDFs in an external app. The `pdfViewer` setting (`obsidian` | `system`) adds one: with `system`, any vault PDF the user opens in a tab goes to the OS default app instead.

## Current solution

`src/pdf-viewer.ts` patches `WorkspaceLeaf.prototype.openFile`, the single funnel for links, the file explorer, canvas cards and the quick switcher. A PDF under the `system` setting is handed to Electron's `shell.openPath` with its absolute path, and the error string it returns is shown as a notice. A leaf whose view is `empty` (a "new tab" open creates it first) is detached so no blank tab is left behind. The patch is undone on unload via `this.register`.

Not covered, deliberately: embeds (`![[x.pdf]]`) and hover previews, which do not call `openFile`; workspace restore at startup, which uses `setViewState`. Zotero PDFs outside the vault are `file://` links and already open in the system viewer.

## Open questions

- A specific app (rather than the OS default) would need a path setting and `child_process`; add when asked.

## History

**2026-10-27** -- added.
