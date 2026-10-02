/**
 * Focus aid 1, "Fade panels that do not matter now" (docs/focus-aids.md).
 *
 * The rule itself (low for QUIET_ROUNDS rounds, the band, the exemptions) is
 * in @attuneui/core (quiet.ts). This file holds the demo's part: which of its
 * events count as using a panel (isQuietTouch), and the rule bound to the
 * demo's panels and goals (CATALOG).
 */
import * as Lib from "@attuneui/core";
import { CATALOG, type GoalId, type PanelId } from "../../shared/catalog.ts";
import type { Judgments, SignalEvent, TrackInput } from "../../shared/types.ts";

/** What the rule remembers between rounds, for the demo's panels. */
export type QuietTrack = Lib.QuietTrack<PanelId>;

export function emptyQuietTrack(): QuietTrack {
  return Lib.emptyQuietTrack<PanelId>();
}

/** What exempts a panel from being quiet right now. The demo's touch rule (isQuietTouch) is filled in. */
export type QuietContext = Omit<Lib.QuietContext<PanelId, SignalEvent>, "isTouch">;

/** Count one applied Jev round over the demo's panels (countQuietRound in @attuneui/core). */
export function countQuietRound(track: QuietTrack, relevance: Judgments["relevance"] | undefined, version: number): QuietTrack {
  return Lib.countQuietRound(track, relevance, version, CATALOG.panelIds);
}

/**
 * A signal that means the user used the panel it names: anything but a
 * pointer rest, docking it, or moving keyboard focus onto it. Hover and
 * keyboard focus only bring a quiet panel back to full strength for as long
 * as they last; they do not change the layout.
 */
export function isQuietTouch(input: Pick<TrackInput, "type" | "panel" | "detail">): boolean {
  if (!input.panel) return false;
  if (input.type === "panel_dwell" || input.type === "panel_dismiss") return false;
  return !(input.type === "panel_focus" && input.detail?.via === "keyboard");
}

/** The quiet panels now (quietPanels in @attuneui/core), with the demo's touch rule. Canvas order. */
export function quietPanels(track: QuietTrack, ctx: QuietContext): PanelId[] {
  return Lib.quietPanels(track, { ...ctx, isTouch: isQuietTouch });
}

/** The "Why here?" reason of a quiet panel: "Not needed for Collecting payments right now". */
export function quietReason(goal: GoalId | null | undefined): string {
  return Lib.quietReason(CATALOG, goal);
}
