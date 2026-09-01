import { FuzzySuggestModal, Notice } from "obsidian";
import type { App } from "obsidian";
import type { ZoteroCollection } from "../types";
import { ZoteroClient } from "../api/zotero";

interface CollectionChoice {
  collection: ZoteroCollection;
  display: string;
}

export class CollectionPickerModal extends FuzzySuggestModal<CollectionChoice> {
  private choices: CollectionChoice[] = [];
  private resolved = false;
  private resolvePromise: ((value: ZoteroCollection | null) => void) | null = null;

  constructor(app: App) {
    super(app);
    this.setPlaceholder("Select a Zotero collection...");
  }

  async loadCollections(): Promise<void> {
    const client = new ZoteroClient("", "");
    try {
      const collections = await client.getCollections();
      this.choices = collections.map((c) => ({
        collection: c,
        display: c.data.groupName ? `[${c.data.groupName}] ${c.data.name}` : c.data.name,
      }));
    } catch (e) {
      new Notice(
        "Failed to connect to Zotero. Make sure Zotero is running and the local API is enabled."
      );
      throw e;
    }
  }

  getItems(): CollectionChoice[] {
    return this.choices;
  }

  getItemText(item: CollectionChoice): string {
    return item.display;
  }

  onChooseItem(item: CollectionChoice): void {
    if (this.resolvePromise && !this.resolved) {
      this.resolved = true;
      this.resolvePromise(item.collection);
    }
  }

  onClose(): void {
    // Delay null resolution to give onChooseItem a chance to fire first
    window.setTimeout(() => {
      if (this.resolvePromise && !this.resolved) {
        this.resolved = true;
        this.resolvePromise(null);
      }
    }, 100);
  }

  /** Open the modal and return the selected collection (or null if cancelled) */
  async pickCollection(): Promise<ZoteroCollection | null> {
    await this.loadCollections();
    if (this.choices.length === 0) {
      new Notice("No collections found in Zotero.");
      return null;
    }

    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.resolved = false;
      this.open();
    });
  }
}
