import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { pool } from "./db/pool.js";
import { asyncHandler, HttpError, readLimit, readString } from "./http.js";
import type { SolanaIndexer, WatchKind } from "./services/indexer.js";
import { validatePublicKey } from "./solana/keys.js";

const WATCH_KINDS = new Set(["wallet", "program", "mint", "account"]);

function assertWatchKind(value: unknown): WatchKind {
  if (typeof value === "string" && WATCH_KINDS.has(value)) {
    return value as WatchKind;
  }

  return "wallet";
}

function assertPublicKeyParam(value: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new HttpError(400, `Invalid Solana public key: ${value}`);
  }
}

export function createRouter(indexer: SolanaIndexer): Router {
  const router = Router();

  router.get(
    "/status",
    asyncHandler(async (_req, res) => {
      const [[watchedCountRows], [transactionCountRows], [latestRuns]] = await Promise.all([
        pool.query("SELECT COUNT(*) AS count FROM watched_addresses WHERE enabled = 1"),
        pool.query("SELECT COUNT(*) AS count FROM transactions"),
        pool.query(
          `
            SELECT id, address, status, started_at, finished_at, signatures_seen,
                   transactions_indexed, error_message
            FROM sync_runs
            ORDER BY id DESC
            LIMIT 10
          `
        )
      ]);

      res.json({
        watchedAddresses: Number((watchedCountRows as Array<{ count: number }>)[0]?.count ?? 0),
        transactions: Number((transactionCountRows as Array<{ count: number }>)[0]?.count ?? 0),
        latestRuns
      });
    })
  );

  router.get(
    "/watch/addresses",
    asyncHandler(async (_req, res) => {
      const [rows] = await pool.query(
        `
          SELECT address, kind, label, enabled, last_signature, last_synced_slot,
                 last_synced_at, created_at, updated_at
          FROM watched_addresses
          ORDER BY created_at DESC
        `
      );
      res.json({ data: rows });
    })
  );

  router.post(
    "/watch/addresses",
    asyncHandler(async (req, res) => {
      const body = req.body as { address?: unknown; kind?: unknown; label?: unknown };
      if (typeof body.address !== "string") {
        throw new HttpError(400, "address is required");
      }

      const address = validatePublicKey(body.address);
      const kind = assertWatchKind(body.kind);
      const label = typeof body.label === "string" ? body.label : null;

      await indexer.addWatchAddress(address, kind, label);
      res.status(201).json({ address, kind, label, enabled: true });
    })
  );

  router.delete(
    "/watch/addresses/:address",
    asyncHandler(async (req, res) => {
      const address = assertPublicKeyParam(req.params.address);
      await indexer.disableWatchAddress(address);
      res.json({ address, enabled: false });
    })
  );

  router.post(
    "/sync/run",
    asyncHandler(async (req, res) => {
      const body = req.body as { address?: unknown; limit?: unknown };
      const limit = typeof body.limit === "number" ? body.limit : readLimit(String(body.limit ?? ""), 50, 1_000);

      if (typeof body.address === "string" && body.address.trim()) {
        const result = await indexer.syncAddress(body.address, limit);
        res.json(result);
        return;
      }

      const result = await indexer.syncAll(limit);
      res.json(result);
    })
  );

  router.get(
    "/wallets/:address/summary",
    asyncHandler(async (req, res) => {
      const address = assertPublicKeyParam(req.params.address);
      const [[transactionRows], [nativeRows], [tokenRows], [latestNativeRows], [tokenBalanceRows]] =
        await Promise.all([
          pool.query("SELECT COUNT(*) AS count FROM address_transactions WHERE address = ?", [address]),
          pool.query(
            "SELECT COUNT(*) AS count FROM native_transfers WHERE from_address = ? OR to_address = ?",
            [address, address]
          ),
          pool.query(
            `
              SELECT COUNT(*) AS count
              FROM token_transfers
              WHERE source_owner = ? OR destination_owner = ? OR source_account = ? OR destination_account = ?
            `,
            [address, address, address, address]
          ),
          pool.query(
            `
              SELECT account_address, post_lamports, slot
              FROM balance_changes
              WHERE account_address = ?
              ORDER BY slot DESC
              LIMIT 1
            `,
            [address]
          ),
          pool.query(
            `
              SELECT tb.mint, tb.owner, tb.account_address, tb.amount_raw, tb.ui_amount,
                     tb.decimals, tb.slot, tb.block_time
              FROM token_balances tb
              INNER JOIN (
                SELECT mint, owner, MAX(id) AS id
                FROM token_balances
                WHERE owner = ? AND balance_side = 'post'
                GROUP BY mint, owner
              ) latest ON latest.id = tb.id
              ORDER BY tb.slot DESC
              LIMIT 100
            `,
            [address]
          )
        ]);

      res.json({
        address,
        counts: {
          transactions: Number((transactionRows as Array<{ count: number }>)[0]?.count ?? 0),
          nativeTransfers: Number((nativeRows as Array<{ count: number }>)[0]?.count ?? 0),
          tokenTransfers: Number((tokenRows as Array<{ count: number }>)[0]?.count ?? 0)
        },
        latestNativeBalance: (latestNativeRows as unknown[])[0] ?? null,
        tokenBalances: tokenBalanceRows
      });
    })
  );

  router.get(
    "/wallets/:address/transactions",
    asyncHandler(async (req, res) => {
      const address = assertPublicKeyParam(req.params.address);
      const limit = readLimit(req.query.limit);
      const [rows] = await pool.query(
        `
          SELECT t.signature, t.slot, t.block_time, t.status, t.fee_lamports, atx.role
          FROM address_transactions atx
          INNER JOIN transactions t ON t.signature = atx.signature
          WHERE atx.address = ?
          ORDER BY atx.slot DESC
          LIMIT ?
        `,
        [address, limit]
      );
      res.json({ data: rows });
    })
  );

  router.get(
    "/wallets/:address/transfers",
    asyncHandler(async (req, res) => {
      const address = assertPublicKeyParam(req.params.address);
      const limit = readLimit(req.query.limit);
      const [nativeTransfers, tokenTransfers] = await Promise.all([
        pool.query(
          `
            SELECT *
            FROM native_transfers
            WHERE from_address = ? OR to_address = ?
            ORDER BY slot DESC
            LIMIT ?
          `,
          [address, address, limit]
        ),
        pool.query(
          `
            SELECT *
            FROM token_transfers
            WHERE source_owner = ? OR destination_owner = ? OR source_account = ? OR destination_account = ?
            ORDER BY slot DESC
            LIMIT ?
          `,
          [address, address, address, address, limit]
        )
      ]);
      res.json({ native: nativeTransfers[0], tokens: tokenTransfers[0] });
    })
  );

  router.get(
    "/transactions",
    asyncHandler(async (req, res) => {
      const address = readString(req.query.address);
      const limit = readLimit(req.query.limit);

      if (address) {
        const normalized = assertPublicKeyParam(address);
        const [rows] = await pool.query(
          `
            SELECT t.signature, t.slot, t.block_time, t.status, t.fee_lamports, atx.role
            FROM address_transactions atx
            INNER JOIN transactions t ON t.signature = atx.signature
            WHERE atx.address = ?
            ORDER BY atx.slot DESC
            LIMIT ?
          `,
          [normalized, limit]
        );
        res.json({ data: rows });
        return;
      }

      const [rows] = await pool.query(
        `
          SELECT signature, slot, block_time, status, fee_lamports
          FROM transactions
          ORDER BY slot DESC
          LIMIT ?
        `,
        [limit]
      );
      res.json({ data: rows });
    })
  );

  router.get(
    "/transactions/:signature",
    asyncHandler(async (req, res) => {
      const [rows] = await pool.query("SELECT * FROM transactions WHERE signature = ? LIMIT 1", [
        req.params.signature
      ]);
      const transaction = (rows as unknown[])[0];
      if (!transaction) throw new HttpError(404, "transaction not found");
      res.json(transaction);
    })
  );

  router.get(
    "/transfers/native",
    asyncHandler(async (req, res) => {
      const address = readString(req.query.address);
      const limit = readLimit(req.query.limit);

      if (address) {
        const normalized = assertPublicKeyParam(address);
        const [rows] = await pool.query(
          `
            SELECT *
            FROM native_transfers
            WHERE from_address = ? OR to_address = ?
            ORDER BY slot DESC
            LIMIT ?
          `,
          [normalized, normalized, limit]
        );
        res.json({ data: rows });
        return;
      }

      const [rows] = await pool.query("SELECT * FROM native_transfers ORDER BY slot DESC LIMIT ?", [
        limit
      ]);
      res.json({ data: rows });
    })
  );

  router.get(
    "/transfers/tokens",
    asyncHandler(async (req, res) => {
      const address = readString(req.query.address);
      const mint = readString(req.query.mint);
      const limit = readLimit(req.query.limit);
      const where: string[] = [];
      const params: unknown[] = [];

      if (address) {
        const normalized = assertPublicKeyParam(address);
        where.push(
          "(source_owner = ? OR destination_owner = ? OR source_account = ? OR destination_account = ?)"
        );
        params.push(normalized, normalized, normalized, normalized);
      }

      if (mint) {
        where.push("mint = ?");
        params.push(assertPublicKeyParam(mint));
      }

      params.push(limit);
      const [rows] = await pool.query(
        `
          SELECT *
          FROM token_transfers
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY slot DESC
          LIMIT ?
        `,
        params
      );
      res.json({ data: rows });
    })
  );

  router.get(
    "/nfts/events",
    asyncHandler(async (req, res) => {
      const owner = readString(req.query.owner);
      const mint = readString(req.query.mint);
      const limit = readLimit(req.query.limit);
      const where: string[] = [];
      const params: unknown[] = [];

      if (owner) {
        const normalized = assertPublicKeyParam(owner);
        where.push("(owner = ? OR from_owner = ? OR to_owner = ?)");
        params.push(normalized, normalized, normalized);
      }

      if (mint) {
        where.push("mint = ?");
        params.push(assertPublicKeyParam(mint));
      }

      params.push(limit);
      const [rows] = await pool.query(
        `
          SELECT *
          FROM nft_events
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY slot DESC
          LIMIT ?
        `,
        params
      );
      res.json({ data: rows });
    })
  );

  router.get(
    "/program-events",
    asyncHandler(async (req, res) => {
      const programId = readString(req.query.programId);
      const address = readString(req.query.address);
      const limit = readLimit(req.query.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      let join = "";

      if (programId) {
        where.push("pe.program_id = ?");
        params.push(assertPublicKeyParam(programId));
      }

      if (address) {
        join = "INNER JOIN address_transactions atx ON atx.signature = pe.signature";
        where.push("atx.address = ?");
        params.push(assertPublicKeyParam(address));
      }

      params.push(limit);
      const [rows] = await pool.query(
        `
          SELECT pe.*
          FROM program_events pe
          ${join}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY pe.slot DESC, pe.instruction_index ASC
          LIMIT ?
        `,
        params
      );
      res.json({ data: rows });
    })
  );

  return router;
}
