import { Modal } from "obsidian";

/**
 * A modal that a command awaits for one answer.
 *
 * Every picker here is opened from a command that then needs the user's
 * choice, so each was carrying the same three-part plumbing: a stored
 * `resolve`, a `close()` that has to answer with a default when the user
 * dismisses the dialog, and a guard so committing and closing do not both
 * resolve. Getting the guard wrong is silent: the promise settles twice, the
 * second call is ignored by the runtime, and the command acts on whichever
 * answer happened to arrive first.
 *
 * Subclasses build their UI in `onOpen`, call `settle(value)` when the user
 * commits, and say in `cancelledValue()` what dismissal means. A subclass that
 * needs its own `onClose` cleanup must call `super.onClose()`.
 */
export abstract class PromiseModal<T> extends Modal {
  private settled = false;
  private resolvePromise: ((value: T) => void) | null = null;

  /** What the promise resolves to when the user dismisses the modal. */
  protected abstract cancelledValue(): T;

  /**
   * Answer with `value`, if nothing has answered yet. Deliberately does not
   * close: `onClose` calls this, and closing from inside a close handler would
   * re-enter it.
   */
  private answer(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise?.(value);
    this.resolvePromise = null;
  }

  /**
   * Answer with `value` and close. Only the first call counts, so the close
   * this triggers cannot overwrite the answer with the cancelled one.
   */
  protected settle(value: T): void {
    this.answer(value);
    this.close();
  }

  onClose(): void {
    this.answer(this.cancelledValue());
    this.contentEl.empty();
  }

  /** Open the modal and resolve once the user commits or dismisses it. */
  protected openAndWait(): Promise<T> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
