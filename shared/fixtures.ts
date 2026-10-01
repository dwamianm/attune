/**
 * Mock data for "Fernhill Studio", a fictional six-person design studio.
 * All names and companies are invented. Dates are relative to the moment the
 * module loads, so the demo always has something due today and overdue.
 *
 * The UI renders this data; the engine uses client names as Jev candidates
 * and looks up invoices when it fills in suggestion arguments.
 */

const DAY = 24 * 60 * 60 * 1000;
const today = new Date();
today.setHours(0, 0, 0, 0);

/** ISO date (YYYY-MM-DD) `n` days from today. Negative is the past. */
export function daysFromToday(n: number): string {
  const d = new Date(today.getTime() + n * DAY);
  return d.toISOString().slice(0, 10);
}

/** Today at hh:mm, as an ISO timestamp. */
function todayAt(hh: number, mm = 0): string {
  const d = new Date(today);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

export const STUDIO_NAME = "Fernhill Studio";
export const CURRENT_USER = { name: "Sam Rivera", role: "Studio lead" };

export interface Client {
  id: string;
  name: string;
  contact: string;
  email: string;
  industry: string;
  since: string;
  health: "good" | "watch" | "at_risk";
  notes: string;
}

export const CLIENTS: Client[] = [
  { id: "c-harbor", name: "Harbor Coffee Co.", contact: "Priya Nair", email: "priya@harborcoffee.example", industry: "Food and drink", since: "2023-04-12", health: "watch", notes: "Rebrand in progress. Slow to pay the last two invoices." },
  { id: "c-pinecrest", name: "Pinecrest Clinic", contact: "Dr. Owen Hale", email: "owen@pinecrest.example", industry: "Healthcare", since: "2022-09-01", health: "good", notes: "Website refresh. Very responsive." },
  { id: "c-atlas", name: "Atlas Robotics", contact: "Mei Tanaka", email: "mei@atlasrobotics.example", industry: "Hardware", since: "2024-01-20", health: "at_risk", notes: "Pitch deck project is blocked on their product photos." },
  { id: "c-juniper", name: "Juniper Books", contact: "Luis Ortega", email: "luis@juniperbooks.example", industry: "Publishing", since: "2021-06-15", health: "good", notes: "Long-time client. Book cover series, one per quarter." },
  { id: "c-meridian", name: "Meridian Hotels", contact: "Hannah Brooks", email: "hannah@meridianhotels.example", industry: "Hospitality", since: "2024-05-03", health: "watch", notes: "Large signage project. Invoice 30+ days overdue." },
  { id: "c-solace", name: "Solace Yoga", contact: "Ava Kim", email: "ava@solaceyoga.example", industry: "Fitness", since: "2025-02-11", health: "good", notes: "New client. App onboarding screens." },
  { id: "c-vantage", name: "Vantage Legal", contact: "Marcus Webb", email: "marcus@vantagelegal.example", industry: "Legal", since: "2023-11-08", health: "good", notes: "Annual report design, due next month." },
  { id: "c-kite", name: "Kite & Co.", contact: "Zoe Laurent", email: "zoe@kiteandco.example", industry: "Retail", since: "2025-07-19", health: "watch", notes: "Packaging project. Asked about a discount." },
];

export const CLIENT_NAMES: string[] = CLIENTS.map((c) => c.name);

export type InvoiceStatus = "draft" | "sent" | "overdue" | "paid";

export interface Invoice {
  id: string;
  client: string;
  amount: number;
  issued: string;
  due: string;
  status: InvoiceStatus;
  project: string;
  remindersSent: number;
  /** ISO timestamp of the last time the user resent this invoice ("resend_invoice"). Absent: never resent. */
  resentAt?: string;
}

export const INVOICES: Invoice[] = [
  { id: "INV-1042", client: "Harbor Coffee Co.", amount: 4200, issued: daysFromToday(-44), due: daysFromToday(-14), status: "overdue", project: "Harbor rebrand", remindersSent: 1 },
  { id: "INV-1038", client: "Meridian Hotels", amount: 12800, issued: daysFromToday(-66), due: daysFromToday(-36), status: "overdue", project: "Lobby signage", remindersSent: 2 },
  { id: "INV-1047", client: "Kite & Co.", amount: 2650, issued: daysFromToday(-35), due: daysFromToday(-5), status: "overdue", project: "Packaging system", remindersSent: 0 },
  { id: "INV-1049", client: "Pinecrest Clinic", amount: 5400, issued: daysFromToday(-10), due: daysFromToday(20), status: "sent", project: "Website refresh", remindersSent: 0 },
  { id: "INV-1050", client: "Juniper Books", amount: 1800, issued: daysFromToday(-3), due: daysFromToday(27), status: "sent", project: "Winter cover", remindersSent: 0 },
  { id: "INV-1051", client: "Solace Yoga", amount: 3100, issued: daysFromToday(-1), due: daysFromToday(29), status: "sent", project: "App onboarding", remindersSent: 0 },
  { id: "INV-1052", client: "Vantage Legal", amount: 7600, issued: daysFromToday(0), due: daysFromToday(30), status: "draft", project: "Annual report", remindersSent: 0 },
  { id: "INV-1053", client: "Atlas Robotics", amount: 3900, issued: daysFromToday(0), due: daysFromToday(30), status: "draft", project: "Pitch deck", remindersSent: 0 },
  { id: "INV-1031", client: "Juniper Books", amount: 1800, issued: daysFromToday(-95), due: daysFromToday(-65), status: "paid", project: "Autumn cover", remindersSent: 0 },
  { id: "INV-1035", client: "Pinecrest Clinic", amount: 4800, issued: daysFromToday(-80), due: daysFromToday(-50), status: "paid", project: "Brand guidelines", remindersSent: 0 },
  { id: "INV-1040", client: "Harbor Coffee Co.", amount: 3600, issued: daysFromToday(-75), due: daysFromToday(-45), status: "paid", project: "Harbor rebrand", remindersSent: 2 },
  { id: "INV-1044", client: "Solace Yoga", amount: 2200, issued: daysFromToday(-40), due: daysFromToday(-10), status: "paid", project: "Logo", remindersSent: 0 },
];

export interface Message {
  id: string;
  from: string;
  client: string | null;
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
  flagged: boolean;
}

export const MESSAGES: Message[] = [
  { id: "m-1", from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Re: Invoice INV-1042", preview: "Sorry for the delay. Can you resend the invoice to our accounts team? The old email bounced.", receivedAt: todayAt(8, 12), unread: true, flagged: true },
  { id: "m-2", from: "Hannah Brooks", client: "Meridian Hotels", subject: "Signage install date", preview: "The lobby install moved to the 14th. Can we still hit that with the revised sizes?", receivedAt: todayAt(7, 45), unread: true, flagged: false },
  { id: "m-3", from: "Mei Tanaka", client: "Atlas Robotics", subject: "Product photos", preview: "Photos are delayed another week. Can the deck go ahead with renders for now?", receivedAt: daysFromToday(-1) + "T16:20:00.000Z", unread: true, flagged: true },
  { id: "m-4", from: "Jordan Lee", client: null, subject: "Out Thursday", preview: "Heads up, I'm out Thursday for a dentist appointment. Pinecrest files are on the drive.", receivedAt: daysFromToday(-1) + "T14:05:00.000Z", unread: false, flagged: false },
  { id: "m-5", from: "Zoe Laurent", client: "Kite & Co.", subject: "Discount on packaging?", preview: "We love the direction. Is there any flexibility on the price for the second round?", receivedAt: daysFromToday(-1) + "T11:30:00.000Z", unread: true, flagged: false },
  { id: "m-6", from: "Dr. Owen Hale", client: "Pinecrest Clinic", subject: "Homepage feedback", preview: "Team loved the new homepage. Two small copy changes attached.", receivedAt: daysFromToday(-2) + "T17:10:00.000Z", unread: false, flagged: false },
  { id: "m-7", from: "Luis Ortega", client: "Juniper Books", subject: "Spring cover brief", preview: "Brief for the spring cover is attached. No rush, but a call next week would help.", receivedAt: daysFromToday(-2) + "T09:40:00.000Z", unread: false, flagged: false },
  { id: "m-8", from: "Ava Kim", client: "Solace Yoga", subject: "Onboarding screens", preview: "Could we see one more option for the welcome screen before Friday?", receivedAt: daysFromToday(-3) + "T15:00:00.000Z", unread: false, flagged: false },
  { id: "m-9", from: "Marcus Webb", client: "Vantage Legal", subject: "Annual report numbers", preview: "Final numbers will land Monday. Charts can use placeholders until then.", receivedAt: daysFromToday(-3) + "T10:15:00.000Z", unread: false, flagged: false },
  { id: "m-10", from: "Riley Chen", client: null, subject: "Printer quote", preview: "Got the quote for the Meridian signage print run. It's on the shared drive.", receivedAt: daysFromToday(-4) + "T13:25:00.000Z", unread: false, flagged: false },
];

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  client: string | null;
  kind: "meeting" | "call" | "focus" | "internal";
}

export const EVENTS: CalendarEvent[] = [
  { id: "e-1", title: "Studio stand-up", start: todayAt(9, 30), end: todayAt(9, 45), client: null, kind: "internal" },
  { id: "e-2", title: "Harbor rebrand review", start: todayAt(11, 0), end: todayAt(12, 0), client: "Harbor Coffee Co.", kind: "meeting" },
  { id: "e-3", title: "Focus: Vantage report layout", start: todayAt(13, 0), end: todayAt(15, 0), client: "Vantage Legal", kind: "focus" },
  { id: "e-4", title: "Call with Meridian about install", start: todayAt(15, 30), end: todayAt(16, 0), client: "Meridian Hotels", kind: "call" },
  { id: "e-5", title: "Solace onboarding critique", start: daysFromToday(1) + "T10:00:00.000Z", end: daysFromToday(1) + "T11:00:00.000Z", client: "Solace Yoga", kind: "meeting" },
  { id: "e-6", title: "Juniper spring brief call", start: daysFromToday(3) + "T14:00:00.000Z", end: daysFromToday(3) + "T14:30:00.000Z", client: "Juniper Books", kind: "call" },
  { id: "e-7", title: "Team retro", start: daysFromToday(4) + "T16:00:00.000Z", end: daysFromToday(4) + "T17:00:00.000Z", client: null, kind: "internal" },
];

export interface Task {
  id: string;
  title: string;
  due: string;
  project: string | null;
  client: string | null;
  done: boolean;
  assignee: string;
}

export const TASKS: Task[] = [
  { id: "t-1", title: "Resend INV-1042 to Harbor accounts team", due: daysFromToday(0), project: "Harbor rebrand", client: "Harbor Coffee Co.", done: false, assignee: "Sam Rivera" },
  { id: "t-2", title: "Revise Meridian signage sizes", due: daysFromToday(2), project: "Lobby signage", client: "Meridian Hotels", done: false, assignee: "Riley Chen" },
  { id: "t-3", title: "Decide on renders vs photos for Atlas deck", due: daysFromToday(1), project: "Pitch deck", client: "Atlas Robotics", done: false, assignee: "Sam Rivera" },
  { id: "t-4", title: "Pinecrest homepage copy changes", due: daysFromToday(1), project: "Website refresh", client: "Pinecrest Clinic", done: false, assignee: "Jordan Lee" },
  { id: "t-5", title: "Third welcome screen option for Solace", due: daysFromToday(3), project: "App onboarding", client: "Solace Yoga", done: false, assignee: "Noor Patel" },
  { id: "t-6", title: "Reply to Kite about discount", due: daysFromToday(0), project: "Packaging system", client: "Kite & Co.", done: false, assignee: "Sam Rivera" },
  { id: "t-7", title: "Placeholder charts for Vantage report", due: daysFromToday(4), project: "Annual report", client: "Vantage Legal", done: false, assignee: "Alex Moreau" },
  { id: "t-8", title: "Send Juniper winter cover files", due: daysFromToday(-2), project: "Winter cover", client: "Juniper Books", done: true, assignee: "Noor Patel" },
  { id: "t-9", title: "Book printer for Meridian run", due: daysFromToday(5), project: "Lobby signage", client: "Meridian Hotels", done: false, assignee: "Riley Chen" },
  { id: "t-10", title: "Update studio portfolio", due: daysFromToday(10), project: null, client: null, done: false, assignee: "Alex Moreau" },
];

export type ProjectStatus = "on_track" | "at_risk" | "blocked" | "done";

export interface Project {
  id: string;
  name: string;
  client: string;
  progress: number;
  deadline: string;
  status: ProjectStatus;
  lead: string;
}

export const PROJECTS: Project[] = [
  { id: "p-harbor", name: "Harbor rebrand", client: "Harbor Coffee Co.", progress: 0.7, deadline: daysFromToday(21), status: "on_track", lead: "Sam Rivera" },
  { id: "p-meridian", name: "Lobby signage", client: "Meridian Hotels", progress: 0.55, deadline: daysFromToday(12), status: "at_risk", lead: "Riley Chen" },
  { id: "p-atlas", name: "Pitch deck", client: "Atlas Robotics", progress: 0.3, deadline: daysFromToday(9), status: "blocked", lead: "Sam Rivera" },
  { id: "p-pinecrest", name: "Website refresh", client: "Pinecrest Clinic", progress: 0.85, deadline: daysFromToday(6), status: "on_track", lead: "Jordan Lee" },
  { id: "p-solace", name: "App onboarding", client: "Solace Yoga", progress: 0.4, deadline: daysFromToday(18), status: "on_track", lead: "Noor Patel" },
  { id: "p-vantage", name: "Annual report", client: "Vantage Legal", progress: 0.2, deadline: daysFromToday(34), status: "on_track", lead: "Alex Moreau" },
  { id: "p-kite", name: "Packaging system", client: "Kite & Co.", progress: 0.6, deadline: daysFromToday(15), status: "at_risk", lead: "Sam Rivera" },
];

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  status: "available" | "busy" | "away";
  workingOn: string;
}

export const TEAM: TeamMember[] = [
  { id: "u-sam", name: "Sam Rivera", role: "Studio lead", status: "busy", workingOn: "Harbor rebrand" },
  { id: "u-riley", name: "Riley Chen", role: "Production designer", status: "available", workingOn: "Lobby signage" },
  { id: "u-jordan", name: "Jordan Lee", role: "Web designer", status: "available", workingOn: "Website refresh" },
  { id: "u-noor", name: "Noor Patel", role: "Product designer", status: "busy", workingOn: "App onboarding" },
  { id: "u-alex", name: "Alex Moreau", role: "Designer", status: "away", workingOn: "Annual report" },
];

/** Revenue per month, oldest first, ending with the current month (partial). */
export const MONTHLY_REVENUE: { month: string; amount: number }[] = (() => {
  const amounts = [18400, 21200, 19800, 24500, 22100, 26800, 23900, 27400, 25200, 29800, 28100, 14600];
  const now = new Date(today);
  return amounts.map((amount, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (amounts.length - 1 - i), 1);
    return { month: d.toLocaleString("en-US", { month: "short" }), amount };
  });
})();

export function invoicesForClient(client: string): Invoice[] {
  return INVOICES.filter((inv) => inv.client === client);
}

/** The oldest overdue invoice for a client, if any. Used to fill suggestion args. */
export function oldestOverdueInvoice(client?: string): Invoice | undefined {
  return INVOICES.filter((inv) => inv.status === "overdue" && (!client || inv.client === client)).sort((a, b) =>
    a.due.localeCompare(b.due),
  )[0];
}

export function outstandingTotal(): number {
  return INVOICES.filter((inv) => inv.status === "overdue" || inv.status === "sent").reduce((sum, inv) => sum + inv.amount, 0);
}
