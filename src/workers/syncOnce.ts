import { closePool } from "../db/pool.js";
import { logger } from "../logger.js";
import { SolanaIndexer } from "../services/indexer.js";

const indexer = new SolanaIndexer();
const address = process.argv[2];
const limit = process.argv[3] ? Number.parseInt(process.argv[3], 10) : undefined;

try {
  const result = address ? await indexer.syncAddress(address, limit) : await indexer.syncAll(limit);
  logger.info({ result }, "sync complete");
} catch (error) {
  logger.error({ error }, "sync failed");
  process.exitCode = 1;
} finally {
  await closePool();
}
