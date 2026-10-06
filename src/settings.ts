/// <reference types="node" />
import { App, PluginSettingTab, Setting, TFile, Modal, Notice } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { FolderSuggest } from "./folder-suggest";
import { parseCanvasData } from "./canvas/parse";
import type CitationGraphPlugin from "./main";
import type { BannedPaper, CitationGraphSettings, DisplayStatus, StatusColor } from "./types";
import { LLM_PROVIDER_ENV_VAR, STATUS_LABELS, isCustomColor, parseStatusColor } from "./types";

/** Dropdown value standing for "use the hex field below". */
const CUSTOM_COLOR = "custom";
/** Starting hex when switching a status to Custom with nothing entered yet. */
const CUSTOM_COLOR_FALLBACK = "#888888";

/** Obsidian's canvas preset colors, plus the uncolored default. */
const CANVAS_COLORS: Array<{ value: StatusColor; label: string }> = [
  { value: "", label: "No color (default)" },
  { value: "1", label: "Red" },
  { value: "2", label: "Orange" },
  { value: "3", label: "Yellow" },
  { value: "4", label: "Green" },
  { value: "5", label: "Cyan" },
  { value: "6", label: "Purple" },
];

/** Which setting holds each status color, and how to explain it. */
const STATUS_COLOR_SETTINGS: Array<{
  key: keyof Pick<
    CitationGraphSettings,
    "colorUnread" | "colorReading" | "colorRead" | "colorAnnotated" | "colorAbandoned"
  >;
  status: DisplayStatus;
  desc: string;
}> = [
  { key: "colorUnread", status: "unread", desc: "Papers you have not started yet" },
  { key: "colorReading", status: "reading", desc: "Papers you are part-way through" },
  { key: "colorRead", status: "read", desc: "Papers you finished but have not written up" },
  {
    key: "colorAnnotated",
    status: "annotated",
    desc: "Applied automatically once the note contains anything beyond the generated template",
  },
  {
    key: "colorAbandoned",
    status: "abandoned",
    desc: "Papers you started and decided not to finish. Also dimmed and given a dashed border",
  },
];
import { defaultModelForProvider } from "./api/llm";

/**
 * Settings whose value is a plain string, excluding the ones typed as a narrow
 * union (the status colours, the provider name). Those carry their own UI and
 * must not be writable through a generic text field.
 */
type PlainStringKey = {
  [K in keyof CitationGraphSettings]: string extends CitationGraphSettings[K] ? K : never;
}[keyof CitationGraphSettings];

type NumberSettingKey = {
  [K in keyof CitationGraphSettings]: number extends CitationGraphSettings[K] ? K : never;
}[keyof CitationGraphSettings];

type BooleanSettingKey = {
  [K in keyof CitationGraphSettings]: boolean extends CitationGraphSettings[K] ? K : never;
}[keyof CitationGraphSettings];

/** Return "(from env: VAR_NAME)" if the setting is empty but the env var is set, else "". */
function envHint(settingValue: string, envVar: string): string {
  if (settingValue) return "";
  return process.env[envVar] ? ` (from env: ${envVar})` : "";
}

/**
 * One row of the settings tab: what it is called, what it says, and how its
 * control is built onto the row Obsidian creates for it.
 */
interface SettingRow {
  name: string;
  desc?: string;
  /** False keeps a row that only exists to show a message out of search. */
  searchable?: boolean;
  build(setting: Setting): void;
}

interface SettingSection {
  heading?: string;
  rows: SettingRow[];
}

export class CitationGraphSettingTab extends PluginSettingTab {
  plugin: CitationGraphPlugin;
  /** The row that lists statuses sharing a colour; rebuilt with the tab. */
  private clashSetting: Setting | null = null;

  constructor(app: App, plugin: CitationGraphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * The whole tab, declared rather than drawn: Obsidian renders it and indexes
   * every row for its settings search.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map((section) => ({
      type: "group" as const,
      heading: section.heading,
      items: section.rows.map((row) => ({
        name: row.name,
        desc: row.desc,
        searchable: row.searchable,
        render: (setting: Setting) => row.build(setting),
      })),
    }));
  }

  /**
   * A text field bound to one string setting, stored trimmed.
   *
   * `key` is checked against the settings type, so a wrong name is a compile
   * error rather than a silently dead field.
   */
  private textRow(
    key: PlainStringKey,
    opts: { name: string; desc: string; placeholder: string; password?: boolean; folder?: boolean }
  ): SettingRow {
    return {
      name: opts.name,
      desc: opts.desc,
      build: (setting) => {
        setting.addText((text) => {
          // Credentials are read aloud in screenshots and screen shares far
          // more often than they are typed.
          if (opts.password) text.inputEl.type = "password";
          if (opts.folder) new FolderSuggest(this.app, text.inputEl);
          text
            .setPlaceholder(opts.placeholder)
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value.trim();
              await this.plugin.saveSettings();
            });
        });
      },
    };
  }

  /**
   * A text field bound to one whole-number setting.
   *
   * Input outside the accepted range is left in the box but not saved: the
   * user is usually mid-typing, and writing a partial number would apply a
   * value they never chose.
   */
  private numberRow(
    key: NumberSettingKey,
    opts: { name: string; desc: string; placeholder: string; min: number; max?: number }
  ): SettingRow {
    return {
      name: opts.name,
      desc: opts.desc,
      build: (setting) => {
        setting.addText((text) =>
          text
            .setPlaceholder(opts.placeholder)
            .setValue(String(this.plugin.settings[key]))
            .onChange(async (value) => {
              const n = parseInt(value, 10);
              if (isNaN(n) || n < opts.min) return;
              if (opts.max !== undefined && n > opts.max) return;
              this.plugin.settings[key] = n;
              await this.plugin.saveSettings();
            })
        );
      },
    };
  }

  /** A switch bound to one boolean setting. */
  private toggleRow(key: BooleanSettingKey, opts: { name: string; desc: string }): SettingRow {
    return {
      name: opts.name,
      desc: opts.desc,
      build: (setting) => {
        setting.addToggle((toggle) =>
          toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          })
        );
      },
    };
  }

  /**
   * A multi-line prompt field bound to one string setting, stored verbatim.
   *
   * Deliberately not trimmed: leading and trailing blank lines are part of a
   * prompt the user wrote.
   */
  private promptRow(key: PlainStringKey, opts: { name: string; desc: string }): SettingRow {
    return {
      name: opts.name,
      desc: opts.desc,
      build: (setting) => {
        setting.addTextArea((text) => {
          text
            .setPlaceholder("Leave blank to use the built-in default prompt.")
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 8;
          text.inputEl.addClass("citation-graph-prompt-input");
        });
      },
    };
  }

  /** A dropdown plus hex field for one reading status's canvas colour. */
  private statusColorRow({ key, status, desc }: (typeof STATUS_COLOR_SETTINGS)[number]): SettingRow {
    return {
      name: STATUS_LABELS[status],
      desc,
      build: (setting) => {
        const stored = parseStatusColor(this.plugin.settings[key]);
        // Remembered so toggling away from Custom and back does not lose the hex.
        let hex = isCustomColor(stored) ? stored : CUSTOM_COLOR_FALLBACK;

        let hexEl: HTMLElement | null = null;
        const showHexField = (visible: boolean) => {
          if (hexEl) hexEl.toggleClass("citation-graph-hidden", !visible);
        };

        setting.addDropdown((dropdown) => {
          for (const { value, label } of CANVAS_COLORS) {
            dropdown.addOption(value, label);
          }
          dropdown.addOption(CUSTOM_COLOR, "Custom hex...");
          dropdown
            .setValue(isCustomColor(stored) ? CUSTOM_COLOR : stored)
            .onChange(async (value) => {
              const custom = value === CUSTOM_COLOR;
              this.plugin.settings[key] = custom ? hex : (value as StatusColor);
              showHexField(custom);
              await this.plugin.saveSettings();
              this.refreshClashWarning();
            });
        });

        setting.addText((text) => {
          hexEl = text.inputEl;
          text.inputEl.addClass("citation-graph-hex-input");
          text.inputEl.setAttribute("spellcheck", "false");
          text
            .setPlaceholder("#rrggbb")
            .setValue(isCustomColor(stored) ? stored : "")
            .onChange(async (value) => {
              const parsed = parseStatusColor(value);
              // Only persist a complete, valid hex: the user is mid-typing
              // otherwise, and a partial value would blank the canvas color.
              const valid = isCustomColor(parsed);
              text.inputEl.toggleClass("is-invalid", value.trim() !== "" && !valid);
              if (!valid) return;
              hex = parsed;
              text.inputEl.setCssProps({ "--cg-swatch": parsed });
              this.plugin.settings[key] = parsed;
              await this.plugin.saveSettings();
              this.refreshClashWarning();
            });
          if (isCustomColor(stored)) text.inputEl.setCssProps({ "--cg-swatch": stored });
        });

        showHexField(isCustomColor(stored));
      },
    };
  }

  /**
   * Say which statuses share a colour, or hide the row when none do.
   *
   * Updated in place rather than by re-rendering the tab, which would take
   * focus away from a hex field the user is typing into.
   */
  private refreshClashWarning(): void {
    if (!this.clashSetting) return;
    const used = new Map<string, string[]>();
    for (const { key, status } of STATUS_COLOR_SETTINGS) {
      const colour = parseStatusColor(this.plugin.settings[key]);
      if (!colour) continue;
      used.set(colour, [...(used.get(colour) ?? []), STATUS_LABELS[status]]);
    }
    const text = [...used.values()]
      .filter((names) => names.length > 1)
      .map((names) => `${names.join(" and ")} share a color, so only their labels tell them apart.`)
      .join(" ");
    this.clashSetting.setDesc(text);
    this.clashSetting.settingEl.toggleClass("citation-graph-hidden", text === "");
  }

  private sections(): SettingSection[] {
    const settings = this.plugin.settings;
    const providerLabels: Record<string, string> = {
      "claude-cli": "Claude CLI (local)",
      anthropic: "Anthropic API",
      openai: "OpenAI API",
      google: "Google Gemini API",
    };
    const defaultModel = defaultModelForProvider(settings.llmProvider);

    return [
      {
        rows: [
          {
            name: "Collections folder",
            desc: "Root folder for collections. Each Zotero collection gets its own subdirectory containing both the canvas and literature notes. Leave empty to use the vault root.",
            build: (setting) => {
              setting.addText((text) => {
                new FolderSuggest(this.app, text.inputEl);
                text
                  .setPlaceholder("Collections (empty = vault root)")
                  .setValue(settings.collectionsFolder)
                  .onChange(async (value) => {
                    // An empty value is meaningful: it means the vault root. Only the
                    // separator characters are stripped, so "/" and "" agree.
                    settings.collectionsFolder = value.trim().replace(/^\/+|\/+$/g, "");
                    await this.plugin.saveSettings();
                  });
              });
            },
          },
        ],
      },
      {
        heading: "Zotero",
        rows: [
          this.textRow("zoteroApiKey", {
            name: "Zotero API key",
            desc:
              "Required for syncing papers to Zotero. Get one at zotero.org → Settings → Security → Applications" +
              envHint(settings.zoteroApiKey, "ZOTERO_API_KEY"),
            placeholder: "Enter API key",
            password: true,
          }),
          this.textRow("zoteroUserId", {
            name: "Zotero user ID",
            desc: "Numeric user ID shown at zotero.org → Settings → Security → Applications",
            placeholder: "12345678",
          }),
        ],
      },
      {
        heading: "Semantic Scholar",
        rows: [
          this.textRow("semanticScholarApiKey", {
            name: "API key (optional)",
            desc:
              "For higher rate limits (1000 req/min vs 100 req/5min). Get one at semanticscholar.org/product/api#api-key-form" +
              envHint(settings.semanticScholarApiKey, "SEMANTIC_SCHOLAR_API_KEY"),
            placeholder: "Optional API key",
            password: true,
          }),
          {
            name: "Reference cache",
            desc: `${this.plugin.s2Cache.size} papers cached. Cached references are reused when expanding papers.`,
            build: (setting) => {
              setting.addButton((btn) =>
                btn.setButtonText("Clear cache").onClick(async () => {
                  this.plugin.s2Cache.clear();
                  await this.plugin.s2Cache.save();
                  this.update(); // update the count
                  new Notice("Citation cache cleared.");
                })
              );
            },
          },
        ],
      },
      {
        heading: "Supplementary citation sources",
        rows: [
          this.toggleRow("enableOpenAlex", {
            name: "OpenAlex",
            desc: "Also query OpenAlex, a free academic database with broad citation coverage, when expanding papers, to find references Semantic Scholar may miss",
          }),
          this.toggleRow("enableCrossRef", {
            name: "CrossRef",
            desc: "Also query CrossRef's publisher metadata when expanding papers (references only, when deposited by publishers)",
          }),
          this.textRow("openAlexEmail", {
            name: "Email for polite access",
            desc: "Providing an email gives better rate limits on OpenAlex and CrossRef (recommended)",
            placeholder: "you@example.com",
          }),
        ],
      },
      {
        heading: "Canvas",
        rows: [
          this.numberRow("nodeWidth", {
            name: "Node width",
            desc: "Width of paper nodes on canvas (pixels)",
            placeholder: "300",
            min: 1,
          }),
          this.numberRow("nodeHeight", {
            name: "Node height",
            desc: "Height of paper nodes on canvas (pixels)",
            placeholder: "200",
            min: 1,
          }),
        ],
      },
      {
        heading: "Reading status colors",
        rows: [
          ...STATUS_COLOR_SETTINGS.map((entry, i) => {
            const row = this.statusColorRow(entry);
            // Said once, on the first row, instead of in a loose paragraph.
            if (i === 0) {
              row.desc = `${row.desc}. Colors are reapplied whenever the canvas is built, expanded, or a status changes`;
            }
            return row;
          }),
          {
            // Status is read back off the node's colour, so two statuses
            // sharing one colour are genuinely indistinguishable on the canvas.
            // Say so rather than letting it look like a bug.
            name: "Shared colors",
            searchable: false,
            build: (setting) => {
              setting.settingEl.addClass("citation-graph-settings-warning");
              this.clashSetting = setting;
              this.refreshClashWarning();
            },
          },
        ],
      },
      {
        heading: "Summaries",
        rows: [
          {
            name: "Provider",
            desc: "Which LLM service to use for paper summaries",
            build: (setting) => {
              setting.addDropdown((dropdown) => {
                for (const [value, label] of Object.entries(providerLabels)) {
                  dropdown.addOption(value, label);
                }
                dropdown.setValue(settings.llmProvider).onChange(async (value) => {
                  settings.llmProvider = value as typeof settings.llmProvider;
                  await this.plugin.saveSettings();
                  this.update();
                });
              });
            },
          },
          settings.llmProvider === "claude-cli"
            ? this.textRow("claudeCliPath", {
                name: "Claude CLI path",
                desc:
                  "Leave blank to auto-detect: the plugin will first check ~/.local/bin/claude " +
                  "(the official installer's location), then fall back to 'claude' on Obsidian's PATH. " +
                  "Set an absolute path here only if auto-detection fails or you want to override it.",
                placeholder: "claude",
              })
            : this.textRow("llmApiKey", {
                name: "API key",
                desc:
                  `API key for ${providerLabels[settings.llmProvider] ?? "the selected provider"}` +
                  envHint(settings.llmApiKey, LLM_PROVIDER_ENV_VAR[settings.llmProvider] ?? ""),
                placeholder: "sk-...",
                password: true,
              }),
          // Shown for every provider, Claude CLI included: the CLI takes a
          // --model flag too, and hiding the field there while still reading
          // the value would silently carry a stale model name over from a
          // previously selected provider.
          this.textRow("llmModel", {
            name: "Model",
            desc: `Model name (leave empty for default: ${defaultModel})`,
            placeholder: defaultModel,
          }),
          this.numberRow("llmMaxOutputTokens", {
            name: "Max output tokens",
            desc: "Maximum tokens per summary response (controls length and cost)",
            placeholder: "1024",
            min: 1,
          }),
          this.numberRow("llmBatchTokenBudget", {
            name: "Batch token budget",
            desc: "Stop batch summarization after this many total tokens (0 = unlimited). Not tracked with Claude CLI.",
            placeholder: "0",
            min: 0,
          }),
          this.promptRow("summaryPrompt", {
            name: "Summary prompt",
            desc:
              "Custom prompt for the Write Summary command. Leave blank to use the built-in default. " +
              "Supports placeholders: {title}, {authors}, {year}. The PDF is attached automatically.",
          }),
        ],
      },
      {
        heading: "Recommendations",
        rows: [
          this.numberRow("recommendCount", {
            name: "Papers to suggest",
            desc:
              "How many papers the Recommend papers command asks for per run (1 to 50). " +
              "Each suggestion costs one Semantic Scholar request to verify, so a large number means a long wait.",
            placeholder: "10",
            min: 1,
            max: 50,
          }),
          this.toggleRow("recommendWebSearch", {
            name: "Search the web",
            desc:
              "Let the model search the web while recommending, instead of relying on its training data alone. " +
              "Supported by the Anthropic API, Google Gemini and the Claude CLI; the OpenAI endpoint this plugin uses has no search tool. " +
              "Searching costs extra input tokens.",
          }),
          this.numberRow("recommendMaxOutputTokens", {
            name: "Max output tokens",
            desc:
              "Maximum tokens per recommendation response. A list of ten papers with reasons needs more room than a summary, " +
              "and a truncated reply cannot be read back.",
            placeholder: "4096",
            min: 1,
          }),
          this.promptRow("recommendPrompt", {
            name: "Recommendation prompt",
            desc:
              "Standing instructions for the Recommend papers command. Leave blank to use the built-in default, " +
              "and note that the command's own prompt box overrides this for a single run. " +
              "The canvas paper list and the required JSON reply format are always appended, so a custom prompt cannot break the answer.",
          }),
        ],
      },
      {
        heading: "Download",
        rows: [
          this.textRow("defaultDownloadPath", {
            name: "Default download folder",
            desc:
              "Vault folder where Write Summary looks for paper PDFs when the canvas's own download folder has no match, " +
              "and where it downloads missing ones. PDFs are kept in the vault so the plugin only touches vault files. " +
              "If the vault is a git repository and you do not want PDFs committed, add this folder to its .gitignore.",
            placeholder: "Papers/PDFs",
            folder: true,
          }),
        ],
      },
      {
        heading: "Banned papers",
        rows: [
          {
            name: "Manage banned papers",
            desc: "Review and remove papers marked as uninteresting from a specific canvas",
            build: (setting) => {
              setting.addButton((btn) =>
                btn.setButtonText("Open manager").onClick(() => void this.openBannedPapersManager())
              );
            },
          },
        ],
      },
    ];
  }

  private async openBannedPapersManager(): Promise<void> {
    // Find all citation graph canvases
    const canvasFiles = this.app.vault.getFiles().filter((f) => f.extension === "canvas");

    const cgCanvases: TFile[] = [];
    for (const file of canvasFiles) {
      try {
        const data = await readCanvasMeta(this.app, file);
        if (data.citationGraphMeta) cgCanvases.push(file);
      } catch {
        // A canvas that is not readable JSON is simply not one of ours.
      }
    }

    if (cgCanvases.length === 0) {
      new Notice("No citation graph canvases found.");
      return;
    }

    new BannedPapersManagerModal(this.app, cgCanvases).open();
  }
}

/**
 * Modal for reviewing and removing banned papers from a canvas.
 * Shows a canvas picker, then a searchable list with remove buttons.
 */
class BannedPapersManagerModal extends Modal {
  private selectedCanvas: TFile | null = null;
  private bannedPapers: BannedPaper[] = [];
  private searchQuery = "";

  constructor(app: App, private canvasFiles: TFile[]) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("citation-graph-banned-modal");

    this.setTitle("Banned papers");

    // Canvas selector
    const selectorRow = new Setting(contentEl)
      .setName("Canvas")
      .setDesc("Select a citation graph canvas");

    selectorRow.addDropdown((dropdown) => {
      dropdown.addOption("", "Select a canvas");
      for (const file of this.canvasFiles) {
        dropdown.addOption(file.path, file.basename);
      }
      dropdown.onChange(async (value) => {
        const file = this.canvasFiles.find((f) => f.path === value);
        if (file) {
          this.selectedCanvas = file;
          await this.loadBannedPapers();
          this.renderList();
        }
      });
    });

    // Search
    const searchRow = contentEl.createDiv("citation-graph-banned-search");
    const searchInput = searchRow.createEl("input", {
      type: "text",
      placeholder: "Search banned papers...",
      cls: "citation-graph-banned-search-input",
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.toLowerCase();
      this.renderList();
    });

    // List container
    contentEl.createDiv("citation-graph-banned-list");

    // Footer with count
    contentEl.createDiv("citation-graph-banned-footer");
  }

  private async loadBannedPapers(): Promise<void> {
    if (!this.selectedCanvas) return;
    try {
      const data = await readCanvasMeta(this.app, this.selectedCanvas);
      this.bannedPapers = data.citationGraphMeta?.bannedPapers ?? [];
    } catch (e) {
      console.error("Citation Graph: could not read banned papers", e);
      this.bannedPapers = [];
      new Notice("Could not read this canvas. Its banned papers are not shown.");
    }
  }

  /**
   * Drop one paper from the ban list.
   *
   * The removal is replayed against the canvas as it stands rather than a
   * whole list written back over it, so a ban added from a command while this
   * modal was open is not undone by the next click here.
   */
  private async removeBannedPaper(id: string): Promise<void> {
    const canvas = this.selectedCanvas;
    if (!canvas) return;
    try {
      await this.app.vault.process(canvas, (raw) => {
        const data = parseCanvasData<CanvasMetaHolder>(raw, canvas.path);
        const meta = (data.citationGraphMeta ??= {});
        meta.bannedPapers = (meta.bannedPapers ?? []).filter((p) => p.id !== id);
        return JSON.stringify(data, null, 2);
      });
      await this.loadBannedPapers();
    } catch (e) {
      console.error("Citation Graph: could not save banned papers", e);
      new Notice("Could not update this canvas. The paper is still banned.");
    }
  }

  private renderList(): void {
    const listEl = this.contentEl.querySelector(".citation-graph-banned-list");
    const footerEl = this.contentEl.querySelector(".citation-graph-banned-footer");
    if (!listEl || !footerEl) return;

    listEl.empty();
    (footerEl as HTMLElement).empty();

    if (!this.selectedCanvas) {
      (listEl as HTMLElement).createDiv({
        text: "Select a canvas above to view banned papers.",
        cls: "citation-graph-banned-empty",
      });
      return;
    }

    const filtered = this.searchQuery
      ? this.bannedPapers.filter((p) =>
          p.title.toLowerCase().includes(this.searchQuery)
        )
      : this.bannedPapers;

    if (this.bannedPapers.length === 0) {
      (listEl as HTMLElement).createDiv({
        text: "No banned papers for this canvas.",
        cls: "citation-graph-banned-empty",
      });
      return;
    }

    (footerEl as HTMLElement).setText(
      `${filtered.length} of ${this.bannedPapers.length} banned papers shown`
    );

    for (const paper of filtered) {
      const row = (listEl as HTMLElement).createDiv("citation-graph-banned-row");
      row.createSpan({ text: paper.title, cls: "citation-graph-banned-title" });
      row.createSpan({
        text: paper.id,
        cls: "citation-graph-banned-id",
      });
      const removeBtn = row.createEl("button", {
        text: "Remove",
        cls: "citation-graph-banned-remove",
      });
      removeBtn.addEventListener("click", () => {
        void this.removeBannedPaper(paper.id).then(() => this.renderList());
      });
    }
  }
}

/** The plugin's own block inside a .canvas file, as this tab reads it. */
interface CanvasMetaHolder {
  citationGraphMeta?: { bannedPapers?: BannedPaper[] };
}

/**
 * Read a canvas's plugin metadata. Goes through `parseCanvasData` so a
 * brand-new (zero-byte) canvas reads as an empty one rather than throwing.
 */
async function readCanvasMeta(app: App, file: TFile): Promise<CanvasMetaHolder> {
  return parseCanvasData<CanvasMetaHolder>(await app.vault.read(file), file.path);
}
