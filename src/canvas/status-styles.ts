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
 * What is generated here is only the *mapping*: each rule assigns the custom
 * properties `styles.css` reads (the label, the frame width and style, the
 * dimming). Every visual constant stays in `styles.css`, where a theme or a
 * snippet can override it; JavaScript contributes nothing but the user's own
 * configuration, because only the user knows which colour means which status.
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

    const declarations = [`--cg-status-label: "${STATUS_LABELS[status]}";`];
    // A thicker frame than the baseline, so a paper you have actually engaged
    // with reads as distinct from an untouched one even before the colour
    // registers. "To read" keeps the baseline: it has no configured colour, so
    // it never reaches this loop.
    declarations.push("--cg-frame-width: var(--cg-frame-width-active);");
    if (status === "abandoned") {
      declarations.push("--cg-frame-style: dashed;");
      declarations.push("--cg-dim: var(--cg-dim-abandoned);");
    }

    const body =
      `${paper} .canvas-node-container {\n` +
      declarations.map((line) => `    ${line}`).join("\n") +
      `\n}`;

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
