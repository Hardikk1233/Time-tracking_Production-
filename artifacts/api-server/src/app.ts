import path from "node:path";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import pinoHttp from "pino-http";
import router from "./routes";
import { apiLimiter, loginLimiter } from "./middlewares/rate-limit";
import { config } from "./config";
import { logger } from "./lib/logger";
import "./types/session.d";

const app: Express = express();

// Container Apps terminates TLS at its ingress, so the client protocol and IP
// arrive in X-Forwarded-* headers. Without this, secure cookies never set.
if (config.trustProxy) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(
  helmet({
    // The app and API share an origin, and the SPA's bundled assets are all
    // same-origin, so a strict default policy holds without exceptions.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite injects a small inline style block for the initial paint.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // Left to the ingress, which terminates TLS and owns the domain's HSTS.
    hsts: false,
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// In production this container serves the frontend too, so browser calls are
// same-origin and CORS is not enabled at all. It is turned on only when an
// explicit allowlist is configured — e.g. the Vite dev server in development.
if (config.corsOrigins.length > 0) {
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
    }),
  );
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.isProduction,
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: "lax",
    },
  }),
);

app.use("/api/auth/login", loginLimiter);
app.use("/api", apiLimiter);
app.use("/api", router);

// Unmatched API paths must answer as the API, not fall through to the SPA
// fallback below — a 200 with an HTML body would look like success to the
// client and fail confusingly deep inside the UI.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (config.staticDir) {
  const staticDir = path.resolve(config.staticDir);
  const indexHtml = path.join(staticDir, "index.html");

  app.use(
    express.static(staticDir, {
      // index.html is served by the SPA fallback so it always gets no-cache.
      index: false,
      setHeaders(res, filePath) {
        // Vite emits content-hashed filenames under /assets, so those are safe
        // to cache indefinitely. Everything else must revalidate.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  // Client-side routes (/dashboard, /clients/4, …) have no file on disk; hand
  // them the app shell and let the router resolve them in the browser.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });
}

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  req.log?.error({ err }, "Unhandled error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

export default app;
