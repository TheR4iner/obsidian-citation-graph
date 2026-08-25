import { Modal, ButtonComponent } from "obsidian";
import type { App } from "obsidian";
import type { Paper, CanvasNode } from "../types";
import { resolvePaperNodeId } from "../canvas/layout";

interface SendChoice {
  paper: Paper;
  node: CanvasNode;
  selected: boolean;
}

export interface SendPickerResult {
  papers: Paper[];
  nodeIds: Set<string>;
}

/**
 * Modal for selecting papers to send (copy/move) to another canvas.
 * Multi-select checkbox list with Select All / Deselect All.
 */
export class SendPickerModal extends Modal {
  private choices: SendChoice[] = [];
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private resolvePromise: ((result: SendPickerResult | null) => void) | null = null;

  constructor(
    app: App,
    papers: Paper[],
    nodes: CanvasNode[],
  ) {
    super(app);

    // Pair each paper with its canvas node
    const nodeById = new Map<string, CanvasNode>();
    for (const node of nodes) {
      nodeById.set(node.id, node);
    }

    const nodeIds = new Set(nodeById.keys());
    this.choices = papers
      .map((paper) => {
        // Resolved against the canvas's own IDs: matching only the current
        // scheme would drop every paper on a canvas written before the node ID
        // widened, leaving the picker empty.
        const node = nodeById.get(resolvePaperNodeId(paper, nodeIds));
        if (!node) return null;
        return { paper, node, selected: false };
      })
      .filter((c): c is SendChoice => c !== null)
      .sort((a, b) => {
        if (a.paper.year !== b.paper.year) return (a.paper.year || 0) - (b.paper.year || 0);
        return (a.paper.title || "").localeCompare(b.paper.title || "");
      });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-send-modal");

    this.setTitle("Send papers to canvas");

    // Select all / deselect all
    const actionRow = contentEl.createDiv("citation-graph-download-actions");
    new ButtonComponent(actionRow)
      .setButtonText("Select all")
      .onClick(() => {
        for (const c of this.choices) c.selected = true;
        this.renderList();
      });
    new ButtonComponent(actionRow)
      .setButtonText("Deselect all")
      .onClick(() => {
        for (const c of this.choices) c.selected = false;
        this.renderList();
      });

    // Count
    this.countEl = contentEl.createDiv("citation-graph-count");
    this.updateCount();

    // Scrollable list
    this.listEl = contentEl.createDiv("citation-graph-paper-list");
    this.renderList();

    // Footer
    const footer = contentEl.createDiv("citation-graph-footer");
    new ButtonComponent(footer)
      .setButtonText("Send selected")
      .setCta()
      .onClick(() => {
        const selected = this.choices.filter((c) => c.selected);
        if (selected.length === 0) return;
        if (this.resolvePromise) {
          this.resolvePromise({
            papers: selected.map((c) => c.paper),
            nodeIds: new Set(selected.map((c) => c.node.id)),
          });
          this.resolvePromise = null;
        }
        this.close();
      });
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.close());
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const total = this.choices.length;
    const selected = this.choices.filter((c) => c.selected).length;
    this.countEl.setText(`${total} papers · ${selected} selected`);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    for (const choice of this.choices) {
      const row = this.listEl.createDiv("citation-graph-paper-row");

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = choice.selected;
      checkbox.addEventListener("change", () => {
        choice.selected = checkbox.checked;
        this.updateCount();
      });

      const info = row.createDiv("citation-graph-paper-info");
      info.createEl("strong", { text: choice.paper.title || "Untitled" });
      const meta = info.createDiv("citation-graph-paper-meta");
      const authors = choice.paper.authors.slice(0, 3).join(", ");
      const authorSuffix = choice.paper.authors.length > 3
        ? ` +${choice.paper.authors.length - 3}`
        : "";
      meta.createSpan({
        text: `${authors}${authorSuffix} · ${choice.paper.year || "?"}`,
      });

      const rightActions = row.createDiv("citation-graph-row-actions");
      rightActions.createDiv({
        cls: "citation-graph-badge",
        text: String(choice.paper.year || "?"),
      });
    }

    this.updateCount();
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  pickPapers(): Promise<SendPickerResult | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
