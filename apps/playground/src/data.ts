/** The playground's made-up data. All names and companies are invented. */

export interface Ticket {
  id: string;
  subject: string;
  customer: string;
  status: "open" | "pending" | "solved";
  priority: "high" | "normal";
  /** The help article that answers it, when one does. */
  article?: string;
}

export interface Customer {
  id: string;
  name: string;
  plan: "Free" | "Team" | "Business";
  contact: string;
}

export interface Article {
  id: string;
  title: string;
  tags: string[];
}

export interface Macro {
  id: string;
  title: string;
  text: string;
}

export const CUSTOMERS: Customer[] = [
  { id: "c-larkspur", name: "Larkspur Bakery", plan: "Team", contact: "Mina Ortiz" },
  { id: "c-quarry", name: "Quarry Labs", plan: "Business", contact: "Dev Patel" },
  { id: "c-tidewater", name: "Tidewater Clinic", plan: "Free", contact: "Ana Silva" },
  { id: "c-northfield", name: "Northfield Press", plan: "Team", contact: "Omar Haddad" },
];

export const TICKETS: Ticket[] = [
  { id: "T-201", subject: "Cannot reset my password", customer: "Larkspur Bakery", status: "open", priority: "high", article: "a-reset" },
  { id: "T-202", subject: "Invoice shows the wrong plan", customer: "Quarry Labs", status: "open", priority: "normal" },
  { id: "T-203", subject: "How do I add a teammate?", customer: "Larkspur Bakery", status: "pending", priority: "normal", article: "a-invite" },
  { id: "T-204", subject: "Export to CSV fails", customer: "Northfield Press", status: "open", priority: "high", article: "a-export" },
  { id: "T-205", subject: "Refund for a double charge", customer: "Tidewater Clinic", status: "open", priority: "normal" },
  { id: "T-206", subject: "Two-factor codes do not arrive", customer: "Quarry Labs", status: "solved", priority: "high", article: "a-2fa" },
];

export const ARTICLES: Article[] = [
  { id: "a-reset", title: "Reset a password", tags: ["login", "password"] },
  { id: "a-invite", title: "Invite a teammate", tags: ["team", "users"] },
  { id: "a-export", title: "Export your data to CSV", tags: ["export", "csv"] },
  { id: "a-2fa", title: "Set up two-factor sign-in", tags: ["login", "security"] },
  { id: "a-billing", title: "Change your plan or billing details", tags: ["billing", "plan"] },
];

export const MACROS: Macro[] = [
  { id: "m-refund", title: "Refund on its way", text: "We have refunded the double charge. It shows on your statement in 3 to 5 days." },
  { id: "m-reset", title: "Password reset steps", text: "Use Forgot password on the sign-in page, then follow the link in the email." },
  { id: "m-thanks", title: "Thanks, closing this", text: "Glad that worked. I am marking this ticket solved; reply any time to reopen it." },
];
