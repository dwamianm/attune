import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Keep in step with DEFAULT_PORT in server/index.ts. */
const API_PORT = process.env.PORT?.trim() || "8791";

// The browser never talks to TypeSafe directly: Vite proxies /api to the
// playground's own server, which holds the key.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": `http://localhost:${API_PORT}` },
  },
});
