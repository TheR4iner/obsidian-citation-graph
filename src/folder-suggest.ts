import { AbstractInputSuggest, TFolder } from "obsidian";
import type { App } from "obsidian";

/** Autocomplete suggest for vault folder paths */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const lowerQuery = query.toLowerCase();
    const folders: TFolder[] = [];

    const walk = (folder: TFolder) => {
      if (folder.path.toLowerCase().includes(lowerQuery) || folder.path === "/") {
        folders.push(folder);
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };

    const root = this.app.vault.getRoot();
    walk(root);

    // Filter out root itself, sort alphabetically
    return folders
      .filter((f) => f.path !== "/")
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.trigger("input");
    this.close();
  }
}
