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
