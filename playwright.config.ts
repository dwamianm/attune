import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5186",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Defaults to Playwright Chromium; optionally use an installed browser.
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "small-screen", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "reduced-motion", use: { viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" } },
  ],
  webServer: [
    {
      command: "pnpm --filter @attuneui/demo exec tsx server/index.ts",
      url: "http://localhost:8876/api/health",
      env: { JEV_API_KEY: "", TYPESAFE_API_KEY: "", PORT: "8876", HOST: "localhost" },
      reuseExistingServer: false,
    },
    {
      command: "pnpm --filter @attuneui/demo exec vite --host 127.0.0.1 --port 5186 --strictPort",
      url: "http://127.0.0.1:5186",
      env: { PORT: "8876" },
      reuseExistingServer: false,
    },
  ],
});
