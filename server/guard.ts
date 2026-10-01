/**
 * Request guards for the API server. Every /api/adapt call spends the Jev
 * key, so the server answers only the app on this machine:
 *   - the Host must be a loopback name (blocks DNS rebinding),
 *   - an Origin, when present, must be a loopback page (blocks other sites),
 *   - the body must be declared JSON (a cross-site "simple" POST cannot do
 *     that without a CORS preflight, which this server never approves),
 *   - and a small rate limit caps spend if something still gets through.
 *
 * The deployed copy (README, "Deploy to AWS") swaps the first two checks for
 * EdgeAccess below. The JSON check and the rate limit stay the same.
 *
 * Pure functions, so tests can check them without starting a server.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * The deployed copy runs as an AWS Lambda behind CloudFront, and CloudFront
 * asks for the site password before it forwards anything. There the Host is
 * the Lambda URL, never a loopback name, so two checks take the place of the
 * loopback ones:
 *   - the request must carry the secret header that only CloudFront adds,
 *     which proves it went through the password gate,
 *   - an Origin, when present, must be the site itself.
 * Only server/lambda.ts passes this. The local server never does.
 */
export interface EdgeAccess {
  /** The EDGE_SECRET_HEADER value CloudFront adds to every request it forwards. */
  readonly secret: string;
  /** The one page origin allowed to call, such as https://attuneui.com. */
  readonly origin: string;
}

/** The header CloudFront adds with EdgeAccess.secret (deploy/template.yaml). */
export const EDGE_SECRET_HEADER = "x-origin-verify";

function sameSecret(given: string | undefined | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The host name of a Host header or URL origin, lowercased, without the port. */
function hostName(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false;
  const name = hostName(hostHeader);
  return name !== null && LOOPBACK_HOSTS.has(name);
}

/**
 * Why a request is refused, as { status, error }, or null when it may pass.
 * `requireJson` is for bodies: GET /api/health has none. `edge` is for the
 * deployed copy only (EdgeAccess).
 */
export function checkRequest(
  headers: { host?: string | null; origin?: string | null; contentType?: string | null; edgeSecret?: string | null },
  opts: { requireJson: boolean; edge?: EdgeAccess },
): { status: 403 | 415; error: string } | null {
  if (opts.edge) {
    if (!sameSecret(headers.edgeSecret, opts.edge.secret)) return { status: 403, error: "Requests must come through the site." };
    if (headers.origin && headers.origin !== opts.edge.origin) return { status: 403, error: "Requests from other sites are not allowed." };
  } else {
    if (!isLoopbackHost(headers.host)) return { status: 403, error: "This server only answers on localhost." };
    // Any port: Vite may move to the next free port. The Host check above is what stops rebinding.
    // A sandboxed page or file sends the literal Origin "null".
    if (headers.origin && (headers.origin === "null" || !isLoopbackHost(headers.origin))) {
      return { status: 403, error: "Requests from other sites are not allowed." };
    }
  }
  if (opts.requireJson) {
    const type = (headers.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json." };
  }
  return null;
}

/**
 * The /api/prep limit (focus aid 4): a prep request goes out once per
 * meeting, again only when its records change, so 4 in any 2 s only ever
 * stops a loop. Its own window, so prep never takes an adapt round's turn.
 */
export const PREP_RATE_MAX = 4;
export const PREP_RATE_WINDOW_MS = 2_000;

/**
 * A fixed-window rate limiter. The app sends at most about one request a
 * second (one in flight, a 1 s gap, commands can replace a flight), so 8 in
 * any 2 s window only ever stops a loop, never a person.
 */
export function createRateLimiter(max = 8, windowMs = 2_000, now: () => number = () => Date.now()): () => boolean {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  return () => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    count += 1;
    return count <= max;
  };
}
