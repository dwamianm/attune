import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Keep in step with DEFAULT_PORT in server/env.ts. */
const DEFAULT_API_PORT = "8790";

/**
 * PORT exactly the way the server reads it: the shell first, then .env, and
 * no other file. Vite's loadEnv also reads .env.local and .env.[mode], which
 * the server never loads, so a PORT there moved the proxy but not the server.
 */
function apiPort(): string {
  const fromShell = process.env.PORT?.trim();
  if (fromShell) return fromShell;
  const file = new URL("./.env", import.meta.url);
  if (!existsSync(file)) return DEFAULT_API_PORT;
  try {
    return parseEnv(readFileSync(file, "utf8")).PORT?.trim() || DEFAULT_API_PORT;
  } catch {
    return DEFAULT_API_PORT;
  }
}

// The browser never talks to TypeSafe directly. The API key stays in the
// Node server (server/index.ts); Vite proxies /api to it in development.
// Nothing here reaches the browser: only VITE_ variables are exposed to client code.
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        // React and motion change far less often than the app, so they get
        // their own long-cached chunks. With the inspector loaded lazily
        // (App.tsx), no chunk passes Vite's 500 kB warning.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](\.pnpm[\\/])?(react|react-dom|scheduler)[@\\/]/ },
            { name: "motion", test: /node_modules[\\/](\.pnpm[\\/])?(motion|motion-dom|motion-utils|framer-motion)[@\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${apiPort()}`,
    },
  },
}));
