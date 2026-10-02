/**
 * The relayout timing and cues are in @attuneui/core (choreography.ts). This
 * file binds the two sentences that name panels to the demo's panel titles,
 * and gives the cue types the demo's panel ids.
 */
import * as Lib from "@attuneui/core";
import { panelTitle, type PanelId } from "../../shared/catalog.ts";
import type { LayoutPlan } from "../../shared/types.ts";

export type RoundCues = Lib.RoundCues<PanelId>;

/** The anchor note's sentence: "Added Inbox and Clients for Harbor Coffee Co.". */
export function noteText(panels: PanelId[], subject: string | undefined): string {
  return Lib.noteText(panels, subject, panelTitle);
}

/**
 * What a screen reader hears about the link after a round, next to the
 * change feed's decisions: the note's sentence when the round added linked
 * panels, then every linked panel. Empty when the plan links nothing.
 */
export function linkAnnouncement(plan: LayoutPlan): string {
  return Lib.linkAnnouncement(plan, panelTitle);
}
