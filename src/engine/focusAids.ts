/**
 * The settings home for the focus aids (docs/focus-aids.md): one on or off
 * flag per aid, its default, and the words the header popover and the
 * inspector's Controls tab show for it. The flags live in
 * EngineSettings.focusAids, the one source of truth, and are saved with the
 * other settings. Pure: no DOM, no store.
 *
 * To add an aid, add its flag to FocusAidSettings (./contract.ts), then its
 * default and its text here. Both maps are typed by the flag, so an aid with
 * no default or no text does not compile, and every list below picks it up.
 */
import type { PanelId } from "../../shared/catalog.ts";
import type { EngineSettings, FocusAidId, FocusAidSettings } from "./contract.ts";

/** Every aid starts on: each one only makes the next step easier, and each can be switched off. */
export const DEFAULT_FOCUS_AIDS: FocusAidSettings = {
  fadeQuiet: true,
  upNext: true,
  backTo: true,
  // The user asked for it: a panel they pin or make bigger goes to the front of the stack.
  moveToFront: true,
  taskDone: true,
  // The user asked for it: after a click, the linked panels gather next to it, the next step first.
  arrangeLinks: true,
  // Aid 3: habits stay in this browser, fade over weeks, and count only with enough evidence.
  habits: true,
  // Aid 4: only offers; Prepare changes the layout when the user presses it, and never acts or writes notes.
  meetingPrep: true,
};

export interface FocusAidText {
  /** The switch's name, also the setting_change signal's label. */
  label: string;
  /** One plain line under the switch. */
  description: string;
}

export const FOCUS_AID_TEXT: Record<FocusAidId, FocusAidText> = {
  fadeQuiet: {
    label: "Fade panels that do not matter now",
    description: "Panels you do not need right now fade and shrink. Hover to read one, click it to bring it back.",
  },
  upNext: {
    label: "Up next",
    description: "Offers the record you will likely work on next. Press n to open it.",
  },
  backTo: {
    label: "Back to",
    description: "Offers a way back to what you were doing before. Press b to go back.",
  },
  moveToFront: {
    label: "Move pinned and bigger panels to the front",
    description: "A panel you pin or make bigger goes to the top left, the newest first. Off: it stays where it is.",
  },
  taskDone: {
    label: "Say when a task is done",
    description: "Says when the work in front of you is finished and offers the next task. Press n to start it.",
  },
  arrangeLinks: {
    label: "Arrange linked panels by next step",
    description: "Linked panels move next to what you clicked, the next step first, and Attune offers that step. Off: the links only draw.",
  },
  habits: {
    label: "Learn my habits",
    description: "Attune learns where you usually go next and what you usually do, and uses it a little. It stays in this browser.",
  },
  meetingPrep: {
    label: "Prepare for meetings",
    description: "Before a meeting with a client, Attune offers to bring up what matters for it. Press p to prepare.",
  },
};

/** The aids in the order the switches show, the order they were built. */
export const FOCUS_AID_IDS: readonly FocusAidId[] = Object.keys(DEFAULT_FOCUS_AIDS) as FocusAidId[];

/**
 * The flags from a saved settings object: each one a saved boolean, else its
 * default. Anything else (an older save with no focus aids, a hand-edited
 * value, not an object at all) falls back flag by flag.
 */
export function readFocusAids(raw: unknown): FocusAidSettings {
  const saved = raw !== null && typeof raw === "object" ? (raw as Partial<Record<FocusAidId, unknown>>) : {};
  const out = { ...DEFAULT_FOCUS_AIDS };
  for (const id of FOCUS_AID_IDS) {
    const v = saved[id];
    if (typeof v === "boolean") out[id] = v;
  }
  return out;
}

/** The "Up next" card shows: Adaptive is on and the user did not switch the aid off. */
export function upNextOn(settings: Pick<EngineSettings, "adaptive" | "focusAids">): boolean {
  return settings.adaptive && settings.focusAids.upNext;
}

/** The "Back to" chips show and contexts are saved: Adaptive is on and the user did not switch the aid off. */
export function backToOn(settings: Pick<EngineSettings, "adaptive" | "focusAids">): boolean {
  return settings.adaptive && settings.focusAids.backTo;
}

/** Quiet panels fade and shrink: Adaptive is on and the user did not switch the aid off. */
export function fadeQuietOn(settings: Pick<EngineSettings, "adaptive" | "focusAids">): boolean {
  return settings.adaptive && settings.focusAids.fadeQuiet;
}

/**
 * Aid 2, "Say when a task is done": the working goal is sent to Jev, the
 * Done card shows, and n starts the next task. Adaptive is on and the user
 * did not switch the aid off. Like Back to, the working goal is followed
 * either way, so switching it on works at once.
 */
export function taskDoneOn(settings: Pick<EngineSettings, "adaptive" | "focusAids">): boolean {
  return settings.adaptive && settings.focusAids.taskDone;
}

/**
 * "Arrange linked panels by next step": linked panels gather next to the
 * clicked panel, the link questions are asked, and the next step is offered.
 * Adaptive is on and the user did not switch the aid off. (Freeze sets no
 * anchor, so nothing gathers while frozen either.)
 */
export function arrangeLinksOn(settings: Pick<EngineSettings, "adaptive" | "focusAids">): boolean {
  return settings.adaptive && settings.focusAids.arrangeLinks;
}

/**
 * Aid 3, "Learn my habits": the habits shape the layout, Up next, the next
 * task, a subtle suggestion, and the words Jev reads. Adaptive is on and the
 * user did not switch the aid off. Learning needs only the flag
 * (settings.focusAids.habits), so the fixed layout still teaches habits.
 */
export function habitsOn(settings: Pick<EngineSettings, "adaptive" | "focusAids">): boolean {
  return settings.adaptive && settings.focusAids.habits;
}

/**
 * Aid 4, "Prepare for meetings": the prep chip shows before a meeting, p
 * prepares, and /api/prep ranks the client's records. Adaptive is on and the
 * user did not switch the aid off.
 */
export function meetingPrepOn(settings: Pick<EngineSettings, "adaptive" | "focusAids">): boolean {
  return settings.adaptive && settings.focusAids.meetingPrep;
}

/**
 * A pin or "Make bigger" sends the panel to the front of the canvas: Adaptive
 * is on, the layout is not frozen (Freeze keeps every panel where it is, as
 * it does for a command), and the user did not pick "Keep in place".
 */
export function moveToFrontOn(settings: Pick<EngineSettings, "adaptive" | "frozen" | "focusAids">): boolean {
  return settings.adaptive && !settings.frozen && settings.focusAids.moveToFront;
}

/**
 * The front group: every panel the user pinned or made bigger, the most
 * recent pin or "Make bigger" first. `front` is the store's recency list
 * (EngineState.front); it may name panels no longer pinned or bigger, which
 * are skipped, and a pinned or bigger panel it does not name (a save from
 * before the setting) follows, pins first, in their own order.
 */
export function frontGroup(front: readonly PanelId[], pinned: readonly PanelId[], bigger: readonly PanelId[]): PanelId[] {
  const mine = new Set([...pinned, ...bigger]);
  return [...new Set([...front, ...pinned, ...bigger])].filter((id) => mine.has(id));
}
