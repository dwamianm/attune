/** A small catalog that is not the demo's, for the tests: a writing app with two panels. */
import { defineCatalog, type Catalog, type GoalDef, type PanelDef } from "@attune/core";

export type P = "drafts" | "sources";
export type G = "write" | "research" | "unclear";
export type A = "cite_source" | "none";

const PANELS: Record<P, PanelDef<P>> = {
  drafts: { id: "drafts", title: "Drafts", description: "The user's documents in progress.", icon: "FileText", defaultVisible: true },
  sources: { id: "sources", title: "Sources", description: "Saved articles and notes to cite.", icon: "Library", defaultVisible: true },
};

const GOALS: Record<G, GoalDef> = {
  write: { label: "Writing", description: "Writing or editing a draft." },
  research: { label: "Researching", description: "Reading sources for a draft." },
  unclear: { label: "Not sure yet", description: "Too little activity to tell." },
};

export function writingCatalog(hints = false): Catalog<P, G, A> {
  return defineCatalog<P, G, A>({
    panelIds: ["drafts", "sources"],
    panels: hints
      ? { drafts: { ...PANELS.drafts, commandExamples: ["open my essay"] }, sources: { ...PANELS.sources, commandExamples: ["find the article on bees"] } }
      : PANELS,
    goalIds: ["write", "research", "unclear"],
    goals: hints
      ? {
          write: { ...GOALS.write, notFor: "Reading a source without writing." },
          research: { ...GOALS.research, notFor: "Editing a sentence in a draft." },
          unclear: { ...GOALS.unclear, notFor: "Activity that clearly fits writing or research." },
        }
      : GOALS,
    actionIds: ["cite_source", "none"],
    actions: {
      cite_source: { id: "cite_source", label: "Cite a source", description: "Add a citation to the open draft.", panel: "sources" },
      none: { id: "none", label: "", description: "No clear next step.", panel: null },
    },
    goalPanelAffinity: { write: { drafts: 1, sources: 0.4 }, research: { sources: 1, drafts: 0.5 }, unclear: {} },
  });
}
