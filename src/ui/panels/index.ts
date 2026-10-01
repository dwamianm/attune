/**
 * Panel registry: one component per panel id. The canvas looks components up
 * here, so adding a panel means adding it to the catalog and to this map.
 */
import type { ComponentType } from "react";
import type { PanelId } from "../../../shared/catalog.ts";
import { CalendarPanel } from "./CalendarPanel.tsx";
import { ClientsPanel } from "./ClientsPanel.tsx";
import type { PanelProps } from "./common.tsx";
import { GuidePanel } from "./GuidePanel.tsx";
import { InboxPanel } from "./InboxPanel.tsx";
import { InvoicesPanel } from "./InvoicesPanel.tsx";
import { NotesPanel } from "./NotesPanel.tsx";
import { ProjectsPanel } from "./ProjectsPanel.tsx";
import { RevenuePanel } from "./RevenuePanel.tsx";
import { TasksPanel } from "./TasksPanel.tsx";
import { TeamPanel } from "./TeamPanel.tsx";

export type { PanelProps } from "./common.tsx";

export const PANEL_COMPONENTS: Record<PanelId, ComponentType<PanelProps>> = {
  inbox: InboxPanel,
  calendar: CalendarPanel,
  tasks: TasksPanel,
  invoices: InvoicesPanel,
  clients: ClientsPanel,
  projects: ProjectsPanel,
  analytics: RevenuePanel,
  team: TeamPanel,
  notes: NotesPanel,
  help: GuidePanel,
};
