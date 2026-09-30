/**
 * Display-only. Authorization is decided by the server; nothing here grants
 * or checks access.
 */

const ROLE_LABELS: Record<string, string> = {
  analyst: 'Analyst',
  associate: 'Associate',
  avp: 'AVP',
  md: 'MD',
};

/**
 * What to show as someone's designation.
 *
 * Usually the role label, but a title override takes precedence - e.g. "VP"
 * for someone who holds the avp permission rank under a different real
 * title. Same access either way; only the label differs.
 */
export function displayTitle(user: { role: string; title?: string | null }): string {
  return user.title || ROLE_LABELS[user.role] || user.role;
}

/**
 * The same answer for the row shapes that name the person's fields rather
 * than being a user object - time entries, report rows, leave, assignments.
 *
 * Every one of these used to render the bare rank, so an administrator read
 * as "Md" on eight different screens while the sidebar and the Team page,
 * which went through displayTitle, correctly said "Admin".
 */
export function displayTitleOf(
  role: string | null | undefined,
  title?: string | null,
): string {
  if (title) return title;
  if (!role) return '';
  return ROLE_LABELS[role] || role;
}
