import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closePool, pool } from "./pool.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function splitSqlStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function migrate(): Promise<void> {
  const schemaPath = join(__dirname, "schema.sql");
  const schema = await readFile(schemaPath, "utf8");
  const statements = splitSqlStatements(schema);

  for (const statement of statements) {
    await pool.query(statement);
  }

  logger.info({ statements: statements.length }, "database migrations complete");
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  migrate()
    .then(async () => {
      await closePool();
    })
    .catch(async (error: unknown) => {
      logger.error({ error }, "database migration failed");
      await closePool();
      process.exitCode = 1;
    });
}
