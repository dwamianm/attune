/** A small starting API; the full store and policy factories remain available for custom engines. */
import { createAdaptiveStore, type AdaptiveSpec, type AdaptiveStoreConfig } from "./adaptiveStore.ts";
import { createPolicy, type PolicyInput } from "./createPolicy.ts";
import type { AnchorRef, CoreSuggestion, RelatedRecord } from "./plan.ts";
import type { EventWords } from "./snapshot.ts";
import { basicRelation, basicSuggestions } from "./suggestions.ts";
import { eventWeight, panelUsage } from "./usage.ts";

export interface WorkspaceSpec<P extends string, G extends string, A extends string, K extends string = string> extends AdaptiveSpec {
  panel: P;
  goal: G;
  action: A;
  kind: K;
  policyExtra: undefined;
}

export type WorkspaceConfig<P extends string, G extends string, A extends string, K extends string = string> =
  Omit<AdaptiveStoreConfig<WorkspaceSpec<P, G, A, K>>, "policy" | "words" | "linked"> & {
    words?: Omit<EventWords<P>, "panels">;
    modelName?: string;
    linked?: (anchor: AnchorRef<P, K>) => Partial<Record<P, RelatedRecord<K>[]>> | undefined;
  };

/**
 * Infer the app's IDs from its catalog and supply the standard usage weights,
 * suggestions, link labels and policy. Works with any model or local `send`.
 * Use createAdaptiveStore directly when you need your own policy or state.
 */
export function createAdaptiveWorkspace<P extends string, G extends string, A extends string, K extends string = string>(
  config: WorkspaceConfig<P, G, A, K>,
) {
  const { catalog, words, modelName, ...rest } = config;
  const policy = createPolicy<P, G, A, CoreSuggestion<A>, K, { next: Partial<Record<P, number>> }, PolicyInput<P, G, A, CoreSuggestion<A>, K>>({
    catalog,
    usage: (events, now) => panelUsage(events, now, { panelIds: catalog.panelIds, weight: eventWeight }),
    suggest: ({ judgments }) => basicSuggestions(catalog, judgments),
    relationFor: (anchor, panel, records) => basicRelation(anchor, panel, records, catalog.panels),
    ...(modelName ? { modelName } : {}),
    ...(config.helpPanel ? { helpPanel: config.helpPanel } : {}),
  });
  return createAdaptiveStore<WorkspaceSpec<P, G, A, K>>({
    ...rest,
    catalog,
    policy,
    words: { itemWords: {}, ...words, panels: catalog.panels },
    settings: { density: "standard", ...rest.settings },
  });
}
