/** The welcome screen and header can start the same replayable walkthrough. */
export const GUIDE_START_EVENT = "floouid:guide-start";
export const GUIDE_STORAGE_KEY = "floouid:guide-completed";

export function startGuide(): void {
  window.dispatchEvent(new Event(GUIDE_START_EVENT));
}
