import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `.mts` rather than `.ts`: the package is CommonJS, so Vite's native config
// loader would otherwise warn about ESM syntax in a file loaded as CJS.
const stub = fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url));

export default defineConfig({
	// `obsidian` ships types only: the real implementation is injected by the
	// Obsidian app at runtime, so anything importing it dies under node with
	// "Cannot find module 'obsidian'". esbuild.config.mjs marks it external
	// for the same reason; here it resolves to a minimal stub instead.
	resolve: {
		alias: { obsidian: stub },
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
