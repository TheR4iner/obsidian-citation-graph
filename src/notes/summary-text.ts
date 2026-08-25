/**
 * Placement of the generated `## Summary` section within a literature note.
 *
 * Pure string manipulation, kept out of main.ts so it can be exercised
 * without loading the plugin class (and with it every modal and API client).
 */

/**
 * The generated `## Summary` heading, matched as a whole line.
 *
 * Plain `indexOf("## Summary")` is not a substitute: it also matches one
 * character into "### Summary of results", and splicing from that offset
 * rewrites the wrong heading -- in "replace" mode deleting every line between
 * it and the real summary. Keeping detection and relocation on one constant
 * keeps them using the exact same rule.
 */
const SUMMARY_HEADING = /^## Summary[ \t\r]*$/m;
/** The `## Notes` heading, allowing user-appended text ("## Notes on method"). */
const NOTES_HEADING = /^## Notes\b.*$/m;

/** Offset of the first line matching `pattern`, or -1 when there is none. */
function lineIndexOf(content: string, pattern: RegExp): number {
  const match = pattern.exec(content);
  return match ? match.index : -1;
}

/** Whether a note already carries a generated summary section. */
export function hasSummarySection(noteContent: string): boolean {
  return SUMMARY_HEADING.test(noteContent);
}

/** Insert summary text into a note's content according to the given mode. */
export function insertSummaryText(
  noteContent: string,
  summaryText: string,
  mode: "new" | "append" | "replace",
): string {
  const appendNewSection = () =>
    noteContent.trimEnd() + "\n\n## Summary\n\n" + summaryText + "\n";

  if (mode === "new") {
    const notesIdx = lineIndexOf(noteContent, NOTES_HEADING);
    if (notesIdx === -1) return appendNewSection();
    return (
      noteContent.substring(0, notesIdx) +
      "## Summary\n\n" + summaryText + "\n\n" +
      noteContent.substring(notesIdx)
    );
  }

  const summaryStart = lineIndexOf(noteContent, SUMMARY_HEADING);
  // Callers only choose append/replace when hasSummarySection() was true, but
  // the note is re-read between that check and this call, so it may have been
  // edited away in the meantime. Degrade to appending rather than splicing at
  // offset -1, which would corrupt the note.
  if (summaryStart === -1) return appendNewSection();

  if (mode === "append") {
    const afterSummaryHeading = noteContent.indexOf("\n", summaryStart);
    const nextHeading = noteContent.indexOf("\n## ", afterSummaryHeading);
    const insertAt = nextHeading !== -1 ? nextHeading : noteContent.length;
    return (
      noteContent.substring(0, insertAt).trimEnd() +
      "\n\n---\n\n" + summaryText + "\n" +
      // +1 skips the newline nextHeading points at, which would otherwise
      // leave a second blank line before the heading. Matches "replace".
      (nextHeading !== -1 ? "\n" + noteContent.substring(nextHeading + 1) : "")
    );
  }

  // replace
  const nextHeading = noteContent.indexOf("\n## ", summaryStart + 1);
  return (
    noteContent.substring(0, summaryStart) +
    "## Summary\n\n" + summaryText + "\n" +
    (nextHeading !== -1 ? "\n" + noteContent.substring(nextHeading + 1) : "")
  );
}
