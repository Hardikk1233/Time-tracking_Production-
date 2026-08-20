import rateLimit from "express-rate-limit";
import { config } from "../config";

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
 * Broad ceiling for the rest of the API — high enough that ordinary use never
 * touches it, low enough to blunt scripted enumeration.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many requests. Slow down and try again shortly." },
});
