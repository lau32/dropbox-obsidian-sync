import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/**", "test/**", "esbuild.config.mjs", "vitest.config.ts"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
