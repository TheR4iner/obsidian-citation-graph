import { Modal, ButtonComponent } from "obsidian";
import type { App } from "obsidian";
import type { S2Paper } from "../types";

export type FilterMode = "both" | "references" | "citations";

export interface ExpandPickerResult {
  selected: S2Paper[];
  banned: S2Paper[];
}

interface PaperChoice {
  paper: S2Paper;
  selected: boolean;
  banned: boolean;
  alreadyOnCanvas: boolean;
  relation: "reference" | "citation";
}

/**
 * Modal for selecting papers to add during Expand mode.
 * Shows checkboxes with paper metadata, sorted by citation count.
 * Papers can be individually banned (marked uninteresting) via a button.
 */
export class ExpandPickerModal extends Modal {
  private choices: PaperChoice[] = [];
  private filterMode: FilterMode = "both";
  private searchQuery = "";
  private yearMin = "";
  private yearMax = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private resolvePromise: ((result: ExpandPickerResult) => void) | null = null;

  constructor(
    app: App,
    private references: S2Paper[],
    private citations: S2Paper[],
    private existingIds: Set<string>,
    private bannedIds: Set<string>
  ) {
    super(app);
    this.buildChoices();
  }

  private buildChoices(): void {
    this.choices = [];

    for (const paper of this.references) {
      if (!paper.paperId) continue;
      if (this.bannedIds.has(paper.paperId)) continue;
      this.choices.push({
        paper,
        selected: false,
        banned: false,
        alreadyOnCanvas: this.existingIds.has(paper.paperId),
        relation: "reference",
      });
    }

    for (const paper of this.citations) {
      if (!paper.paperId) continue;
      if (this.bannedIds.has(paper.paperId)) continue;
      // Avoid duplicates if a paper appears in both
      if (this.choices.some((c) => c.paper.paperId === paper.paperId)) continue;
      this.choices.push({
        paper,
        selected: false,
        banned: false,
        alreadyOnCanvas: this.existingIds.has(paper.paperId),
        relation: "citation",
      });
    }

    // Sort by citation count descending
    this.choices.sort(
      (a, b) => (b.paper.citationCount || 0) - (a.paper.citationCount || 0)
    );
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-expand-modal");

    contentEl.createEl("h2", { text: "Expand Paper — Select papers to add" });

    // Filter buttons
    const filterRow = contentEl.createDiv("citation-graph-filter-row");
    const filters: Array<{ label: string; mode: FilterMode }> = [
      { label: "Both", mode: "both" },
      { label: "Cited by this paper", mode: "references" },
      { label: "Cites this paper", mode: "citations" },
    ];

    for (const f of filters) {
      const btn = filterRow.createEl("button", {
        text: f.label,
        cls:
          "citation-graph-filter-btn" +
          (this.filterMode === f.mode ? " is-active" : ""),
      });
      btn.addEventListener("click", () => {
        this.filterMode = f.mode;
        // Update active states
        filterRow
          .querySelectorAll(".citation-graph-filter-btn")
          .forEach((el) => el.removeClass("is-active"));
        btn.addClass("is-active");
        this.renderList();
        if (this.countEl) this.updateCount(this.countEl);
      });
    }

    // Search input
    const searchRow = contentEl.createDiv("citation-graph-search-row");
    const searchInput = searchRow.createEl("input", {
      type: "text",
      placeholder: "Search title, authors, abstract...",
      cls: "citation-graph-search-input",
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.toLowerCase();
      this.renderList();
      if (this.countEl) this.updateCount(this.countEl);
    });

    // Year filter
    const yearRow = contentEl.createDiv("citation-graph-year-row");
    yearRow.createSpan({ text: "Year:", cls: "citation-graph-year-label" });
    const yearMinInput = yearRow.createEl("input", {
      type: "number",
      placeholder: "from",
      cls: "citation-graph-year-input",
    });
    const yearMaxInput = yearRow.createEl("input", {
      type: "number",
      placeholder: "to",
      cls: "citation-graph-year-input",
    });
    yearMinInput.addEventListener("input", () => {
      this.yearMin = yearMinInput.value;
      this.renderList();
      if (this.countEl) this.updateCount(this.countEl);
    });
    yearMaxInput.addEventListener("input", () => {
      this.yearMax = yearMaxInput.value;
      this.renderList();
      if (this.countEl) this.updateCount(this.countEl);
    });

    // Paper count
    this.countEl = contentEl.createDiv("citation-graph-count");
    this.updateCount(this.countEl);

    // Scrollable list
    this.listEl = contentEl.createDiv("citation-graph-paper-list");
    this.renderList();

    // Footer buttons
    const footer = contentEl.createDiv("citation-graph-footer");

    new ButtonComponent(footer)
      .setButtonText("Add selected papers")
      .setCta()
      .onClick(() => {
        this.resolveWith(false);
      });

    new ButtonComponent(footer)
      .setButtonText("Add selected & ban rest")
      .setTooltip("Add selected papers and mark all non-selected as uninteresting")
      .onClick(() => {
        this.resolveWith(true);
      });

    new ButtonComponent(footer).setButtonText("Cancel").onClick(() => {
      this.close();
    });
  }

  private resolveWith(banRest: boolean): void {
    const selected = this.choices
      .filter((c) => c.selected && !c.alreadyOnCanvas)
      .map((c) => c.paper);

    // Banned = explicitly banned papers + (if banRest) all non-selected, non-canvas papers
    const banned = this.choices
      .filter((c) => {
        if (c.alreadyOnCanvas) return false;
        if (c.banned) return true;
        if (banRest && !c.selected) return true;
        return false;
      })
      .map((c) => c.paper);

    if (this.resolvePromise) {
      this.resolvePromise({ selected, banned });
      this.resolvePromise = null;
    }
    this.close();
  }

  private getFilteredChoices(): PaperChoice[] {
    const minYear = this.yearMin ? parseInt(this.yearMin) : null;
    const maxYear = this.yearMax ? parseInt(this.yearMax) : null;

    return this.choices.filter((c) => {
      if (c.banned) return false;
      if (this.filterMode === "references" && c.relation !== "reference") return false;
      if (this.filterMode === "citations" && c.relation !== "citation") return false;

      if (this.searchQuery) {
        const q = this.searchQuery;
        const title = (c.paper.title || "").toLowerCase();
        const abstract = (c.paper.abstract || "").toLowerCase();
        const authors = (c.paper.authors || []).map((a) => a.name.toLowerCase()).join(" ");
        if (!title.includes(q) && !abstract.includes(q) && !authors.includes(q)) return false;
      }

      if (minYear !== null && (c.paper.year == null || c.paper.year < minYear)) return false;
      if (maxYear !== null && (c.paper.year == null || c.paper.year > maxYear)) return false;

      return true;
    });
  }

  private updateCount(el: HTMLElement): void {
    const filtered = this.getFilteredChoices();
    const total = filtered.length;
    const onCanvas = filtered.filter((c) => c.alreadyOnCanvas).length;
    const selected = filtered.filter((c) => c.selected && !c.alreadyOnCanvas).length;
    const bannedCount = this.choices.filter((c) => c.banned).length;
    let text = `${total} papers found (${onCanvas} already on canvas, ${selected} selected)`;
    if (bannedCount > 0) text += ` · ${bannedCount} marked uninteresting`;
    el.setText(text);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const filtered = this.getFilteredChoices();

    for (const choice of filtered) {
      const row = this.listEl.createDiv(
        "citation-graph-paper-row" + (choice.alreadyOnCanvas ? " is-on-canvas" : "")
      );

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = choice.selected || choice.alreadyOnCanvas;
      checkbox.disabled = choice.alreadyOnCanvas;
      checkbox.addEventListener("change", () => {
        choice.selected = checkbox.checked;
        if (this.countEl) this.updateCount(this.countEl);
      });

      const info = row.createDiv("citation-graph-paper-info");
      info.createEl("strong", { text: choice.paper.title || "Untitled" });

      const meta = info.createDiv("citation-graph-paper-meta");
      const authors = (choice.paper.authors || [])
        .slice(0, 3)
        .map((a) => a.name)
        .join(", ");
      const authorSuffix =
        (choice.paper.authors || []).length > 3
          ? ` +${(choice.paper.authors || []).length - 3}`
          : "";
      meta.createSpan({
        text: `${authors}${authorSuffix} · ${choice.paper.year || "?"} · ${choice.paper.citationCount ?? "?"} citations`,
      });

      if (choice.paper.abstract) {
        const abs = info.createDiv("citation-graph-paper-abstract");
        abs.setText(
          choice.paper.abstract.length > 200
            ? choice.paper.abstract.slice(0, 200) + "…"
            : choice.paper.abstract
        );
      }

      const rightActions = row.createDiv("citation-graph-row-actions");

      const badge = rightActions.createDiv("citation-graph-badge");
      badge.setText(choice.relation === "reference" ? "cited" : "citing");

      if (!choice.alreadyOnCanvas) {
        const banBtn = rightActions.createEl("button", {
          cls: "citation-graph-ban-btn",
          attr: { "aria-label": "Mark as uninteresting" },
        });
        banBtn.setText("✕");
        banBtn.addEventListener("click", () => {
          choice.banned = true;
          choice.selected = false;
          this.renderList();
          if (this.countEl) this.updateCount(this.countEl);
        });
      }
    }
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise({ selected: [], banned: [] });
      this.resolvePromise = null;
    }
    this.countEl = null;
    this.contentEl.empty();
  }

  /** Open modal and return selected + banned papers */
  pickPapers(): Promise<ExpandPickerResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
