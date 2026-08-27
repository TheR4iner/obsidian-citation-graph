import type { App } from "obsidian";
import type { S2Paper } from "../types";
import { PaperPickerModal } from "./paper-picker";
import type { PaperChoice } from "./paper-picker";

export type FilterMode = "both" | "references" | "citations";

export interface ExpandPickerResult {
  selected: S2Paper[];
  banned: S2Paper[];
}

interface ExpandChoice extends PaperChoice {
  relation: "reference" | "citation";
}

/**
 * Modal for selecting papers to add during Expand mode.
 * Shows checkboxes with paper metadata, sorted by citation count, plus a
 * cited/citing filter. Papers can be individually banned (marked
 * uninteresting) via a button.
 */
export class ExpandPickerModal extends PaperPickerModal<ExpandChoice> {
  private filterMode: FilterMode = "both";

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

  protected getTitle(): string {
    return "Expand paper: select papers to add";
  }

  protected renderHeaderControls(container: HTMLElement): void {
    const filterRow = container.createDiv("citation-graph-filter-row");
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
        this.refresh();
      });
    }
  }

  protected passesExtraFilter(choice: ExpandChoice): boolean {
    if (this.filterMode === "references") return choice.relation === "reference";
    if (this.filterMode === "citations") return choice.relation === "citation";
    return true;
  }

  protected renderRowBadges(actions: HTMLElement, choice: ExpandChoice): void {
    const badge = actions.createDiv("citation-graph-badge");
    badge.setText(choice.relation === "reference" ? "cited" : "citing");
  }

  /** Open modal and return selected + banned papers */
  async pickPapers(): Promise<ExpandPickerResult> {
    const { selected, banned } = await this.pickChoices();
    return {
      selected: selected.map((c) => c.paper),
      banned: banned.map((c) => c.paper),
    };
  }
}
