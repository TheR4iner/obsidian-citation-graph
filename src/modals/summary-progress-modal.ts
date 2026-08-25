import { Modal, ButtonComponent } from "obsidian";
import type { App } from "obsidian";

/**
 * Modal that stays open during batch summarization, showing a progress bar,
 * per-paper status log, token usage, and a cancel button.
 */
export class SummaryProgressModal extends Modal {
	private progressFillEl!: HTMLDivElement;
	private statusEl!: HTMLDivElement;
	private tokensEl!: HTMLDivElement;
	private logEl!: HTMLDivElement;
	private cancelBtn!: ButtonComponent;
	private cancelRequested = false;
	private budget: number;

	constructor(
		app: App,
		private total: number,
		budget: number,
	) {
		super(app);
		this.budget = budget;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("citation-graph-progress-modal");

		contentEl.createEl("h3", { text: "Generating Summaries" });

		// Progress bar
		const barOuter = contentEl.createDiv({ cls: "cg-progress-bar" });
		this.progressFillEl = barOuter.createDiv({ cls: "cg-progress-fill" });

		// Status line
		this.statusEl = contentEl.createDiv({ cls: "cg-progress-status" });
		this.statusEl.setText(`0/${this.total}: Starting...`);

		// Token counter
		this.tokensEl = contentEl.createDiv({ cls: "cg-progress-tokens" });
		this.updateTokensDisplay(0);

		// Scrollable log
		this.logEl = contentEl.createDiv({ cls: "cg-progress-log" });

		// Footer with cancel button
		const footer = contentEl.createDiv({ cls: "citation-graph-footer" });
		this.cancelBtn = new ButtonComponent(footer);
		this.cancelBtn.setButtonText("Cancel").onClick(() => {
			this.cancelRequested = true;
			this.cancelBtn.setButtonText("Cancelling...");
			this.cancelBtn.setDisabled(true);
		});
	}

	/** Called before processing each paper to update the progress bar and status. */
	update(current: number, title: string, tokensSoFar: number): void {
		const pct = Math.round((current / this.total) * 100);
		this.progressFillEl.style.width = `${pct}%`;
		this.statusEl.setText(`${current}/${this.total}: ${title}`);
		this.updateTokensDisplay(tokensSoFar);
	}

	/** Log a completed or failed paper. */
	logItem(title: string, success: boolean): void {
		const item = this.logEl.createDiv({ cls: "cg-progress-item" });
		const badge = success ? "OK" : "FAIL";
		const cls = success ? "cg-status-ok" : "cg-status-fail";
		item.createSpan({ text: badge, cls });
		item.createSpan({ text: ` ${title}` });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	/** Check whether the user clicked Cancel. */
	get isCancelled(): boolean {
		return this.cancelRequested;
	}

	/** Show the final summary and switch Cancel to Close. */
	showComplete(completed: number, failed: number, tokens: number): void {
		this.progressFillEl.style.width = "100%";

		let msg = `Done: ${completed} succeeded`;
		if (failed > 0) msg += `, ${failed} failed`;
		if (this.cancelRequested) msg += " (cancelled)";
		msg += ".";
		this.statusEl.setText(msg);

		this.updateTokensDisplay(tokens);

		this.cancelBtn.setButtonText("Close");
		this.cancelBtn.setDisabled(false);
		this.cancelBtn.onClick(() => this.close());
	}

	private updateTokensDisplay(tokens: number): void {
		const formatted = tokens.toLocaleString();
		if (this.budget > 0) {
			this.tokensEl.setText(
				`Tokens used: ${formatted} / ${this.budget.toLocaleString()}`,
			);
		} else {
			this.tokensEl.setText(`Tokens used: ${formatted}`);
		}
	}
}
