import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "demo",
    include: ["src/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
  },
});
