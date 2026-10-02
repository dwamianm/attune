import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "playground",
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
    environment: "node",
  },
});
