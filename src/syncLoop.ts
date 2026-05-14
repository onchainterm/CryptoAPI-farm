import { config } from "./config.js";
import { logger } from "./logger.js";
import type { SolanaIndexer } from "./services/indexer.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runSyncLoop(indexer: SolanaIndexer, signal?: AbortSignal): Promise<void> {
  logger.info({ intervalMs: config.sync.intervalMs }, "sync loop started");

  while (!signal?.aborted) {
    try {
      const result = await indexer.syncAll(config.solana.syncBatchLimit);
      logger.info({ result }, "sync loop completed");
    } catch (error) {
      logger.error({ error }, "sync loop failed");
    }

    await sleep(config.sync.intervalMs);
  }

  logger.info("sync loop stopped");
}
