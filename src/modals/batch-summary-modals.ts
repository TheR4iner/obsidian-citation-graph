import { Modal, ButtonComponent } from "obsidian";
import type { App } from "obsidian";
import type { Paper } from "../types";

/**
 * Modal shown after adding a paper to a canvas to offer LLM summarization.
 */
export class PostAddSummaryModal extends Modal {
  private resolvePromise: ((result: boolean) => void) | null = null;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-batch-modal");

    this.setTitle("Generate summary?");
    contentEl.createEl("p", {
      text: "Would you also like to generate an LLM summary for this paper?",
    });

    const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
    new ButtonComponent(footer)
      .setButtonText("Yes, Summarize")
      .setCta()
      .onClick(() => { this.resolvePromise?.(true); this.resolvePromise = null; this.close(); });
    new ButtonComponent(footer)
      .setButtonText("No Thanks")
      .onClick(() => this.close());
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(false);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  pick(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Modal shown when some papers are missing PDFs during batch summary.
 * Offers to download all missing, skip them, or cancel.
 */
export class BatchMissingPdfModal extends Modal {
  private resolvePromise: ((result: "download" | "skip" | null) => void) | null = null;

  constructor(
    app: App,
    private missingPapers: Paper[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-batch-modal");

    this.setTitle("PDFs not found");
    contentEl.createEl("p", {
      text: `${this.missingPapers.length} paper${this.missingPapers.length > 1 ? "s do" : " does"} not have a downloaded PDF:`,
    });

    const list = contentEl.createEl("ul", { cls: "citation-graph-batch-list" });
    for (const paper of this.missingPapers) {
      list.createEl("li", { text: paper.title });
    }

    const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
    new ButtonComponent(footer)
      .setButtonText("Download All")
      .setCta()
      .onClick(() => { this.resolvePromise?.("download"); this.resolvePromise = null; this.close(); });
    new ButtonComponent(footer)
      .setButtonText("Skip These")
      .onClick(() => { this.resolvePromise?.("skip"); this.resolvePromise = null; this.close(); });
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.close());
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  pick(): Promise<"download" | "skip" | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Modal warning about long papers during batch summary.
 * Shows titles with estimated page counts.
 */
export class BatchLongPaperWarningModal extends Modal {
  private resolvePromise: ((result: boolean) => void) | null = null;

  constructor(
    app: App,
    private longPapers: { title: string; pages: number }[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-batch-modal");

    this.setTitle("Long paper warning");
    contentEl.createEl("p", {
      text: "The following papers are long and may take extra time and tokens to summarize:",
    });

    const list = contentEl.createEl("ul", { cls: "citation-graph-batch-list" });
    for (const { title, pages } of this.longPapers) {
      list.createEl("li", { text: `${title} (~${pages} pages)` });
    }

    const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
    new ButtonComponent(footer)
      .setButtonText("Proceed with All")
      .setCta()
      .onClick(() => { this.resolvePromise?.(true); this.resolvePromise = null; this.close(); });
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.close());
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(false);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  pick(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Modal asking how to handle existing summaries during batch summary.
 * Only shown when at least one paper already has a ## Summary section.
 */
export class BatchSummaryModeModal extends Modal {
  private resolvePromise: ((result: "append" | "replace" | null) => void) | null = null;

  constructor(
    app: App,
    private withSummaryCount: number,
    private totalCount: number,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-batch-modal");

    this.setTitle("Existing summaries found");
    contentEl.createEl("p", {
      text: `${this.withSummaryCount} of ${this.totalCount} selected paper${this.totalCount > 1 ? "s" : ""} already have a Summary section. How should existing summaries be handled?`,
    });

    const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
    new ButtonComponent(footer)
      .setButtonText("Append (with separator)")
      .setCta()
      .onClick(() => { this.resolvePromise?.("append"); this.resolvePromise = null; this.close(); });
    new ButtonComponent(footer)
      .setButtonText("Replace")
      .setWarning()
      .onClick(() => { this.resolvePromise?.("replace"); this.resolvePromise = null; this.close(); });
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.close());
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  pick(): Promise<"append" | "replace" | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
