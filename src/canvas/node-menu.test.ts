import { describe, it, expect, vi } from "vitest";
import type { Menu, Plugin } from "obsidian";
import {
	canvasNodePath,
	canvasSelectionPaths,
	registerCanvasPaperMenu,
} from "./node-menu";
import type { CanvasMenuNode, CanvasPaperAction } from "./node-menu";

/** Collects the entries an action set adds, in order. */
function fakeMenu() {
	const items: { title: string; icon: string; click: () => void }[] = [];
	let separators = 0;
	const menu = {
		addSeparator() {
			separators++;
			return menu;
		},
		addItem(cb: (item: unknown) => unknown) {
			const entry = { title: "", icon: "", click: () => {} };
			const item = {
				setTitle(t: string) {
					entry.title = t;
					return item;
				},
				setIcon(i: string) {
					entry.icon = i;
					return item;
				},
				onClick(fn: () => void) {
					entry.click = fn;
					return item;
				},
			};
			cb(item);
			items.push(entry);
			return menu;
		},
	};
	return { menu, items, separatorCount: () => separators };
}

/** A plugin whose registered canvas listeners can be invoked by name. */
function fakePlugin() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const plugin = {
		registerEvent() {},
		app: {
			workspace: {
				on(name: string, cb: (...args: unknown[]) => unknown) {
					handlers.set(name, cb);
					return {};
				},
			},
		},
	};
	return { plugin: plugin as unknown as Plugin, handlers };
}

describe("canvasNodePath", () => {
	it("reads either path field Obsidian populates", () => {
		expect(canvasNodePath({ filePath: "Papers/One.md" })).toBe("Papers/One.md");
		expect(canvasNodePath({ file: { path: "Papers/Two.md" } })).toBe("Papers/Two.md");
	});

	// Canvases hold text cards, groups and embedded images too. Offering paper
	// actions on those would produce menu entries that can only fail.
	it("ignores nodes that are not notes", () => {
		expect(canvasNodePath({})).toBeNull();
		expect(canvasNodePath(null)).toBeNull();
		expect(canvasNodePath({ filePath: "Attachments/figure.png" })).toBeNull();
	});
});

describe("canvasSelectionPaths", () => {
	it("returns the note paths of a multi-node selection", () => {
		const selection = new Set<CanvasMenuNode>([
			{ filePath: "Papers/One.md" },
			{ filePath: "Attachments/figure.png" },
			{ file: { path: "Papers/Two.md" } },
		]);
		expect(canvasSelectionPaths({ selection })).toEqual(["Papers/One.md", "Papers/Two.md"]);
	});

	it("survives a canvas with no selection", () => {
		expect(canvasSelectionPaths({})).toEqual([]);
		expect(canvasSelectionPaths(null)).toEqual([]);
	});
});

describe("registerCanvasPaperMenu", () => {
	const actions = (run: (paths: string[]) => void): CanvasPaperAction[] => [
		{ title: "Expand", icon: "git-fork", singleOnly: true, run },
		{ title: (n) => (n === 1 ? "Delete paper" : `Delete ${n} papers`), icon: "trash-2", run },
	];

	it("passes the clicked node to the action rather than the selection", () => {
		const run = vi.fn();
		const { plugin, handlers } = fakePlugin();
		registerCanvasPaperMenu(plugin, () => true, actions(run));

		const { menu, items } = fakeMenu();
		handlers.get("canvas:node-menu")!(menu as unknown as Menu, { filePath: "Papers/One.md" });

		expect(items.map((i) => i.title)).toEqual(["Expand", "Delete paper"]);
		items[1].click();
		expect(run).toHaveBeenCalledWith(["Papers/One.md"]);
	});

	// The user's own notes live on the same canvas as the papers.
	it("adds nothing for a node that is not a paper note", () => {
		const { plugin, handlers } = fakePlugin();
		registerCanvasPaperMenu(plugin, () => false, actions(vi.fn()));

		const { menu, items, separatorCount } = fakeMenu();
		handlers.get("canvas:node-menu")!(menu as unknown as Menu, { filePath: "Ideas/Todo.md" });

		expect(items).toEqual([]);
		expect(separatorCount()).toBe(0);
	});

	it("drops single-paper actions and counts the rest for a multi-selection", () => {
		const run = vi.fn();
		const { plugin, handlers } = fakePlugin();
		registerCanvasPaperMenu(plugin, () => true, actions(run));

		const { menu, items } = fakeMenu();
		const selection = new Set<CanvasMenuNode>([
			{ filePath: "Papers/One.md" },
			{ filePath: "Papers/Two.md" },
		]);
		handlers.get("canvas:selection-menu")!(menu as unknown as Menu, { selection });

		expect(items.map((i) => i.title)).toEqual(["Delete 2 papers"]);
		items[0].click();
		expect(run).toHaveBeenCalledWith(["Papers/One.md", "Papers/Two.md"]);
	});
});
