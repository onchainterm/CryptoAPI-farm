import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { config } from "./config.js";
import { closePool, pool } from "./db/pool.js";
import { HttpError } from "./http.js";
import { logger } from "./logger.js";
import { createRouter } from "./routes.js";
import { SolanaIndexer } from "./services/indexer.js";
import { runSyncLoop } from "./syncLoop.js";

const indexer = new SolanaIndexer();
const app = express();
const abortController = new AbortController();

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(pinoHttp({ logger }));

app.get("/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/api") || !config.apiKey) {
    next();
    return;
  }

  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const apiKey = req.header("x-api-key") ?? bearer;

  if (apiKey !== config.apiKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
});

app.use("/api", createRouter(indexer));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Unknown error";

  if (statusCode >= 500) {
    logger.error({ error }, "request failed");
  }

  res.status(statusCode).json({ error: message });
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "solana data farmer api listening");
});

if (config.sync.enableApiLoop) {
  runSyncLoop(indexer, abortController.signal).catch((error: unknown) => {
    logger.error({ error }, "inline sync loop crashed");
  });
}

async function shutdown(): Promise<void> {
  abortController.abort();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await closePool();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ error }, "graceful shutdown failed");
        process.exit(1);
      });
  });
}
