import mysql from "mysql2/promise";
import type { PoolOptions } from "mysql2";
import { assertDatabaseConfig, config } from "../config.js";

assertDatabaseConfig();

const poolOptions: PoolOptions = config.mysql.uri
  ? {
      uri: config.mysql.uri
    }
  : {
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database
    };

export const pool = mysql.createPool({
  ...poolOptions,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60_000,
  enableKeepAlive: true,
  supportBigNumbers: true,
  bigNumberStrings: true
});

export async function closePool(): Promise<void> {
  await pool.end();
}
