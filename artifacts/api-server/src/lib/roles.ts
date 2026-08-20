/**
 * The firm's four-tier hierarchy, and the comparisons the API authorises with.
 *
 * Roles are ranked, so permissions read as "Associate or above" rather than as
 * hand-maintained arrays that drift apart between route files.
 */

export const ROLES = ["analyst", "associate", "avp", "md"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  analyst: 0,
  associate: 1,
  avp: 2,
  md: 3,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** True when `role` sits at or above `minimum` in the hierarchy. */
export function atLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/** True when `role` sits strictly above `other`. */
export function outranks(role: Role, other: Role): boolean {
  return RANK[role] > RANK[other];
}

export function roleLabel(role: Role): string {
  return role === "md" ? "MD" : role === "avp" ? "AVP" : role === "associate" ? "Associate" : "Analyst";
}
