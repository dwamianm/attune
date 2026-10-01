/**
 * Check the body of an adapt request before anything reaches the model:
 * a version, the words-only snapshot, and an optional command. Long text is
 * clipped, not rejected, so a long paste still gets an answer. An app with
 * its own request fields checks those itself (the demo: apps/demo/server/validate.ts).
 */

/** Longest command the server reads. The command bar should cap input at this too. */
export const COMMAND_MAX_LENGTH = 300;
/** Most activity lines, panels, and observations read from a snapshot. */
export const SNAPSHOT_LIST_MAX = 20;
/** Longest single line read from a snapshot. */
export const SNAPSHOT_LINE_MAX = 500;

export interface ParsedAdaptRequest {
  version: number;
  snapshot: { recent_activity: string[]; current_focus: string | null; visible_panels: string[]; behavior_observations: string[] };
  command?: string;
}

function lines(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`snapshot.${field} must be a list of strings`);
  if (!value.every((v) => typeof v === "string")) throw new Error(`snapshot.${field} must be a list of strings`);
  return value.slice(-SNAPSHOT_LIST_MAX).map((v) => v.slice(0, SNAPSHOT_LINE_MAX));
}

/** The request, cleaned, or the first problem in words (for a 400 answer). */
export function parseAdaptRequest(body: unknown): { ok: true; request: ParsedAdaptRequest } | { ok: false; error: string } {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("The body must be a JSON object");
    const b = body as Record<string, unknown>;
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 0) throw new Error("version must be a whole number from 0");
    const s = b.snapshot;
    if (typeof s !== "object" || s === null || Array.isArray(s)) throw new Error("snapshot must be an object");
    const snap = s as Record<string, unknown>;
    const focus = snap.current_focus;
    if (focus !== null && typeof focus !== "string") throw new Error("snapshot.current_focus must be a string or null");
    const request: ParsedAdaptRequest = {
      version: b.version,
      snapshot: {
        recent_activity: lines(snap.recent_activity, "recent_activity"),
        current_focus: focus === null ? null : focus.slice(0, SNAPSHOT_LINE_MAX),
        visible_panels: lines(snap.visible_panels, "visible_panels"),
        behavior_observations: lines(snap.behavior_observations, "behavior_observations"),
      },
    };
    if (b.command !== undefined) {
      if (typeof b.command !== "string") throw new Error("command must be a string");
      const command = b.command.trim().slice(0, COMMAND_MAX_LENGTH);
      if (command) request.command = command;
    }
    return { ok: true, request };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid request" };
  }
}
