import bcrypt from "bcryptjs";
import { db, usersTable, pool } from "@workspace/db";

const PASSWORD = "password123";

async function upsertUser(
  name: string,
  email: string,
  role: "md" | "avp" | "associate" | "analyst",
  reportingToEmail: string | null,
  emailToId: Map<string, number>,
) {
  const passwordHash = bcrypt.hashSync(PASSWORD, 10);
  const reportingToId = reportingToEmail ? emailToId.get(reportingToEmail) ?? null : null;

  const [row] = await db
    .insert(usersTable)
    .values({ name, email, passwordHash, role, reportingToId })
    .onConflictDoNothing({ target: usersTable.email })
    .returning({ id: usersTable.id });

  if (row) {
    emailToId.set(email, row.id);
    console.log(`created ${role} ${email}`);
  } else {
    console.log(`skipped ${email} (already exists)`);
  }
}

async function main() {
  const emailToId = new Map<string, number>();

  await upsertUser("James Whitfield", "james@timetrack.com", "md", null, emailToId);
  await upsertUser("Sarah Chen", "sarah@timetrack.com", "avp", "james@timetrack.com", emailToId);
  await upsertUser("Marcus Reed", "marcus@timetrack.com", "avp", "james@timetrack.com", emailToId);
  await upsertUser("Priya Nair", "priya@timetrack.com", "associate", "sarah@timetrack.com", emailToId);
  await upsertUser("Daniel Kim", "daniel@timetrack.com", "associate", "marcus@timetrack.com", emailToId);
  await upsertUser("Olivia Brooks", "olivia@timetrack.com", "associate", "sarah@timetrack.com", emailToId);
  await upsertUser("Ethan Walsh", "ethan@timetrack.com", "analyst", "priya@timetrack.com", emailToId);
  await upsertUser("Aisha Malik", "aisha@timetrack.com", "analyst", "priya@timetrack.com", emailToId);
  await upsertUser("Ryan Cooper", "ryan@timetrack.com", "analyst", "daniel@timetrack.com", emailToId);
  await upsertUser("Sofia Alvarez", "sofia@timetrack.com", "analyst", "olivia@timetrack.com", emailToId);

  await pool.end();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
