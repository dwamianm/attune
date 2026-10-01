/**
 * The three canvas layouts. The library owns these, not the app: the layout
 * policy treats each one differently, so an app cannot add or remove one.
 * The descriptions are sent to the model as the options of the layout
 * question.
 */
export const LAYOUT_MODES = ["focus", "compare", "overview"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const LAYOUT_MODE_DEFS: Record<LayoutMode, { label: string; description: string }> = {
  focus: {
    label: "Focus",
    description:
      "The user is working deeply on one thing. Show one large panel with a few small helpers.",
  },
  compare: {
    label: "Compare",
    description:
      "The user is moving back and forth between two related things. Show two large panels side by side.",
  },
  overview: {
    label: "Overview",
    description:
      "The user is scanning or switching between many areas. Show many medium panels at once.",
  },
};
