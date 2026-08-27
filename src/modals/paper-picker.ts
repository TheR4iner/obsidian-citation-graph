import { Modal, ButtonComponent } from "obsidian";
import type { App } from "obsidian";
import type { S2Paper } from "../types";

/** One row in a paper picker. Subclasses widen this with their own fields. */
export interface PaperChoice {
  paper: S2Paper;
  selected: boolean;
  banned: boolean;
  /** Shown checked and disabled: the canvas already holds this paper. */
  alreadyOnCanvas: boolean;
}

/** What a picker hands back: the rows the user accepted, and the ones they rejected. */
export interface PickerResult<C extends PaperChoice> {
  selected: C[];
  banned: C[];
}

/**
 * Shared modal for choosing papers to add to a canvas: a scrollable checkbox
 * list with a text search, a year range, per-row ban buttons, and a live count.
 *
 * Subclasses supply the title, the choices, and any per-row decoration. The
 * Expand and Recommend commands both present the same interface deliberately,
 * so the behaviour lives here rather than being kept in step by hand.
 */
export abstract class PaperPickerModal<C extends PaperChoice> extends Modal {
  protected choices: C[] = [];
  protected searchQuery = "";
  protected yearMin = "";
  protected yearMax = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private resolvePromise: ((result: PickerResult<C>) => void) | null = null;

  constructor(app: App) {
    super(app);
  }

  /** Modal heading. */
  protected abstract getTitle(): string;

  /** Controls rendered above the search box (Expand uses this for its filters). */
  protected renderHeaderControls(_container: HTMLElement): void {
    // Nothing by default.
  }

  /** Additional per-row filtering, applied after search and year. */
  protected passesExtraFilter(_choice: C): boolean {
    return true;
  }

  /** Extra content under the paper metadata line. */
  protected renderRowDetails(_info: HTMLElement, _choice: C): void {
    // Nothing by default.
  }

  /** Badges rendered to the right of the row, before the ban button. */
  protected renderRowBadges(_actions: HTMLElement, _choice: C): void {
    // Nothing by default.
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-expand-modal");

    this.setTitle(this.getTitle());

    this.renderHeaderControls(contentEl);

    const searchRow = contentEl.createDiv("citation-graph-search-row");
    const searchInput = searchRow.createEl("input", {
      type: "text",
      placeholder: "Search title, authors, abstract...",
      cls: "citation-graph-search-input",
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.toLowerCase();
      this.refresh();
    });

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
      this.refresh();
    });
    yearMaxInput.addEventListener("input", () => {
      this.yearMax = yearMaxInput.value;
      this.refresh();
    });

    this.countEl = contentEl.createDiv("citation-graph-count");
    this.updateCount();

    this.listEl = contentEl.createDiv("citation-graph-paper-list");
    this.renderList();

    const footer = contentEl.createDiv("citation-graph-footer");

    new ButtonComponent(footer)
      .setButtonText("Add selected papers")
      .setCta()
      .onClick(() => this.resolveWith(false));

    new ButtonComponent(footer)
      .setButtonText("Add selected & ban rest")
      .setTooltip("Add selected papers and mark all non-selected as uninteresting")
      .onClick(() => this.resolveWith(true));

    new ButtonComponent(footer).setButtonText("Cancel").onClick(() => this.close());
  }

  /** Re-render the list and the count after a filter or selection change. */
  protected refresh(): void {
    this.renderList();
    this.updateCount();
  }

  private resolveWith(banRest: boolean): void {
    const selected = this.choices.filter((c) => c.selected && !c.alreadyOnCanvas);

    // Banned = explicitly banned rows + (if banRest) everything not selected
    // and not already on the canvas.
    const banned = this.choices.filter((c) => {
      if (c.alreadyOnCanvas) return false;
      if (c.banned) return true;
      if (banRest && !c.selected) return true;
      return false;
    });

    if (this.resolvePromise) {
      this.resolvePromise({ selected, banned });
      this.resolvePromise = null;
    }
    this.close();
  }

  protected getFilteredChoices(): C[] {
    const minYear = this.yearMin ? parseInt(this.yearMin) : null;
    const maxYear = this.yearMax ? parseInt(this.yearMax) : null;

    return this.choices.filter((c) => {
      if (c.banned) return false;
      if (!this.passesExtraFilter(c)) return false;

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

  private updateCount(): void {
    if (!this.countEl) return;
    const filtered = this.getFilteredChoices();
    const total = filtered.length;
    const onCanvas = filtered.filter((c) => c.alreadyOnCanvas).length;
    const selected = filtered.filter((c) => c.selected && !c.alreadyOnCanvas).length;
    const bannedCount = this.choices.filter((c) => c.banned).length;
    let text = `${total} papers found (${onCanvas} already on canvas, ${selected} selected)`;
    if (bannedCount > 0) text += ` · ${bannedCount} marked uninteresting`;
    this.countEl.setText(text);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    for (const choice of this.getFilteredChoices()) {
      const row = this.listEl.createDiv(
        "citation-graph-paper-row" + (choice.alreadyOnCanvas ? " is-on-canvas" : "")
      );

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = choice.selected || choice.alreadyOnCanvas;
      checkbox.disabled = choice.alreadyOnCanvas;
      checkbox.addEventListener("change", () => {
        choice.selected = checkbox.checked;
        this.updateCount();
      });

      const info = row.createDiv("citation-graph-paper-info");
      info.createEl("strong", { text: choice.paper.title || "Untitled" });

      const meta = info.createDiv("citation-graph-paper-meta");
      const allAuthors = choice.paper.authors || [];
      const authors = allAuthors.slice(0, 3).map((a) => a.name).join(", ");
      const authorSuffix = allAuthors.length > 3 ? ` +${allAuthors.length - 3}` : "";
      meta.createSpan({
        text: `${authors}${authorSuffix} · ${choice.paper.year || "?"} · ${choice.paper.citationCount ?? "?"} citations`,
      });

      this.renderRowDetails(info, choice);

      if (choice.paper.abstract) {
        const abs = info.createDiv("citation-graph-paper-abstract");
        abs.setText(
          choice.paper.abstract.length > 200
            ? choice.paper.abstract.slice(0, 200) + "…"
            : choice.paper.abstract
        );
      }

      const rightActions = row.createDiv("citation-graph-row-actions");
      this.renderRowBadges(rightActions, choice);

      if (!choice.alreadyOnCanvas) {
        const banBtn = rightActions.createEl("button", {
          cls: "citation-graph-ban-btn",
          attr: { "aria-label": "Mark as uninteresting" },
        });
        banBtn.setText("✕");
        banBtn.addEventListener("click", () => {
          choice.banned = true;
          choice.selected = false;
          this.refresh();
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
    this.listEl = null;
    this.contentEl.empty();
  }

  /** Open the modal and resolve once the user commits or cancels. */
  protected pickChoices(): Promise<PickerResult<C>> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
