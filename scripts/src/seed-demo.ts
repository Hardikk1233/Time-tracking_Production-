import {
  db,
  pool,
  usersTable,
  clientsTable,
  projectsTable,
  tasksTable,
  projectTasksTable,
  clientUsersTable,
  projectUsersTable,
  timeEntriesTable,
} from "@workspace/db";

// ─── Fixed reference dates (deterministic — no Date.now()) ────────────────────
const TODAY = "2026-08-18";
const RANGE_START = "2026-07-01";
const RANGE_END = TODAY;

function eachWeekday(start: string, end: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    const day = cur.getUTCDay();
    if (day > 0 && day < 6) days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

// Simple deterministic PRNG so re-running with the same guard is reproducible.
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

async function main() {
  const [existingClient] = await db.select({ id: clientsTable.id }).from(clientsTable).limit(1);
  if (existingClient) {
    console.log("Demo data already present (clients table non-empty) — skipping.");
    await pool.end();
    return;
  }

  const users = await db.select().from(usersTable);
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const get = (email: string) => {
    const u = byEmail.get(email);
    if (!u) throw new Error(`Expected seeded user ${email} to exist — run "pnpm --filter @workspace/scripts run seed" first.`);
    return u;
  };

  const james = get("james@timetrack.com");
  const sarah = get("sarah@timetrack.com");
  const marcus = get("marcus@timetrack.com");
  const priya = get("priya@timetrack.com");
  const daniel = get("daniel@timetrack.com");
  const olivia = get("olivia@timetrack.com");
  const ethan = get("ethan@timetrack.com");
  const aisha = get("aisha@timetrack.com");
  const ryan = get("ryan@timetrack.com");
  const sofia = get("sofia@timetrack.com");

  // ─── Clients ─────────────────────────────────────────────────────────────
  const [acme, blackstone, meridian, nova] = await db
    .insert(clientsTable)
    .values([
      { name: "Acme Capital", description: "Mid-market private equity firm", fteCount: 2 },
      { name: "Blackstone Ventures", description: "Growth-stage venture fund", fteCount: 1.5 },
      { name: "Meridian Health", description: "Regional healthcare network", fteCount: 1 },
      { name: "Nova Robotics", description: "Industrial automation startup", fteCount: 2.5 },
    ])
    .returning();
  console.log(`created ${4} clients`);

  await db.insert(clientUsersTable).values([
    { clientId: acme.id, userId: sarah.id },
    { clientId: meridian.id, userId: sarah.id },
    { clientId: blackstone.id, userId: marcus.id },
    { clientId: nova.id, userId: marcus.id },
  ]);

  // ─── Projects ────────────────────────────────────────────────────────────
  const [qtrAudit, marketEntry, complianceReview, techcoDD, portfolioReview, seriesC, opsOpt] = await db
    .insert(projectsTable)
    .values([
      { clientId: acme.id, name: "Q3 Financial Audit", description: "Quarterly audit engagement" },
      { clientId: acme.id, name: "Market Entry Strategy", description: "APAC expansion analysis" },
      { clientId: meridian.id, name: "Compliance Review", description: "HIPAA compliance assessment" },
      { clientId: blackstone.id, name: "TechCo Due Diligence", description: "Series B target diligence" },
      { clientId: blackstone.id, name: "Portfolio Review", description: "Annual portfolio performance review" },
      { clientId: nova.id, name: "Series C Fundraise", description: "Fundraise advisory" },
      { clientId: nova.id, name: "Ops Optimization", description: "Manufacturing ops efficiency study" },
    ])
    .returning();
  console.log(`created ${7} projects`);

  // ─── Tasks (global catalog) ──────────────────────────────────────────────
  const [clientMeeting, financialModeling, research, reportWriting, dataAnalysis, internalSync, dueDiligence, presentationPrep] =
    await db
      .insert(tasksTable)
      .values([
        { name: "Client Meeting" },
        { name: "Financial Modeling" },
        { name: "Research" },
        { name: "Report Writing" },
        { name: "Data Analysis" },
        { name: "Internal Sync" },
        { name: "Due Diligence" },
        { name: "Presentation Prep" },
      ])
      .returning();
  console.log(`created ${8} tasks`);

  const projectTaskLinks = [
    [qtrAudit, [financialModeling, dataAnalysis, reportWriting, clientMeeting]],
    [marketEntry, [research, dataAnalysis, presentationPrep, clientMeeting]],
    [complianceReview, [research, reportWriting, clientMeeting]],
    [techcoDD, [dueDiligence, financialModeling, dataAnalysis, reportWriting]],
    [portfolioReview, [financialModeling, dataAnalysis, presentationPrep]],
    [seriesC, [financialModeling, presentationPrep, clientMeeting, dueDiligence]],
    [opsOpt, [research, dataAnalysis, reportWriting]],
  ] as const;

  await db.insert(projectTasksTable).values(
    projectTaskLinks.flatMap(([project, tasks]) =>
      tasks.map((task) => ({ projectId: project.id, taskId: task.id })),
    ),
  );

  // ─── Project assignments ─────────────────────────────────────────────────
  const projectAssignments: Array<{ project: typeof qtrAudit; users: (typeof james)[] }> = [
    { project: qtrAudit, users: [sarah, priya, ethan] },
    { project: marketEntry, users: [sarah, priya, olivia, aisha] },
    { project: complianceReview, users: [sarah, olivia, sofia] },
    { project: techcoDD, users: [marcus, daniel, ryan] },
    { project: portfolioReview, users: [marcus, daniel] },
    { project: seriesC, users: [marcus, daniel, ryan] },
    { project: opsOpt, users: [marcus] },
  ];

  await db.insert(projectUsersTable).values(
    projectAssignments.flatMap(({ project, users: assignedUsers }) =>
      assignedUsers.map((u) => ({ projectId: project.id, userId: u.id })),
    ),
  );

  // Map each user to the projects (+ enabled tasks) they can log time against.
  const userProjects = new Map<number, { project: typeof qtrAudit; tasks: (typeof financialModeling)[] }[]>();
  for (const { project, users: assignedUsers } of projectAssignments) {
    const tasks = [...projectTaskLinks.find(([p]) => p.id === project.id)![1]];
    for (const u of assignedUsers) {
      const list = userProjects.get(u.id) ?? [];
      list.push({ project, tasks });
      userProjects.set(u.id, list);
    }
  }

  // ─── Time entries ────────────────────────────────────────────────────────
  const weekdays = eachWeekday(RANGE_START, RANGE_END);
  const recentCutoff = "2026-08-11"; // last week → pending; older → approved/rejected
  const managerId = new Map<number, number | null>([
    [sarah.id, james.id],
    [marcus.id, james.id],
    [priya.id, sarah.id],
    [daniel.id, marcus.id],
    [olivia.id, sarah.id],
    [ethan.id, priya.id],
    [aisha.id, priya.id],
    [ryan.id, daniel.id],
    [sofia.id, olivia.id],
    [james.id, null],
  ]);

  const rng = makeRng(42);
  const entries: (typeof timeEntriesTable.$inferInsert)[] = [];

  for (const [userId, projects] of userProjects) {
    const user = users.find((u) => u.id === userId)!;
    const isAnalyst = user.role === "analyst";

    for (const date of weekdays) {
      // Skip some days at random so utilization isn't a flat 100%.
      if (rng() < 0.12) continue;

      const entryCount = rng() < 0.35 ? 2 : 1;
      let remainingHours = 4 + rng() * 4.5; // ~4-8.5h/day total

      for (let i = 0; i < entryCount; i++) {
        const choice = projects[Math.floor(rng() * projects.length)];
        const task = choice.tasks[Math.floor(rng() * choice.tasks.length)];
        const hours = Math.round((entryCount === 1 ? remainingHours : remainingHours / entryCount) * 4) / 4;
        remainingHours -= hours;

        const isRecent = date > recentCutoff;
        let status: "pending" | "approved" | "rejected" = "approved";
        if (isRecent) status = "pending";
        else if (rng() < 0.06) status = "rejected";

        // Analysts don't set the billable split themselves; it's filled in once
        // an Associate+ reviews the entry (i.e. once it leaves "pending").
        const billableHours =
          isAnalyst && status === "pending"
            ? null
            : Math.round(hours * (rng() < 0.85 ? 1 : 0.5) * 4) / 4;

        entries.push({
          userId,
          projectId: choice.project.id,
          taskId: task.id,
          hours,
          date,
          billableHours,
          status,
          approvedById: status === "pending" ? null : managerId.get(userId) ?? null,
        });
      }
    }
  }

  // A little internal (no-project) time for the MD.
  for (const date of weekdays) {
    if (rng() < 0.5) continue;
    const hours = Math.round((2 + rng() * 3) * 4) / 4;
    const isRecent = date > recentCutoff;
    entries.push({
      userId: james.id,
      projectId: null,
      taskId: internalSync.id,
      hours,
      date,
      billableHours: null,
      status: isRecent ? "pending" : "approved",
      approvedById: null,
    });
  }

  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    await db.insert(timeEntriesTable).values(entries.slice(i, i + CHUNK));
  }
  console.log(`created ${entries.length} time entries`);

  await pool.end();
  console.log("Demo data seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
