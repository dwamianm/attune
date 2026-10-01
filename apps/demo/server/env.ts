/**
 * Server configuration, read once at startup.
 *
 * The Jev API key lives only here and in the TypeSafe client. It is never
 * sent to the browser, never logged, and never copied into debug output.
 * Loading .env here (instead of relying on a CLI flag) means `tsx`, the eval
 * script, and tests all see the same configuration.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(ENV_FILE)) {
  try {
    // Does not override variables already set in the shell.
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.warn(`[env] could not read .env: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readPort(name: string, fallback: number): number {
  const raw = readString(name);
  const port = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

/**
 * Default API port. Not 8787: another local tool often holds 127.0.0.1:8787,
 * and then the Vite proxy could reach it instead of this server.
 */
export const DEFAULT_PORT = 8790;

export interface ServerConfig {
  /** Null when no key is configured. The server then answers with the heuristic. */
  readonly apiKey: string | null;
  readonly model: string;
  readonly port: number;
  /**
   * Interface to listen on. Loopback by default: the server spends the Jev key
   * on every request, so it must not be reachable from the local network.
   */
  readonly host: string;
}

export const config: ServerConfig = Object.freeze({
  apiKey: readString("JEV_API_KEY") ?? readString("TYPESAFE_API_KEY") ?? null,
  model: readString("JEV_MODEL") ?? "jev-latest",
  port: readPort("PORT", DEFAULT_PORT),
  host: readString("HOST") ?? "localhost",
});

export function hasJevKey(): boolean {
  return config.apiKey !== null;
}
