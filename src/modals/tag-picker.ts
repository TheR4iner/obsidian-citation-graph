import { Modal, ButtonComponent, Notice, ToggleComponent } from "obsidian";
import type { App } from "obsidian";
import type { ZoteroItem } from "../types";
import { ZoteroClient } from "../api/zotero";

export interface TagPickerResult {
  tags: string[];
  items: ZoteroItem[];
}

interface TagInfo {
  tag: string;
  /** True if this tag appears as a manual (type 0) tag on at least one item. */
  hasManual: boolean;
  /** Items that carry this tag (any type). */
  itemKeys: Set<string>;
}

export class TagPickerModal extends Modal {
  private allItems: ZoteroItem[] = [];
  private tagsByName = new Map<string, TagInfo>();
  private selectedTags = new Set<string>();
  private showAutomatic = false;
  private searchQuery = "";

  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private confirmBtn: ButtonComponent | null = null;
  private resolvePromise: ((result: TagPickerResult | null) => void) | null = null;
  private resolved = false;

  constructor(app: App) {
    super(app);
  }

  async loadItems(): Promise<void> {
    const client = new ZoteroClient("", "");
    try {
      this.allItems = await client.getAllItems();
    } catch (e) {
      new Notice(
        "Failed to connect to Zotero. Make sure Zotero is running and the local API is enabled."
      );
      throw e;
    }
    this.indexTags();
  }

  private indexTags(): void {
    this.tagsByName.clear();
    for (const item of this.allItems) {
      const tags = item.data.tags || [];
      for (const t of tags) {
        const name = t.tag;
        if (!name) continue;
        let info = this.tagsByName.get(name);
        if (!info) {
          info = { tag: name, hasManual: false, itemKeys: new Set() };
          this.tagsByName.set(name, info);
        }
        // Treat absent type as manual (Zotero default for user-added tags).
        if (t.type == null || t.type === 0) info.hasManual = true;
        info.itemKeys.add(item.data.key);
      }
    }
  }

  private getVisibleTags(): TagInfo[] {
    const q = this.searchQuery.toLowerCase();
    const all = Array.from(this.tagsByName.values());
    return all
      .filter((info) => this.showAutomatic || info.hasManual)
      .filter((info) => !q || info.tag.toLowerCase().includes(q))
      .sort((a, b) => {
        // Selected first, then by item count desc, then alpha.
        const aSel = this.selectedTags.has(a.tag) ? 0 : 1;
        const bSel = this.selectedTags.has(b.tag) ? 0 : 1;
        if (aSel !== bSel) return aSel - bSel;
        const diff = b.itemKeys.size - a.itemKeys.size;
        if (diff !== 0) return diff;
        return a.tag.localeCompare(b.tag);
      });
  }

  /** Items matching the intersection of all currently-selected tags. */
  private getMatchingItems(): ZoteroItem[] {
    if (this.selectedTags.size === 0) return [];
    const sel = Array.from(this.selectedTags);
    return this.allItems.filter((item) => {
      const itemTags = new Set((item.data.tags || []).map((t) => t.tag));
      return sel.every((t) => itemTags.has(t));
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-tag-modal");

    contentEl.createEl("h2", { text: "Create from Tag" });
    contentEl.createEl("p", {
      text: "Select one or more tags. Multiple tags = intersection (papers must have all selected tags).",
      cls: "citation-graph-tag-help",
    });

    // Toggle for automatic tags
    const toggleRow = contentEl.createDiv("citation-graph-tag-toggle-row");
    toggleRow.createSpan({
      text: "Show automatic tags",
      cls: "citation-graph-tag-toggle-label",
    });
    const toggleHolder = toggleRow.createDiv();
    new ToggleComponent(toggleHolder)
      .setValue(this.showAutomatic)
      .onChange((v) => {
        this.showAutomatic = v;
        // Drop selections that just became hidden, so the count and submit
        // state reflect what the user can actually see.
        for (const t of Array.from(this.selectedTags)) {
          const info = this.tagsByName.get(t);
          if (info && !info.hasManual && !this.showAutomatic) {
            this.selectedTags.delete(t);
          }
        }
        this.renderList();
        this.updateCount();
      });

    // Search input
    const searchRow = contentEl.createDiv("citation-graph-tag-search-row");
    const searchInput = searchRow.createEl("input", {
      type: "text",
      placeholder: "Filter tags...",
      cls: "citation-graph-tag-search-input",
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.renderList();
    });

    // Count line
    this.countEl = contentEl.createDiv("citation-graph-tag-count");
    this.updateCount();

    // Tag list
    this.listEl = contentEl.createDiv("citation-graph-tag-list");
    this.renderList();

    // Footer
    const footer = contentEl.createDiv("citation-graph-tag-footer");
    this.confirmBtn = new ButtonComponent(footer)
      .setButtonText("Create canvas")
      .setCta()
      .onClick(() => this.submit());
    new ButtonComponent(footer).setButtonText("Cancel").onClick(() => this.close());
    this.refreshConfirmState();
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const visible = this.getVisibleTags();
    if (visible.length === 0) {
      this.listEl.createDiv({
        text: this.tagsByName.size === 0
          ? "No tags found in your Zotero library."
          : "No tags match the current filter.",
        cls: "citation-graph-tag-empty",
      });
      return;
    }

    for (const info of visible) {
      const row = this.listEl.createDiv("citation-graph-tag-row");
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedTags.has(info.tag);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedTags.add(info.tag);
        else this.selectedTags.delete(info.tag);
        this.updateCount();
      });

      const label = row.createDiv("citation-graph-tag-label");
      label.createSpan({ text: info.tag });
      if (!info.hasManual) {
        label.createSpan({
          text: " auto",
          cls: "citation-graph-tag-auto-badge",
        });
      }

      row.createSpan({
        text: `${info.itemKeys.size}`,
        cls: "citation-graph-tag-itemcount",
      });

      // Whole-row click toggles the checkbox for ergonomic multi-select.
      row.addEventListener("click", (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      });
    }
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const matching = this.getMatchingItems();
    if (this.selectedTags.size === 0) {
      this.countEl.setText("Select at least one tag.");
    } else {
      const tagList = Array.from(this.selectedTags).join(" ∩ ");
      this.countEl.setText(`${matching.length} papers match: ${tagList}`);
    }
    this.refreshConfirmState();
  }

  private refreshConfirmState(): void {
    if (!this.confirmBtn) return;
    const matching = this.getMatchingItems();
    this.confirmBtn.setDisabled(matching.length === 0);
  }

  private submit(): void {
    const items = this.getMatchingItems();
    if (items.length === 0) return;
    if (this.resolvePromise && !this.resolved) {
      this.resolved = true;
      this.resolvePromise({
        tags: Array.from(this.selectedTags),
        items,
      });
    }
    this.close();
  }

  onClose(): void {
    setTimeout(() => {
      if (this.resolvePromise && !this.resolved) {
        this.resolved = true;
        this.resolvePromise(null);
      }
    }, 100);
    this.contentEl.empty();
  }

  async pickTags(): Promise<TagPickerResult | null> {
    await this.loadItems();
    if (this.tagsByName.size === 0) {
      new Notice("No tags found in your Zotero library.");
      return null;
    }
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.resolved = false;
      this.open();
    });
  }
}
