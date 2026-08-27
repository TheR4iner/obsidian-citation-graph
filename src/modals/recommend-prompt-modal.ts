import { Modal, ButtonComponent, Setting } from "obsidian";
import type { App } from "obsidian";

export interface RecommendRequest {
  /** Empty means "use the configured or built-in default prompt". */
  prompt: string;
  includeAbstracts: boolean;
}

/** Rough per-abstract token cost, used only for the warning in the modal. */
const TOKENS_PER_ABSTRACT = 250;

/**
 * Asks for the prompt to send before recommending papers.
 *
 * The abstract toggle defaults to off and stays off between runs: on a large
 * canvas the abstracts dominate the prompt, which costs real money and tends
 * to pull the model toward whatever the longest abstracts talk about.
 */
export class RecommendPromptModal extends Modal {
  private resolvePromise: ((value: RecommendRequest | null) => void) | null = null;
  private includeAbstracts = false;

  constructor(
    app: App,
    private paperCount: number,
    private webSearchNote: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Recommend papers");

    contentEl.createDiv("citation-graph-recommend-intro").setText(
      `${this.paperCount} papers on this canvas will be described to the model. ${this.webSearchNote}`
    );

    const textarea = contentEl.createEl("textarea", {
      cls: "citation-graph-prompt-input",
      attr: {
        placeholder: "Leave empty to use the default prompt.",
        rows: "8",
      },
    });

    const extraTokens = this.paperCount * TOKENS_PER_ABSTRACT;
    new Setting(contentEl)
      .setName("Include abstracts")
      .setDesc(
        `Sends each paper's abstract as well as its title (roughly ${extraTokens.toLocaleString()} extra input tokens). ` +
        "Not recommended on a large canvas: it costs noticeably more and the extra text can crowd out the titles, " +
        "which usually makes the suggestions worse rather than better."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.includeAbstracts).onChange((value) => {
          this.includeAbstracts = value;
        })
      );

    const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
    new ButtonComponent(footer)
      .setButtonText("Get recommendations")
      .setCta()
      .onClick(() => this.submit(textarea.value));
    new ButtonComponent(footer)
      .setButtonText("Cancel")
      .onClick(() => this.close());

    // Enter inserts a newline in a prompt, so commit on Ctrl/Cmd+Enter instead.
    textarea.addEventListener("keydown", (e) => {
      if ((e.code === "Enter" || e.code === "NumpadEnter") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.submit(textarea.value);
      }
    });

    textarea.focus();
  }

  private submit(prompt: string): void {
    if (this.resolvePromise) {
      this.resolvePromise({
        prompt: prompt.trim(),
        includeAbstracts: this.includeAbstracts,
      });
      this.resolvePromise = null;
    }
    this.close();
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  /** Open the modal; resolves null when the user cancels. */
  pick(): Promise<RecommendRequest | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
