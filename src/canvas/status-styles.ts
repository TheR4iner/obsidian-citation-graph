import type { CitationGraphSettings } from "../types";
import { STATUS_LABELS, isCustomColor, statusColor } from "../types";

/**
 * Statuses that can carry a colour of their own. "unread" is absent because it
 * keeps the uncoloured default, which the static stylesheet already labels.
 */
const COLOURED_STATUSES = ["reading", "read", "annotated", "abandoned"] as const;

/** The paper-node selector for a node showing a given status colour. */
function paperSelector(colour: string): string {
  const cls = isCustomColor(colour) ? "mod-canvas-color-custom" : `mod-canvas-color-${colour}`;
  return `.canvas-node.${cls}:has(.citation-graph-note)`;
}

/**
 * Build the stylesheet that turns a canvas node's colour into its status.
 *
 * Generated at runtime rather than written into styles.css because the
 * colours are user-configurable.
 *
 * How a node advertises its colour depends on which kind it is, and only one
 * of the two kinds can be matched by value:
 *
 *   - A preset ("1".."6") becomes the class .mod-canvas-color-<n>. The preset
 *     ID itself never appears as a value anywhere: --canvas-color resolves
 *     through Obsidian's own --canvas-color-<n> to a theme hex, so a style
 *     query for the digit can never match. Presets must be matched by class.
 *   - A custom colour becomes the class .mod-canvas-color-custom plus an
 *     inline --canvas-color holding the hex, normalised by Obsidian to
 *     lowercase six-digit form (as parseStatusColor also stores it). Every
 *     custom colour shares that one class, so these are told apart by value,
 *     with a style query.
 */
export function statusStyleRules(settings: CitationGraphSettings): string {
  const rules: string[] = [];

  for (const status of COLOURED_STATUSES) {
    const colour = statusColor(settings, status);
    if (!colour) continue; // shares the uncoloured default; the base rule labels it
    const paper = paperSelector(colour);
    // A thicker frame than the 3px baseline, so a paper you have actually
    // engaged with reads as distinct from an untouched one even before the
    // colour registers. "To read" keeps the baseline: it has no configured
    // colour, so it never reaches this loop.
    const extra =
      `\n    border-width: 5px !important;` +
      (status === "abandoned"
        ? `\n    border-style: dashed !important;\n    opacity: 0.55;`
        : "");
    const body =
      `${paper} .canvas-node-container {\n` +
      `    --cg-status-label: "${STATUS_LABELS[status]}";${extra}\n` +
      `}` +
      // Abandoned papers are dimmed, so hovering one restores it to full
      // strength: the note has to stay readable when you go back to it.
      (status === "abandoned"
        ? `\n${paper}:hover .canvas-node-container { opacity: 1; }`
        : "");

    rules.push(
      isCustomColor(colour)
        ? `@container style(--canvas-color: ${colour}) {\n` +
            body
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n") +
            `\n}`
        : body
    );
  }

  return rules.join("\n\n");
}
