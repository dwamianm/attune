/**
 * Maps the icon names in shared/catalog.ts to lucide-react components.
 * The map is explicit (no `import * as icons`) so the bundle only carries the
 * icons we use, and a renamed icon fails loudly at build time.
 */
import {
  Building2,
  CalendarDays,
  ChartColumn,
  Inbox,
  KanbanSquare,
  LifeBuoy,
  ListChecks,
  NotebookPen,
  Receipt,
  Square,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PANELS, type PanelId } from "../../shared/catalog.ts";

const ICONS: Record<string, LucideIcon> = {
  Inbox,
  CalendarDays,
  ListChecks,
  Receipt,
  Building2,
  KanbanSquare,
  ChartColumn,
  Users,
  NotebookPen,
  LifeBuoy,
};

export function panelIcon(id: PanelId): LucideIcon {
  return ICONS[PANELS[id].icon] ?? Square;
}
