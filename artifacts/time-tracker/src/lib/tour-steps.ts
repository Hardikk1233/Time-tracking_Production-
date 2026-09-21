/**
 * What the guided tour says, per rank.
 *
 * Plain data on purpose. The copy here is the part most likely to be revised
 * after people have actually used it, and revising it should not mean touching
 * the overlay component.
 *
 * Each rank gets its own list because the sidebar already differs by rank — an
 * analyst has three nav items, an MD has nine. One shared tour would spend
 * half its steps on controls most of the firm cannot see, and would teach an
 * analyst to look for an Approvals page that is not there.
 *
 * A step points at an element by `anchor`, which is matched against
 * `data-tour="..."` in the DOM. Anchors that are missing when the step runs
 * are skipped rather than left pointing at nothing, so a tour survives a page
 * that has not loaded its data yet.
 */

export type Rank = "analyst" | "associate" | "avp" | "md";

export interface TourStep {
  /** Route to be on for this step. The tour navigates there before showing it. */
  path: string;
  /** `data-tour` value to spotlight. Omitted for a centred card with no pointer. */
  anchor?: string;
  /** Preferred side for the card. Clamped to stay inside the viewport. */
  side?: "top" | "bottom" | "left" | "right";
  /** Small label above the title, grouping consecutive steps. */
  kicker: string;
  title: string;
  body: string;
}

const welcome = (firstName: string, count: string): TourStep => ({
  path: "/dashboard",
  kicker: "Welcome",
  title: `Welcome to TimeTrack, ${firstName}`,
  body: `${count} short steps covering everything your account can do. You can leave at any point and pick it up again from the button in the bottom corner.`,
});

const ANALYST: TourStep[] = [
  welcome("there", "Six"),
  {
    path: "/dashboard",
    anchor: "nav-dashboard",
    side: "right",
    kicker: "Your page",
    title: "Your month, at a glance",
    body: "Hours you have logged against your target. The target is your working days minus public holidays and any leave you have taken, so it moves with your actual availability.",
  },
  {
    path: "/time-entries",
    anchor: "nav-time-entries",
    side: "right",
    kicker: "The main job",
    title: "Everything you log lives here",
    body: "One row per entry, yours only. An analyst sees their own hours and nobody else's, on every screen in the app.",
  },
  {
    path: "/time-entries",
    anchor: "log-time",
    side: "bottom",
    kicker: "The main job",
    title: "Log Time",
    body: "Client, then project, then task, then hours. Only projects you are staffed on appear — if one is missing, ask to be added to it rather than logging the time elsewhere.",
  },
  {
    path: "/time-entries",
    anchor: "entry-actions",
    side: "left",
    kicker: "Corrections",
    title: "Fix your own hours until they are approved",
    body: "Edit or delete any entry of yours that is still pending. Once it is approved it becomes a billing record and locks — ask an AVP to reopen it if something needs changing.",
  },
  {
    path: "/time-entries",
    anchor: "log-leave",
    side: "bottom",
    kicker: "Time off",
    title: "Log Leave — full or half day",
    body: "A half day uses up only half a day of your target, so taking an afternoon off will not make your utilisation look wrong.",
  },
  {
    path: "/reports",
    anchor: "nav-reports",
    side: "right",
    kicker: "Last one",
    title: "My Reports",
    body: "Your own hours by client, project and task for any date range, exportable to Excel or PDF. Set the dates first — it opens on the current month.",
  },
];

const ASSOCIATE: TourStep[] = [
  welcome("there", "Eight"),
  {
    path: "/time-entries",
    anchor: "nav-time-entries",
    side: "right",
    kicker: "The basics",
    title: "Log your own time here",
    body: "Same as everyone. What differs is the rest of the list: you also see your teammates' entries on the projects you share with them.",
  },
  {
    path: "/projects",
    anchor: "nav-projects",
    side: "right",
    kicker: "Your remit",
    title: "You run the projects",
    body: "Create them under any client you are assigned to. An AVP sets up the client; you set up the work beneath it.",
  },
  {
    path: "/projects",
    anchor: "new-project",
    side: "bottom",
    kicker: "Your remit",
    title: "Every field is required",
    body: "Name, description, at least one task and at least one team member. A project with nobody on it has nobody who may log against it, so the form no longer lets you create one.",
  },
  {
    path: "/tasks",
    anchor: "nav-tasks",
    side: "right",
    kicker: "Your remit",
    title: "Browse the catalog, enable what you need",
    body: "An AVP defines the firm-wide list. You choose which of them apply to each project, and that is what fills the task dropdown when your team logs time against it.",
  },
  {
    path: "/approvals",
    anchor: "nav-approvals",
    side: "right",
    kicker: "Sign-off",
    title: "Approve your team's hours",
    body: "Anything in this queue is yours to decide, your own entries included. Approving is final — only an AVP can reopen an entry afterwards.",
  },
  {
    path: "/time-entries",
    anchor: "entry-actions",
    side: "left",
    kicker: "Sign-off",
    title: "Split billable from non-billable",
    body: "Worked eight, bill six. Set the split with the scissors before you approve: afterwards the entry locks, and the split is what the client is billed for.",
  },
  {
    path: "/reports",
    anchor: "nav-reports",
    side: "right",
    kicker: "Last one",
    title: "Reports across your projects",
    body: "Your own hours, and your teammates' on the projects you share. Exportable per person or in total.",
  },
];

const AVP: TourStep[] = [
  welcome("there", "Seven"),
  {
    path: "/clients",
    anchor: "nav-clients",
    side: "right",
    kicker: "Your remit",
    title: "Clients start with you",
    body: "Associates cannot create these and you can. Everything else in the app hangs off a client, so this is the first thing to set up for new work.",
  },
  {
    path: "/clients",
    anchor: "new-client",
    side: "bottom",
    kicker: "Your remit",
    title: "Name who is responsible",
    body: "Required, and the most important field on the form. Your associates reach a client only by being assigned to it, so a client with nobody on it is invisible to everyone below you.",
  },
  {
    path: "/tasks",
    anchor: "nav-tasks",
    side: "right",
    kicker: "Your remit",
    title: "You own the task catalog",
    body: "Define the work types the whole firm logs against. The pencil renames one, and hours already logged follow the new name rather than being orphaned under the old.",
  },
  {
    path: "/approvals",
    anchor: "nav-approvals",
    side: "right",
    kicker: "Sign-off",
    title: "Everything on your clients",
    body: "Not only people who report to you — anyone logging against a project under one of your clients. That is what your remit means everywhere in the app.",
  },
  {
    path: "/time-entries",
    anchor: "entry-actions",
    side: "left",
    kicker: "Sign-off",
    title: "Reopening an approved entry",
    body: "Approved hours lock for everyone, including you. Reopening unlocks one for correction and is recorded as its own event, so a figure that changed never looks like the original.",
  },
  {
    path: "/reports",
    anchor: "nav-reports",
    side: "right",
    kicker: "Oversight",
    title: "Team Reports, and why some rows show a dash",
    body: "Everybody working on your clients, by person and project. FTE clients are measured against contracted capacity; a product client shows hours and a dash, because deliverables have no hours target.",
  },
];

const MD: TourStep[] = [
  welcome("there", "Six"),
  {
    path: "/dashboard",
    anchor: "nav-dashboard",
    side: "right",
    kicker: "Firm-wide",
    title: "You see everything",
    body: "Every client, project, person and hour. No scoping rule in the app narrows an MD, so anything anyone else can see, you can see too.",
  },
  {
    path: "/team",
    anchor: "nav-team",
    side: "right",
    kicker: "Firm-wide",
    title: "People and ranks",
    body: "Add someone, or change what they can do. Ranks come from Microsoft sign-in groups, so a change there wins on their next sign-in and overrides anything set here.",
  },
  {
    path: "/holidays",
    anchor: "nav-holidays",
    side: "right",
    kicker: "Yours alone",
    title: "The firm calendar",
    body: "Only an MD can set these, and they matter more than they look: every capacity and utilisation figure in the app is computed net of public holidays.",
  },
  {
    path: "/time-entries",
    anchor: "entry-actions",
    side: "left",
    kicker: "Final say",
    title: "Reopen, and delete",
    body: "AVPs can reopen an approved entry. Deleting somebody else's record stops with you — seniority grants sign-off authority, not the power to erase submitted work.",
  },
  {
    path: "/reports",
    anchor: "nav-reports",
    side: "right",
    kicker: "Oversight",
    title: "Every client, every engagement",
    body: "FTE clients against contracted capacity, blocks of hours against what was bought, and product clients showing hours with no percentage at all.",
  },
];

const BY_RANK: Record<Rank, TourStep[]> = {
  analyst: ANALYST,
  associate: ASSOCIATE,
  avp: AVP,
  md: MD,
};

/** The tour for a rank, with the welcome step addressed to them by first name. */
export function stepsFor(rank: string | undefined, fullName: string | undefined): TourStep[] {
  const steps = BY_RANK[(rank as Rank) ?? "analyst"] ?? ANALYST;
  const firstName = (fullName ?? "").trim().split(/\s+/)[0];
  if (!firstName) return steps;
  return steps.map((s, i) =>
    i === 0 ? { ...s, title: s.title.replace("there", firstName) } : s,
  );
}
