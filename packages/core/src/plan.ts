/**
 * The layout plan: what the policy produces from the judgments, and what
 * the canvas shows. Generic over the app's panel ids (P), its suggestion
 * type (S, which extends CoreSuggestion), and its record kinds (K).
 *
 * The anchored relayout fields (anchor, changeSummary, round, grid) are
 * optional, so a plan built without them stays valid (the canvas then falls
 * back to the CSS dense flow).
 */
import type { ChangeSummary, GridCell, GridColumns, PanelSize } from "./grid.ts";
import type { LayoutMode } from "./layoutModes.ts";
import type { Decision, Density, HelpLevel } from "./policy.ts";

/**
 * The panel the user just worked in, and the record or client that work was
 * about. During the relayout that follows, a "work" anchor's top-left stays
 * still on screen and everything else moves around it.
 */
export interface AnchorRef<P extends string = string, K extends string = string> {
  panel: P;
  itemKind?: K;
  itemId?: string;
  /** The customer or company the work was about, when there is one. */
  client?: string;
  /** Short name for tags, for example "INV-1042", "Priya Nair", or "Harbor Coffee Co.". */
  label?: string;
  /** Epoch ms when this anchor was set. Also its identity: new work makes a new anchor. */
  at: number;
  /**
   * "work" (or absent): a click or keystroke inside the panel; its top-left is held.
   * "command": the panel the command bar asked for; it still goes to the front
   * as the hero, and gets the same link color, lines, and tags.
   */
  source?: "work" | "command";
}

/** One record in another panel that code joined to the anchor (no model call). */
export interface RelatedRecord<K extends string = string> {
  itemKind: K;
  /** The same id the row carries in its item id attribute, for example "m-1" or "c-harbor". */
  itemId: string;
  /** Readable name, for example "Priya Nair: Re: Invoice INV-1042". */
  label: string;
}

/** Why a panel is linked to the anchor. Set on at most LINKED_PANELS_MAX placements. */
export interface PanelRelation<P extends string = string, K extends string = string> {
  anchorPanel: P;
  /** Header tag, for example "Linked to INV-1042" (the client name when the anchor has no record). */
  tag: string;
  /** Hover and focus text, for example "2 messages from Harbor Coffee Co.". */
  reason: string;
  /** Linked records in this panel, most useful first, never empty. The UI tints the ones it shows. */
  records: RelatedRecord<K>[];
}

/** Explicit cells for every placement, packed for one column count. */
export interface PlanGrid<P extends string = string> {
  columns: GridColumns;
  cells: Partial<Record<P, GridCell>>;
  /** Rows in use (largest row + h), so the canvas can reserve its height. */
  rows: number;
  /** True when this round kept the anchor's top-left (a work anchor that was already on the canvas). */
  anchored: boolean;
}

export interface PanelPlacement<P extends string = string, K extends string = string> {
  id: P;
  size: PanelSize;
  /** Final blended priority, 0..1 (plus pin boost). */
  priority: number;
  pinned: boolean;
  /** Why the panel is here and this big, in one short sentence. */
  reason: string;
  /** Set on the plan that changed this panel, cleared on the next plan. */
  change: "promoted" | "demoted" | "added" | null;
  /** How the priority was built, for an inspector. Each part is already weighted. */
  breakdown?: {
    relevance: number;
    usage: number;
    goal: number;
    pin: number;
    /** The weighted habit part. Present only in a round that used a habit. */
    habit?: number;
  };
  /** Epoch ms when the policy brought this panel onto the canvas, for the minimum stay. */
  addedAt?: number;
  /** True on the anchor's placement (the panel just worked in, or a command's hero). */
  anchor?: boolean;
  /** Set when this panel holds records linked to the plan's anchor. */
  relation?: PanelRelation<P, K>;
  /**
   * True when the user made this panel bigger ("Make bigger"). It stays at
   * hero size until the user makes it smaller or docks it; the policy never
   * shrinks or docks it. Absent: the policy decides its size.
   */
  bigger?: boolean;
  /**
   * True when the quiet rule (quiet.ts) judged this panel quiet: the UI shows
   * it faded, and `reason` says why. Absent: a normal panel.
   */
  quiet?: boolean;
  /** Set only when being quiet made the panel smaller: the size it had before, which it goes back to when the user clicks into it. */
  unquietSize?: PanelSize;
}

/** The fields every suggestion has. An app's suggestion type adds the record it acts on and its own marks. */
export interface CoreSuggestion<A extends string = string> {
  actionId: A;
  label: string;
  prominence: "primary" | "subtle";
  confidence: number;
  reason: string;
}

export interface LayoutPlan<P extends string = string, S extends CoreSuggestion = CoreSuggestion, K extends string = string> {
  mode: LayoutMode;
  /** Panels on the canvas, in display order. */
  placements: PanelPlacement<P, K>[];
  /** Panels available in the dock (not on the canvas). */
  docked: P[];
  density: Density;
  suggestions: S[];
  help: HelpLevel;
  /** What changed versus the previous plan, and why. */
  decisions: Decision<P>[];
  /** Version of the response this plan came from, 0 for the default plan. */
  basedOnVersion: number;
  /** Panel id -> epoch ms when the policy (not the user) moved it to the dock, for the minimum stay there. */
  autoDockedAt?: Partial<Record<P, number>>;
  /** The anchor this plan was built around. Absent or null: none. */
  anchor?: AnchorRef<P, K> | null;
  /** Cell changes versus the previous plan, for the staged choreography. Absent: nothing to stage. */
  changeSummary?: ChangeSummary<P>;
  /**
   * Increases by 1 whenever membership, a size, a cell, or anchor.at changes
   * (suggestion-only updates keep it). Absent means 0. The UI plays one
   * choreography per round and keys it on this number.
   */
  round?: number;
  /** Explicit cells from packGrid (grid.ts). Absent: the canvas falls back to the CSS dense flow. */
  grid?: PlanGrid<P>;
}
