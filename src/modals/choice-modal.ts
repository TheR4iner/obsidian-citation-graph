import { ButtonComponent } from "obsidian";
import type { App } from "obsidian";
import { PromiseModal } from "./promise-modal";

/** One button, and the answer clicking it produces. */
export interface Choice<T> {
  text: string;
  value: T;
  /** Render as the primary action. */
  cta?: boolean;
  /** Render as destructive. */
  warning?: boolean;
}

export interface ChoiceRequest<T> {
  title: string;
  /** Sentence above the buttons. */
  question: string;
  /** Optional bullet list between the question and the buttons. */
  items?: string[];
  choices: Choice<T>[];
  /** The answer produced by the Cancel button and by dismissing the dialog. */
  cancelled: T;
}

class ChoiceModal<T> extends PromiseModal<T> {
  constructor(app: App, private request: ChoiceRequest<T>) {
    super(app);
  }

  protected cancelledValue(): T {
    return this.request.cancelled;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-batch-modal");

    this.setTitle(this.request.title);
    contentEl.createEl("p", { text: this.request.question });

    if (this.request.items?.length) {
      const list = contentEl.createEl("ul", { cls: "citation-graph-batch-list" });
      for (const item of this.request.items) list.createEl("li", { text: item });
    }

    const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
    for (const choice of this.request.choices) {
      const button = new ButtonComponent(footer)
        .setButtonText(choice.text)
        .onClick(() => this.settle(choice.value));
      if (choice.cta) button.setCta();
      if (choice.warning) button.setWarning();
    }
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.settle(this.request.cancelled));
  }

  ask(): Promise<T> {
    return this.openAndWait();
  }
}

/**
 * Ask the user to pick one of a few labelled answers, and wait for it.
 *
 * Dismissing the dialog answers `cancelled`, exactly as the Cancel button
 * does, so a caller never has to distinguish "closed the window" from
 * "clicked Cancel".
 */
export function askChoice<T>(app: App, request: ChoiceRequest<T>): Promise<T> {
  return new ChoiceModal(app, request).ask();
}
