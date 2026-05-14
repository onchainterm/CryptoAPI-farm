import { closePool } from "../db/pool.js";
import { logger } from "../logger.js";
import { SolanaIndexer } from "../services/indexer.js";
import { runSyncLoop } from "../syncLoop.js";

const abortController = new AbortController();
const indexer = new SolanaIndexer();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    abortController.abort();
  });
}

try {
  await runSyncLoop(indexer, abortController.signal);
} catch (error) {
  logger.error({ error }, "worker crashed");
  process.exitCode = 1;
} finally {
  await closePool();
}
