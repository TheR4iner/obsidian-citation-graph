import { App, FuzzySuggestModal } from "obsidian";
import type { PaperStatus } from "../types";
import { PAPER_STATUSES, STATUS_LABELS } from "../types";

/**
 * Pick a reading status to apply to the selected papers.
 *
 * "Read + notes written" is deliberately not offered: it is derived from the
 * note body at paint time, so there is nothing to set.
 */
export class StatusPickerModal extends FuzzySuggestModal<PaperStatus> {
  private resolved = false;

  private constructor(
    app: App,
    private paperCount: number,
    private done: (status: PaperStatus | null) => void
  ) {
    super(app);
    this.setPlaceholder(
      `Set status for ${paperCount} paper${paperCount === 1 ? "" : "s"}`
    );
  }

  /** Open the picker, resolving to the chosen status or null if dismissed. */
  static pick(app: App, paperCount: number): Promise<PaperStatus | null> {
    return new Promise((resolve) => {
      new StatusPickerModal(app, paperCount, resolve).open();
    });
  }

  getItems(): PaperStatus[] {
    return [...PAPER_STATUSES];
  }

  getItemText(status: PaperStatus): string {
    return STATUS_LABELS[status];
  }

  onChooseItem(status: PaperStatus): void {
    this.settle(status);
  }

  onClose(): void {
    // onChooseItem fires before onClose, so defer to let a choice win.
    setTimeout(() => this.settle(null), 50);
  }

  private settle(status: PaperStatus | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.done(status);
  }
}
