import { type Request, type Response, type NextFunction } from "express";
import { config } from "../config";
import { principal } from "./auth";
import { logger } from "../lib/logger";

/**
 * Gates the temporary /dev console to a named list of people.
 *
 * Deliberately not `requireRole("md")`: seniority in the firm's hierarchy says
 * nothing about who is debugging the rollout, and the console shows raw stack
 * traces and other users' verbatim feedback — a narrower audience than "every
 * Managing Director".
 *
 * An unset DEV_CONSOLE_EMAILS closes the console rather than opening it. The
 * dangerous default for an access list is the permissive one, and this list
 * will be absent in every environment nobody has explicitly configured.
 */
export function requireDevConsole(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const allowed = config.devConsoleEmails;

  // 404 rather than 403 throughout: the console is not a feature of the
  // product, and someone who is not on the list has no reason to learn that it
  // exists at all.
  if (allowed.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const me = principal(req);
  if (!allowed.includes(me.email.toLowerCase())) {
    logger.warn(
      { email: me.email },
      "Refused /dev console access to a non-allowlisted account",
    );
    res.status(404).json({ error: "Not found" });
    return;
  }

  next();
}
