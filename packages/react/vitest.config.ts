import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "react",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
