import { App, PluginSettingTab, Setting, AbstractInputSuggest, TFolder, TFile, Modal, Notice } from "obsidian";
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

/** Return "(from env: VAR_NAME)" if the setting is empty but the env var is set, else "". */
function envHint(settingValue: string, envVar: string): string {
  if (settingValue) return "";
  return process.env[envVar] ? ` (from env: ${envVar})` : "";
}

/** Autocomplete suggest for vault folder paths */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const lowerQuery = query.toLowerCase();
    const folders: TFolder[] = [];

    const walk = (folder: TFolder) => {
      if (folder.path.toLowerCase().includes(lowerQuery) || folder.path === "/") {
        folders.push(folder);
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };

    const root = this.app.vault.getRoot();
    walk(root);

    // Filter out root itself, sort alphabetically
    return folders
      .filter((f) => f.path !== "/")
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.trigger("input");
    this.close();
  }
}

export class CitationGraphSettingTab extends PluginSettingTab {
  plugin: CitationGraphPlugin;

  constructor(app: App, plugin: CitationGraphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();


    // --- Folders ---
    new Setting(containerEl)
      .setName("Collections folder")
      .setDesc("Root folder for collections. Each Zotero collection gets its own subdirectory containing both the canvas and literature notes. Leave empty to use the vault root.")
      .addText((text) => {
        new FolderSuggest(this.app, text.inputEl);
        text
          .setPlaceholder("collections (empty = vault root)")
          .setValue(this.plugin.settings.collectionsFolder)
          .onChange(async (value) => {
            // An empty value is meaningful: it means the vault root. Only the
            // separator characters are stripped, so "/" and "" agree.
            this.plugin.settings.collectionsFolder = value.trim().replace(/^\/+|\/+$/g, "");
            await this.plugin.saveSettings();
          });
      });

    // --- Zotero ---
    new Setting(containerEl).setName("Zotero").setHeading();

    new Setting(containerEl)
      .setName("Zotero API key")
      .setDesc(
        "Required for syncing papers to Zotero. Get one at zotero.org → Settings → Security → Applications" +
        envHint(this.plugin.settings.zoteroApiKey, "ZOTERO_API_KEY")
      )
      .addText((text) => {
        // Masked like every other credential field: these settings are read
        // aloud in screenshots and screen shares far more often than they are
        // typed, and a Zotero key grants full read/write to the library.
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter API key")
          .setValue(this.plugin.settings.zoteroApiKey)
          .onChange(async (value) => {
            this.plugin.settings.zoteroApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Zotero user ID")
      .setDesc("Numeric user ID shown at zotero.org → Settings → Security → Applications")
      .addText((text) =>
        text
          .setPlaceholder("12345678")
          .setValue(this.plugin.settings.zoteroUserId)
          .onChange(async (value) => {
            this.plugin.settings.zoteroUserId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Semantic Scholar ---
    new Setting(containerEl).setName("Semantic Scholar").setHeading();

    new Setting(containerEl)
      .setName("API key (optional)")
      .setDesc(
        "For higher rate limits (1000 req/min vs 100 req/5min). Get one at semanticscholar.org/product/api#api-key-form" +
        envHint(this.plugin.settings.semanticScholarApiKey, "SEMANTIC_SCHOLAR_API_KEY")
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Optional API key")
          .setValue(this.plugin.settings.semanticScholarApiKey)
          .onChange(async (value) => {
            this.plugin.settings.semanticScholarApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Reference cache")
      .setDesc(`${this.plugin.s2Cache.size} papers cached. Cached references are reused when expanding papers.`)
      .addButton((btn) =>
        btn.setButtonText("Clear cache").onClick(async () => {
          this.plugin.s2Cache.clear();
          await this.plugin.s2Cache.save();
          this.display(); // refresh to update count
          new (await import("obsidian")).Notice("Citation cache cleared.");
        })
      );

    // --- Supplementary Citation Sources ---
    new Setting(containerEl).setName("Supplementary citation sources").setHeading();

    containerEl.createEl("p", {
      text: "Query additional databases when expanding papers to find references that Semantic Scholar may miss.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("OpenAlex")
      .setDesc("Free academic database with broad citation coverage")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableOpenAlex)
          .onChange(async (value) => {
            this.plugin.settings.enableOpenAlex = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("CrossRef")
      .setDesc("Publisher metadata (references only, when deposited by publishers)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableCrossRef)
          .onChange(async (value) => {
            this.plugin.settings.enableCrossRef = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Email for polite access")
      .setDesc("Providing an email gives better rate limits on OpenAlex and CrossRef (recommended)")
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.openAlexEmail)
          .onChange(async (value) => {
            this.plugin.settings.openAlexEmail = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Canvas ---
    new Setting(containerEl).setName("Canvas").setHeading();

    new Setting(containerEl)
      .setName("Node width")
      .setDesc("Width of paper nodes on canvas (pixels)")
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.nodeWidth))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.nodeWidth = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Node height")
      .setDesc("Height of paper nodes on canvas (pixels)")
      .addText((text) =>
        text
          .setPlaceholder("200")
          .setValue(String(this.plugin.settings.nodeHeight))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.nodeHeight = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // --- Reading status colors ---
    new Setting(containerEl).setName("Reading status colors").setHeading();
    containerEl.createEl("p", {
      text:
        "Canvas node color for each reading status. Colors are reapplied whenever the " +
        "canvas is built, expanded, or a status changes.",
      cls: "setting-item-description",
    });

    // Status is read back off the node's colour, so two statuses sharing one
    // colour are genuinely indistinguishable on the canvas. Say so rather
    // than letting it look like a bug.
    const clashWarning = containerEl.createEl("p", {
      cls: "setting-item-description citation-graph-settings-warning",
    });
    const refreshClashWarning = () => {
      const used = new Map<string, string[]>();
      for (const { key, status } of STATUS_COLOR_SETTINGS) {
        const colour = parseStatusColor(this.plugin.settings[key]);
        if (!colour) continue;
        used.set(colour, [...(used.get(colour) ?? []), STATUS_LABELS[status]]);
      }
      const clashes = [...used.values()].filter((names) => names.length > 1);
      clashWarning.setText(
        clashes.length === 0
          ? ""
          : clashes
              .map((names) => `${names.join(" and ")} share a color and cannot be told apart on the canvas.`)
              .join(" ")
      );
    };

    for (const { key, status, desc } of STATUS_COLOR_SETTINGS) {
      const stored = parseStatusColor(this.plugin.settings[key]);
      // Remembered so toggling away from Custom and back does not lose the hex.
      let hex = isCustomColor(stored) ? stored : CUSTOM_COLOR_FALLBACK;

      const setting = new Setting(containerEl)
        .setName(STATUS_LABELS[status])
        .setDesc(desc);

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
            this.plugin.settings[key] = custom ? (hex as StatusColor) : (value as StatusColor);
            showHexField(custom);
            await this.plugin.saveSettings();
            refreshClashWarning();
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
            this.plugin.settings[key] = parsed as StatusColor;
            await this.plugin.saveSettings();
            refreshClashWarning();
          });
        if (isCustomColor(stored)) text.inputEl.setCssProps({ "--cg-swatch": stored });
      });

      showHexField(isCustomColor(stored));
    }

    refreshClashWarning();

    // --- LLM / Summarization ---
    new Setting(containerEl).setName("Summaries").setHeading();

    const providerLabels: Record<string, string> = {
      "claude-cli": "Claude CLI (local)",
      anthropic: "Anthropic API",
      openai: "OpenAI API",
      google: "Google Gemini API",
    };

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which LLM service to use for paper summaries")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(providerLabels)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.plugin.settings.llmProvider)
          .onChange(async (value) => {
            this.plugin.settings.llmProvider = value as typeof this.plugin.settings.llmProvider;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.llmProvider === "claude-cli") {
      new Setting(containerEl)
        .setName("Claude CLI path")
        .setDesc(
          "Leave blank to auto-detect: the plugin will first check ~/.local/bin/claude " +
          "(the official installer's location), then fall back to 'claude' on Obsidian's PATH. " +
          "Set an absolute path here only if auto-detection fails or you want to override it."
        )
        .addText((text) =>
          text
            .setPlaceholder("claude")
            .setValue(this.plugin.settings.claudeCliPath)
            .onChange(async (value) => {
              this.plugin.settings.claudeCliPath = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.llmProvider !== "claude-cli") {
      new Setting(containerEl)
        .setName("API key")
        .setDesc(
          `API key for ${providerLabels[this.plugin.settings.llmProvider] ?? "the selected provider"}` +
          envHint(
            this.plugin.settings.llmApiKey,
            LLM_PROVIDER_ENV_VAR[this.plugin.settings.llmProvider] ?? ""
          )
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.llmApiKey)
            .onChange(async (value) => {
              this.plugin.settings.llmApiKey = value.trim();
              await this.plugin.saveSettings();
            });
        });
    }

    // Shown for every provider, Claude CLI included: the CLI takes a --model
    // flag too, and hiding the field there while still reading the value would
    // silently carry a stale model name over from a previously selected
    // provider.
    const defaultModel = defaultModelForProvider(this.plugin.settings.llmProvider);
    new Setting(containerEl)
      .setName("Model")
      .setDesc(`Model name (leave empty for default: ${defaultModel})`)
      .addText((text) =>
        text
          .setPlaceholder(defaultModel)
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc("Maximum tokens per summary response (controls length and cost)")
      .addText((text) =>
        text
          .setPlaceholder("1024")
          .setValue(String(this.plugin.settings.llmMaxOutputTokens))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.llmMaxOutputTokens = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Batch token budget")
      .setDesc("Stop batch summarization after this many total tokens (0 = unlimited). Not tracked with Claude CLI.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.llmBatchTokenBudget))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.llmBatchTokenBudget = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Summary prompt")
      .setDesc(
        "Custom prompt for the Write Summary command. Leave blank to use the built-in default. " +
        "Supports placeholders: {title}, {authors}, {year}. The PDF is attached automatically."
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Leave blank to use the built-in default prompt.")
          .setValue(this.plugin.settings.summaryPrompt)
          .onChange(async (value) => {
            this.plugin.settings.summaryPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 8;
        text.inputEl.addClass("citation-graph-prompt-input");
      });

    // --- Recommendations ---
    new Setting(containerEl).setName("Recommendations").setHeading();

    new Setting(containerEl)
      .setName("Papers to suggest")
      .setDesc(
        "How many papers the Recommend papers command asks for per run (1 to 50). " +
        "Each suggestion costs one Semantic Scholar request to verify, so a large number means a long wait."
      )
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.recommendCount))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0 && n <= 50) {
              this.plugin.settings.recommendCount = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Search the web")
      .setDesc(
        "Let the model search the web while recommending, instead of relying on its training data alone. " +
        "Supported by the Anthropic API, Google Gemini and the Claude CLI; the OpenAI endpoint this plugin uses has no search tool. " +
        "Searching costs extra input tokens."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.recommendWebSearch)
          .onChange(async (value) => {
            this.plugin.settings.recommendWebSearch = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc(
        "Maximum tokens per recommendation response. A list of ten papers with reasons needs more room than a summary, " +
        "and a truncated reply cannot be read back."
      )
      .addText((text) =>
        text
          .setPlaceholder("4096")
          .setValue(String(this.plugin.settings.recommendMaxOutputTokens))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.recommendMaxOutputTokens = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Recommendation prompt")
      .setDesc(
        "Standing instructions for the Recommend papers command. Leave blank to use the built-in default, " +
        "and note that the command's own prompt box overrides this for a single run. " +
        "The canvas paper list and the required JSON reply format are always appended, so a custom prompt cannot break the answer."
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Leave blank to use the built-in default prompt.")
          .setValue(this.plugin.settings.recommendPrompt)
          .onChange(async (value) => {
            this.plugin.settings.recommendPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 8;
        text.inputEl.addClass("citation-graph-prompt-input");
      });

    // --- Download ---
    new Setting(containerEl).setName("Download").setHeading();

    new Setting(containerEl)
      .setName("Default download path")
      .setDesc("Fallback filesystem path to look for paper PDFs (used by Write Summary if the canvas download path has no match)")
      .addText((text) =>
        text
          .setPlaceholder("/home/user/papers")
          .setValue(this.plugin.settings.defaultDownloadPath)
          .onChange(async (value) => {
            this.plugin.settings.defaultDownloadPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Banned Papers ---
    new Setting(containerEl).setName("Banned papers").setHeading();

    new Setting(containerEl)
      .setName("Manage banned papers")
      .setDesc("Review and remove papers marked as uninteresting from a specific canvas")
      .addButton((btn) =>
        btn.setButtonText("Open manager").onClick(async () => {
          // Find all citation graph canvases
          const canvasFiles = this.app.vault
            .getFiles()
            .filter((f) => f.extension === "canvas");

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
        })
      );
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
      dropdown.addOption("", "— Select canvas —");
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
      removeBtn.addEventListener("click", async () => {
        await this.removeBannedPaper(paper.id);
        this.renderList();
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
