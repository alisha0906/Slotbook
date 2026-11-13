import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { registerBookingRoutes } from "./routes/booking.js";
import { registerHostRoutes } from "./routes/host.js";
import { startHoldExpiryWorker } from "./worker.js";

/**
 * Fastify API server.
 *
 * Serves the JSON API under /api and, in production, the built React app as
 * static files from the same origin (single port, no CORS). A SPA fallback
 * serves index.html for client-side routes like /{host}/{slug}.
 */
export function buildServer() {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug",
    },
  });

  app.register(cors, { origin: true });

  // Liveness + DB readiness probe.
  app.get("/health", async () => {
    const started = Date.now();
    await pool.query("SELECT 1");
    return {
      status: "ok",
      db: "ok",
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    };
  });

  // API routes.
  void app.register(registerBookingRoutes);
  void app.register(registerHostRoutes);

  // Serve the built React app (if present) from the same origin.
  // In the image: dist/server.js lives at /app/apps/api/dist/server.js and the
  // web build is copied to /app/apps/web-dist, i.e. two levels up from dist.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDir = join(__dirname, "..", "..", "web-dist");
  if (existsSync(join(webDir, "index.html"))) {
    void app.register(fastifyStatic, { root: webDir, prefix: "/" });

    // SPA fallback: any non-API GET that isn't a real file returns index.html
    // so client-side routes (e.g. /demo/intro-call, /manage/:token) work.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/health")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}

async function start(): Promise<void> {
  const app = buildServer();
  try {
    await app.listen({ port: config.apiPort, host: "0.0.0.0" });
    app.log.info(`Slotbook API listening on :${config.apiPort}`);
    // Start the background hold-expiry sweep.
    startHoldExpiryWorker();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  void start();
} else if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void start();
}
