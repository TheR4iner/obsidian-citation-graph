import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// The rules Obsidian's own automated review runs, so a failure shows up here
// rather than in the community directory's scan.
export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "docs/**", "project-kb/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    // The test shims stand in for browser and Obsidian globals that do not
    // exist under node, which is exactly what these two rules forbid.
    files: ["test/**"],
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-window-timers": "off",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.mjs", "*.config.mts"],
        },
      },
    },
  },
]);
