import dotenv from "dotenv";

dotenv.config();

export type SolanaCommitment = "processed" | "confirmed" | "finalized";

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function commitmentEnv(): SolanaCommitment {
  const value = process.env.SOLANA_COMMITMENT;
  if (value === "processed" || value === "confirmed" || value === "finalized") {
    return value;
  }

  return "confirmed";
}

export const config = {
  port: intEnv("PORT", 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  apiKey: process.env.API_KEY ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    commitment: commitmentEnv(),
    syncBatchLimit: intEnv("SYNC_BATCH_LIMIT", 50)
  },
  sync: {
    intervalMs: intEnv("SYNC_INTERVAL_MS", 60_000),
    enableApiLoop: boolEnv("ENABLE_SYNC_LOOP", false)
  },
  mysql: {
    uri: process.env.MYSQL_URL || process.env.DATABASE_URL || "",
    host: process.env.MYSQLHOST || "127.0.0.1",
    port: intEnv("MYSQLPORT", 3306),
    user: process.env.MYSQLUSER || "",
    password: process.env.MYSQLPASSWORD || "",
    database: process.env.MYSQLDATABASE || ""
  }
} as const;

export function assertDatabaseConfig(): void {
  if (config.mysql.uri) return;

  const missing = [
    ["MYSQLUSER", config.mysql.user],
    ["MYSQLDATABASE", config.mysql.database]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    const names = missing.map(([name]) => name).join(", ");
    throw new Error(`Missing MySQL configuration: set MYSQL_URL/DATABASE_URL or ${names}.`);
  }
}
