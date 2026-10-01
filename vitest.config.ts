import { defineConfig } from "vitest/config";

// `pnpm test` at the root runs every package and app that has a vitest config.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
  },
});
