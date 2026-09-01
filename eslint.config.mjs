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
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "*.config.mts"],
        },
      },
    },
  },
]);
