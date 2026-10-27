/// <reference types="node" />
import { App, FileSystemAdapter, OpenViewState, TFile, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import { logNotice } from "./log";

interface ElectronShell {
  /** Resolves to an error message, or "" on success. */
  openPath(fullPath: string): Promise<string>;
}

function electronShell(): ElectronShell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- electron is only reachable through require in a plugin
  return (require("electron") as { shell: ElectronShell }).shell;
}

/**
 * Send PDFs to the system's default app instead of an Obsidian tab while
 * `useSystem()` holds. Obsidian has no setting for this, and every way of
 * opening a file in a tab (links, the file list, canvas cards, quick switcher)
 * ends in `WorkspaceLeaf.openFile`, so that is the one place to catch it.
 * Embeds and hover previews do not go through it and stay inline.
 *
 * Returns the function that restores the original method.
 */
export function routePdfOpens(app: App, useSystem: () => boolean): () => void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- patching the prototype needs the unbound original; it is always invoked with .call
  const original = WorkspaceLeaf.prototype.openFile;
  WorkspaceLeaf.prototype.openFile = async function (
    this: WorkspaceLeaf,
    file: TFile,
    state?: OpenViewState
  ): Promise<void> {
    const adapter = app.vault.adapter;
    if (file.extension !== "pdf" || !useSystem() || !(adapter instanceof FileSystemAdapter)) {
      await original.call(this, file, state);
      return;
    }
    // A link opened "in a new tab" creates the tab before calling here.
    if (this.view.getViewType() === "empty") this.detach();
    const error = await electronShell().openPath(path.join(adapter.getBasePath(), file.path));
    if (error) logNotice(`Could not open ${file.name} in the system viewer: ${error}`, 10000);
  };
  return () => {
    WorkspaceLeaf.prototype.openFile = original;
  };
}
