import type { App } from "obsidian";
import type { S2Paper } from "../types";
import { PaperPickerModal } from "./paper-picker";
import type { PaperChoice } from "./paper-picker";

export type FilterMode = "both" | "references" | "citations";
export type SortKey = "citations" | "year" | "title" | "paper";
export type SortDirection = "asc" | "desc";

const SORT_OPTIONS: Record<
  SortKey,
  { label: string; defaultDirection: SortDirection; value: (p: S2Paper) => number | string | null | undefined }
> = {
  citations: { label: "Citations", defaultDirection: "desc", value: (p) => p.citationCount },
  year: { label: "Year", defaultDirection: "desc", value: (p) => p.year },
  title: { label: "Title", defaultDirection: "asc", value: (p) => p.title || null },
  paper: { label: "Order in paper", defaultDirection: "asc", value: (p) => p.referenceIndex },
};

function isSortKey(value: string): value is SortKey {
  return Object.hasOwn(SORT_OPTIONS, value);
}

/** Sort in place by one key; papers missing that value go last in either direction. */
export function sortChoices(
  choices: PaperChoice[],
  key: SortKey,
  direction: SortDirection
): void {
  const valueOf = SORT_OPTIONS[key].value;
  const sign = direction === "asc" ? 1 : -1;
  choices.sort((a, b) => {
    const va = valueOf(a.paper);
    const vb = valueOf(b.paper);
    if (va == null || vb == null) return (va == null ? 1 : 0) - (vb == null ? 1 : 0);
    const order =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb, undefined, { sensitivity: "base", numeric: true })
        : Number(va) - Number(vb);
    return sign * order;
  });
}

export interface ExpandPickerResult {
  selected: S2Paper[];
  banned: S2Paper[];
}

interface ExpandChoice extends PaperChoice {
  relation: "reference" | "citation";
}

/**
 * Modal for selecting papers to add during Expand mode.
 * Shows checkboxes with paper metadata, sortable by citations, year, title or
 * position in the paper's reference list, plus a cited/citing filter. Papers
 * can be individually banned (marked uninteresting) via a button.
 */
export class ExpandPickerModal extends PaperPickerModal<ExpandChoice> {
  private filterMode: FilterMode = "both";
  private sortKey: SortKey = "citations";
  private sortDirection: SortDirection = SORT_OPTIONS.citations.defaultDirection;

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

    sortChoices(this.choices, this.sortKey, this.sortDirection);
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

    this.renderSortControls(container);
  }

  private renderSortControls(container: HTMLElement): void {
    const row = container.createDiv("citation-graph-sort-row");
    row.createSpan({ text: "Sort by:", cls: "citation-graph-sort-label" });

    const select = row.createEl("select", { cls: "dropdown" });
    const hasPaperOrder = this.choices.some((c) => c.paper.referenceIndex != null);
    for (const [key, option] of Object.entries(SORT_OPTIONS)) {
      const el = select.createEl("option", { value: key, text: option.label });
      if (key === "paper" && !hasPaperOrder) {
        el.disabled = true;
        el.text += " (not available)";
      }
    }
    select.value = this.sortKey;

    const directionBtn = row.createEl("button", { cls: "citation-graph-sort-direction" });
    const showDirection = () =>
      directionBtn.setText(this.sortDirection === "asc" ? "Ascending" : "Descending");
    showDirection();

    const apply = () => {
      showDirection();
      sortChoices(this.choices, this.sortKey, this.sortDirection);
      this.refresh();
    };
    select.addEventListener("change", () => {
      if (!isSortKey(select.value)) return;
      this.sortKey = select.value;
      this.sortDirection = SORT_OPTIONS[this.sortKey].defaultDirection;
      apply();
    });
    directionBtn.addEventListener("click", () => {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
      apply();
    });
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
