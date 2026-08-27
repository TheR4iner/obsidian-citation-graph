import { Notice } from "obsidian";

/**
 * A notice that stays up for the length of a long operation, showing what is
 * happening now and how long it has been running.
 *
 * A static "working..." message is indistinguishable from a hang once a run
 * passes a few seconds, and a recommendation run with web search regularly
 * takes minutes. The elapsed clock is what tells the user the plugin is still
 * alive; the status line is what tells them why the wait is worth it.
 */
export class ProgressNotice {
  private notice: Notice;
  private timer: number | null = null;
  private readonly startedAt = Date.now();

  constructor(private status: string, private hint = "") {
    // Duration 0 keeps the notice up until hide() is called.
    this.notice = new Notice(this.render(), 0);
    this.timer = window.setInterval(() => this.notice.setMessage(this.render()), 1000);
  }

  /** Replace the activity line, keeping the clock running. */
  setStatus(status: string): void {
    this.status = status;
    this.notice.setMessage(this.render());
  }

  /** Replace the trailing hint, or clear it with an empty string. */
  setHint(hint: string): void {
    this.hint = hint;
    this.notice.setMessage(this.render());
  }

  hide(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.notice.hide();
  }

  private render(): string {
    const parts = [this.status, formatElapsed(Date.now() - this.startedAt)];
    if (this.hint) parts.push(this.hint);
    return parts.join(" · ");
  }
}

/** Elapsed time as m:ss, or h:mm:ss once it runs that long. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
