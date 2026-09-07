import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { config } from "../config";

/**
 * One bucket per caller, not per office.
 *
 * The whole firm reaches this app through one NAT address, so a per-IP limit
 * is a per-office limit: four people testing shared a single 300/minute
 * allowance, tripped it with ordinary dashboard use, and the client's retries
 * then kept it tripped — which surfaced as "too many requests" and as the app
 * feeling slow, from the same bucket.
 *
 * Authenticated requests are counted by a hash of their bearer token instead.
 * Hashed because limiter keys sit in memory and appear in debugging output,
 * where a raw token has no business being. Unauthenticated requests still
 * count by IP, which is the only identity they have.
 */
function callerKey(req: Request): string {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return createHash("sha256").update(auth).digest("base64url").slice(0, 27);
  }
  return ipKeyGenerator(req.ip ?? "");
}

// The suite signs in as many people many times from one address; throttling
// that would test the limiter rather than the behaviour under test.
const skipInTests = () => config.nodeEnv === "test";

/**
 * Login throttle.
 *
 * bcrypt comparison is deliberately expensive, so an unthrottled login form is
 * both a credential-stuffing surface and a way to exhaust the CPU of a small
 * container. Counted per IP; successful logins do not count against the limit.
 *
 * Becomes redundant once Entra ID owns sign-in and this endpoint disappears.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many sign-in attempts. Try again in a few minutes." },
});

/**
 * Crash-report intake.
 *
 * This endpoint is unauthenticated by necessity — the reports worth having are
 * the ones from a browser that could not sign in — so it is the easiest thing
 * in the API to point a script at. A render loop that throws on every frame
 * would also flood it without any malice at all, which is the likelier way
 * this gets abused. Low enough to make either pointless; the client batches
 * and drops the excess rather than retrying.
 */
export const devIngestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many reports." },
});

/**
 * Broad ceiling for the rest of the API — high enough that one person's
 * ordinary use never touches it (300/minute is five requests a second,
 * sustained), low enough to blunt scripted enumeration. Counted per caller;
 * the login and crash-report limiters above stay per-IP because their traffic
 * is unauthenticated by nature.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  keyGenerator: callerKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many requests. Slow down and try again shortly." },
});
