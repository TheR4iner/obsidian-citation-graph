import type { App } from "obsidian";
import type { S2Paper } from "../types";
import type { VerifiedRecommendation } from "../api/recommend";
import { PaperPickerModal } from "./paper-picker";
import type { PaperChoice } from "./paper-picker";

export interface RecommendPickerResult {
  selected: VerifiedRecommendation[];
  banned: S2Paper[];
}

interface RecommendChoice extends PaperChoice {
  recommendation: VerifiedRecommendation;
}

/**
 * Modal for selecting which recommended papers to add to the canvas.
 *
 * Identical interface to the Expand picker, with the model's justification
 * shown in place of the cited/citing badge. Every row here has already been
 * resolved against a citation source, so anything the user checks can become a
 * real node.
 */
export class RecommendPickerModal extends PaperPickerModal<RecommendChoice> {
  constructor(
    app: App,
    recommendations: VerifiedRecommendation[],
    existingIds: Set<string>,
    bannedIds: Set<string>
  ) {
    super(app);
    this.choices = recommendations
      .filter((r) => !bannedIds.has(r.resolved.paper.paperId))
      .map((r) => ({
        paper: r.resolved.paper,
        // The list is short and already filtered by the model, so rows start
        // checked: the common case is accepting most of them.
        selected: true,
        banned: false,
        alreadyOnCanvas: existingIds.has(r.resolved.paper.paperId),
        recommendation: r,
      }));
  }

  protected getTitle(): string {
    return "Recommended papers: select papers to add";
  }

  protected renderRowDetails(info: HTMLElement, choice: RecommendChoice): void {
    const reason = choice.recommendation.recommendation.reason;
    if (!reason) return;
    info.createDiv("citation-graph-paper-reason").setText(reason);
  }

  /** Open modal and return the accepted recommendations plus banned papers. */
  async pickPapers(): Promise<RecommendPickerResult> {
    const { selected, banned } = await this.pickChoices();
    return {
      selected: selected.map((c) => c.recommendation),
      banned: banned.map((c) => c.paper),
    };
  }
}
