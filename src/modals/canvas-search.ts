import { App, SuggestModal } from "obsidian";
import { matchesPaperQuery } from "../canvas/search";

/** One paper node on the open canvas, as the search lists it. */
export interface CanvasSearchItem {
  nodeId: string;
  title: string;
  authors: string[];
  year: number;
}

/**
 * Search the papers on a canvas by title or author.
 *
 * Every match is highlighted on the canvas as the user types. Choosing a
 * result zooms to it and leaves the highlights in place; closing without a
 * choice clears them, which is also how a later search removes old ones.
 */
export class CanvasSearchModal extends SuggestModal<CanvasSearchItem> {
  private chosen = false;

  constructor(
    app: App,
    private items: CanvasSearchItem[],
    private highlight: (nodeIds: Set<string>) => void,
    private reveal: (nodeId: string) => void
  ) {
    super(app);
    this.setPlaceholder("Search papers on this canvas by title or author");
    this.emptyStateText = "No matching papers.";
  }

  getSuggestions(query: string): CanvasSearchItem[] {
    const hits = this.items.filter((item) => matchesPaperQuery(item, query));
    this.highlight(new Set(hits.map((hit) => hit.nodeId)));
    return hits;
  }

  renderSuggestion(item: CanvasSearchItem, el: HTMLElement): void {
    el.createDiv({ text: item.title });
    const year = item.year ? ` (${item.year})` : "";
    el.createEl("small", { text: item.authors.join(", ") + year });
  }

  onChooseSuggestion(item: CanvasSearchItem): void {
    this.chosen = true;
    this.reveal(item.nodeId);
  }

  onClose(): void {
    // Obsidian closes the modal before reporting the choice, so wait for it.
    window.setTimeout(() => {
      if (!this.chosen) this.highlight(new Set());
    }, 50);
  }
}
