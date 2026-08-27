import type { EventRef, Menu, MenuItem, Plugin } from "obsidian";

/**
 * The canvas context-menu events are not in Obsidian's published typings, so
 * the two used here are declared rather than reached through a cast. If a
 * future release renames them the listeners simply never fire, and every
 * action below is still reachable from the command palette.
 */
declare module "obsidian" {
  interface Workspace {
    on(
      name: "canvas:node-menu",
      callback: (menu: Menu, node: CanvasMenuNode) => unknown,
      ctx?: unknown
    ): EventRef;
    on(
      name: "canvas:selection-menu",
      callback: (menu: Menu, canvas: CanvasMenuCanvas) => unknown,
      ctx?: unknown
    ): EventRef;
  }
}

/**
 * The part of a live canvas node this file relies on. Obsidian's in-memory
 * node is a much larger object than the JSON `CanvasNode`, and which of the
 * two path fields is populated depends on the Obsidian version, so both are
 * read.
 */
export interface CanvasMenuNode {
  filePath?: string;
  file?: { path?: string } | null;
}

/** The part of a live canvas view this file relies on. */
export interface CanvasMenuCanvas {
  selection?: Set<CanvasMenuNode> | null;
}

/** One entry added to the canvas context menu. */
export interface CanvasPaperAction {
  /** Menu label, or a function of how many papers the click targets. */
  title: string | ((count: number) => string);
  /** Lucide icon ID. */
  icon: string;
  /** Hide the entry when more than one paper is selected. */
  singleOnly?: boolean;
  run: (paths: string[]) => void | Promise<void>;
}

/** The note path behind a canvas node, or null for anything but a note. */
export function canvasNodePath(node: CanvasMenuNode | null | undefined): string | null {
  const path = node?.filePath ?? node?.file?.path ?? null;
  return path && path.endsWith(".md") ? path : null;
}

/** The note paths behind every selected node, in selection order. */
export function canvasSelectionPaths(canvas: CanvasMenuCanvas | null | undefined): string[] {
  const selection = canvas?.selection;
  if (!selection) return [];
  const paths: string[] = [];
  for (const node of selection) {
    const path = canvasNodePath(node);
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Offer per-paper actions on right-click of a canvas node, in addition to the
 * command palette rather than instead of it. Nodes that are not paper notes
 * (the user's own notes on the same canvas) get no entries at all.
 */
export function registerCanvasPaperMenu(
  plugin: Plugin,
  isPaperNote: (path: string) => boolean,
  actions: CanvasPaperAction[]
): void {
  const addActions = (menu: Menu, paths: string[]): void => {
    const papers = paths.filter(isPaperNote);
    if (papers.length === 0) return;
    menu.addSeparator();
    for (const action of actions) {
      if (action.singleOnly && papers.length > 1) continue;
      const title =
        typeof action.title === "function" ? action.title(papers.length) : action.title;
      menu.addItem((item: MenuItem) =>
        item
          .setTitle(title)
          .setIcon(action.icon)
          .onClick(() => {
            void action.run(papers);
          })
      );
    }
  };

  plugin.registerEvent(
    plugin.app.workspace.on("canvas:node-menu", (menu, node) => {
      const path = canvasNodePath(node);
      if (path) addActions(menu, [path]);
    })
  );

  plugin.registerEvent(
    plugin.app.workspace.on("canvas:selection-menu", (menu, canvas) => {
      addActions(menu, canvasSelectionPaths(canvas));
    })
  );
}
