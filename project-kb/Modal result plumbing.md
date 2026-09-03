# Modal result plumbing

## Overview

Every picker in this plugin is opened by a command that then awaits one answer. That shape was hand-rolled in each modal, and this note records the shared version and the two traps it exists to avoid.

## Current solution

`src/modals/promise-modal.ts` holds `PromiseModal<T>`, an abstract `Modal` subclass. A subclass builds its UI in `onOpen`, calls `settle(value)` when the user commits, and implements `cancelledValue()` to say what dismissal means. `openAndWait()` opens the modal and returns the promise.

`src/modals/choice-modal.ts` builds on it with `askChoice(app, {title, question, items?, choices, cancelled})`, a data-driven yes/no/third-option dialog. A Cancel button is always appended and answers `cancelled`, so a caller never has to tell "closed the window" from "clicked Cancel".

Users: `PaperPickerModal` (and through it the Expand and Recommend pickers), `DownloadPickerModal`, `SendPickerModal`, `TagPickerModal`, `DoiInputModal`, and the three batch-summary dialogs that `askChoice` replaced.

## Two traps this encodes

**Settling twice.** Committing resolves the promise and then closes, and closing resolves it again with the cancelled value. A promise ignores its second settle, so the bug is silent and direction-dependent: the command acts on whichever answer arrived first, and the symptom is a picker that intermittently "cancels" after the user pressed Add. `PromiseModal` guards with a single `settled` flag that every path goes through.

**Closing from inside `onClose`.** The obvious `settle()` implementation resolves and then calls `close()`. Having `onClose()` call that same `settle()` re-enters `close()` from within a close handler. It happens to terminate, because the second entry hits the settled guard, but it depends on Obsidian's `close()` being re-entrant. The class splits the two instead: a private `answer()` resolves and nothing more, `settle()` is `answer()` plus `close()`, and `onClose()` calls `answer()` only.

A subclass with its own `onClose` cleanup must call `super.onClose()`; `DownloadPickerModal` (clearing its rescan timer) and `PaperPickerModal` (clearing the unfolded-abstract set) both do.

## What is deliberately not on it

`FuzzySuggestModal` subclasses: `CollectionPickerModal`, `StatusPickerModal`, and the inline paper picker in `main.ts`. Their lifecycle is genuinely different, because `onChooseItem` fires *after* `close()`, which is why they defer the null resolution behind a `window.setTimeout`. `PromiseModal` extends `Modal` and cannot be mixed into them without a mixin. `TagPickerModal` had copied that deferral even though it is a plain `Modal` with buttons; migrating it dropped a pointless 100ms delay on Cancel.

Three ad-hoc `new Modal(this.app)` dialogs in `main.ts` still monkey-patch `onOpen` rather than subclassing anything:

- the new-Zotero-collection name prompt in `syncToZotero`, which has a live duplicate-name warning and so is not a plain choice dialog;
- the delete confirmation in `deletePaper`, a title, a paragraph, a capped list of names and two buttons: `askChoice` in all but name;
- the relayout confirmation in `relayoutCanvas`, a title, a paragraph and two buttons: likewise.

The last two are the obvious next conversions. Note that the relayout one has no settle guard at all and is correct only because a promise ignores its second settle: its `onClick` resolves `true` and then closes, and the close handler resolves `false` into an already-settled promise. That is precisely the fragility `PromiseModal` exists to remove, and it is why these should not be left indefinitely.

## History

### 2026-09-01

Introduced during the over-engineering audit. Before it, seventy-eight lines of `resolvePromise` plumbing were spread across eight files, and the three `Batch*Modal` classes (171 lines) differed only in title, body list and button labels. Four unit tests in `promise-modal.test.ts` cover the settle-once semantics and assert that `close()` is called exactly once for a committed answer, which is the re-entrancy trap above. The `obsidian` test stub grew a real `open()`/`close()` lifecycle so those tests can drive it.
