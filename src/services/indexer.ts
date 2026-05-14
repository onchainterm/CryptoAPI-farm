import { Connection, PublicKey, type ConfirmedSignatureInfo, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { ResultSetHeader } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { validatePublicKey } from "../solana/keys.js";
import { parseSolanaTransaction, type ParsedSolanaActivity } from "../solana/parser.js";

export type WatchKind = "wallet" | "program" | "mint" | "account";

export interface SyncAddressResult {
  address: string;
  signaturesSeen: number;
  transactionsIndexed: number;
  lastSignature: string | null;
}

export interface SyncAllResult {
  results: SyncAddressResult[];
}

function blockTimeToDate(blockTime: number | null | undefined): Date | null {
  return blockTime ? new Date(blockTime * 1000) : null;
}

function roleRank(role: string): number {
  if (role === "watched") return 3;
  if (role === "program") return 2;
  if (role === "mint") return 1;
  return 0;
}

export class SolanaIndexer {
  private readonly connection: Connection;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, config.solana.commitment);
  }

  async addWatchAddress(address: string, kind: WatchKind, label: string | null): Promise<void> {
    const normalized = validatePublicKey(address);
    await pool.execute(
      `
        INSERT INTO watched_addresses (address, kind, label, enabled)
        VALUES (?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          kind = VALUES(kind),
          label = COALESCE(VALUES(label), label),
          enabled = 1
      `,
      [normalized, kind, label]
    );
  }

  async disableWatchAddress(address: string): Promise<void> {
    const normalized = validatePublicKey(address);
    await pool.execute("UPDATE watched_addresses SET enabled = 0 WHERE address = ?", [normalized]);
  }

  async syncAll(limit = config.solana.syncBatchLimit): Promise<SyncAllResult> {
    const [rows] = await pool.query(
      "SELECT address FROM watched_addresses WHERE enabled = 1 ORDER BY id ASC"
    );
    const watchedRows = rows as Array<{ address: string }>;
    const results: SyncAddressResult[] = [];

    for (const row of watchedRows) {
      results.push(await this.syncAddress(row.address, limit));
    }

    return { results };
  }

  async syncAddress(address: string, limit = config.solana.syncBatchLimit): Promise<SyncAddressResult> {
    const normalized = validatePublicKey(address);
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const syncRunId = await this.createSyncRun(normalized);

    try {
      const [watchRows] = await pool.execute(
        "SELECT last_signature FROM watched_addresses WHERE address = ? AND enabled = 1 LIMIT 1",
        [normalized]
      );
      const watchRow = (watchRows as Array<{ last_signature: string | null }>)[0];
      if (!watchRow) {
        throw new Error(`Address is not watched or is disabled: ${normalized}`);
      }

      const publicKey = new PublicKey(normalized);
      const signatures = await this.connection.getSignaturesForAddress(
        publicKey,
        { limit: boundedLimit },
        config.solana.commitment
      );
      const newestSignature = signatures[0]?.signature ?? null;
      const signaturesToProcess = this.filterNewSignatures(signatures, watchRow.last_signature);
      let indexed = 0;
      let lastSyncedSlot: number | null = null;

      for (const signatureInfo of signaturesToProcess.reverse()) {
        const didIndex = await this.indexSignature(normalized, signatureInfo.signature);
        if (didIndex) indexed += 1;
        lastSyncedSlot = signatureInfo.slot;
      }

      await pool.execute(
        `
          UPDATE watched_addresses
          SET last_signature = COALESCE(?, last_signature),
              last_synced_slot = COALESCE(?, last_synced_slot),
              last_synced_at = NOW()
          WHERE address = ?
        `,
        [newestSignature, lastSyncedSlot, normalized]
      );
      await this.finishSyncRun(syncRunId, "success", signatures.length, indexed, null);

      return {
        address: normalized,
        signaturesSeen: signatures.length,
        transactionsIndexed: indexed,
        lastSignature: newestSignature
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishSyncRun(syncRunId, "failed", 0, 0, message);
      throw error;
    }
  }

  private filterNewSignatures(
    signatures: ConfirmedSignatureInfo[],
    lastSignature: string | null
  ): ConfirmedSignatureInfo[] {
    if (!lastSignature) return signatures;

    const knownIndex = signatures.findIndex((signature) => signature.signature === lastSignature);
    if (knownIndex === -1) return signatures;

    return signatures.slice(0, knownIndex);
  }

  private async indexSignature(watchedAddress: string, signature: string): Promise<boolean> {
    const tx = await this.connection.getParsedTransaction(signature, {
      commitment: config.solana.commitment,
      maxSupportedTransactionVersion: 0
    });

    if (!tx) {
      logger.warn({ signature }, "solana transaction unavailable from rpc");
      return false;
    }

    const activity = parseSolanaTransaction(tx);
    await this.persistTransaction(watchedAddress, signature, tx, activity);
    return true;
  }

  private async persistTransaction(
    watchedAddress: string,
    signature: string,
    tx: ParsedTransactionWithMeta,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      const blockTime = blockTimeToDate(tx.blockTime);
      const status = tx.meta?.err ? "failed" : "success";

      await conn.execute(
        `
          INSERT INTO transactions
            (signature, slot, block_time, status, fee_lamports, tx_error_json, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            slot = VALUES(slot),
            block_time = VALUES(block_time),
            status = VALUES(status),
            fee_lamports = VALUES(fee_lamports),
            tx_error_json = VALUES(tx_error_json),
            raw_json = VALUES(raw_json)
        `,
        [
          signature,
          tx.slot,
          blockTime,
          status,
          tx.meta?.fee ?? null,
          tx.meta?.err ? JSON.stringify(tx.meta.err) : null,
          JSON.stringify(tx)
        ]
      );

      await this.persistAddressLinks(conn, watchedAddress, signature, tx.slot, activity);
      await this.persistNativeTransfers(conn, signature, tx.slot, blockTime, activity);
      await this.persistTokenTransfers(conn, signature, tx.slot, blockTime, activity);
      await this.persistNftEvents(conn, signature, tx.slot, blockTime, activity);
      await this.persistProgramEvents(conn, signature, tx.slot, blockTime, activity);
      await this.persistBalanceChanges(conn, signature, tx.slot, activity);
      await this.persistTokenBalances(conn, signature, tx.slot, blockTime, activity);

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  private async persistAddressLinks(
    conn: PoolConnection,
    watchedAddress: string,
    signature: string,
    slot: number,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    const links = new Map<string, "watched" | "account_key" | "program" | "mint">();
    links.set(watchedAddress, "watched");

    for (const accountKey of activity.accountKeys) {
      this.setBestRole(links, accountKey, "account_key");
    }

    for (const event of activity.programEvents) {
      this.setBestRole(links, event.programId, "program");
    }

    for (const transfer of activity.tokenTransfers) {
      if (transfer.mint) this.setBestRole(links, transfer.mint, "mint");
    }

    for (const [address, role] of links.entries()) {
      await conn.execute(
        `
          INSERT INTO address_transactions (address, signature, slot, role)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            slot = VALUES(slot),
            role = IF(role = 'watched', role, VALUES(role))
        `,
        [address, signature, slot, role]
      );
    }
  }

  private setBestRole(
    links: Map<string, "watched" | "account_key" | "program" | "mint">,
    address: string,
    role: "watched" | "account_key" | "program" | "mint"
  ): void {
    const current = links.get(address);
    if (!current || roleRank(role) > roleRank(current)) {
      links.set(address, role);
    }
  }

  private async persistNativeTransfers(
    conn: PoolConnection,
    signature: string,
    slot: number,
    blockTime: Date | null,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    for (const transfer of activity.nativeTransfers) {
      await conn.execute(
        `
          INSERT IGNORE INTO native_transfers
            (signature, slot, block_time, instruction_index, inner_index, transfer_order,
             from_address, to_address, lamports, sol)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          signature,
          slot,
          blockTime,
          transfer.instructionIndex,
          transfer.innerIndex ?? -1,
          transfer.transferOrder,
          transfer.fromAddress,
          transfer.toAddress,
          transfer.lamports,
          transfer.sol
        ]
      );
    }
  }

  private async persistTokenTransfers(
    conn: PoolConnection,
    signature: string,
    slot: number,
    blockTime: Date | null,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    for (const transfer of activity.tokenTransfers) {
      await conn.execute(
        `
          INSERT IGNORE INTO token_transfers
            (signature, slot, block_time, instruction_index, inner_index, transfer_order,
             mint, source_account, destination_account, source_owner, destination_owner,
             authority, amount_raw, amount, decimals, token_program, instruction_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          signature,
          slot,
          blockTime,
          transfer.instructionIndex,
          transfer.innerIndex ?? -1,
          transfer.transferOrder,
          transfer.mint,
          transfer.sourceAccount,
          transfer.destinationAccount,
          transfer.sourceOwner,
          transfer.destinationOwner,
          transfer.authority,
          transfer.amountRaw,
          transfer.amount,
          transfer.decimals,
          transfer.tokenProgram,
          transfer.instructionType
        ]
      );
    }
  }

  private async persistNftEvents(
    conn: PoolConnection,
    signature: string,
    slot: number,
    blockTime: Date | null,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    for (const event of activity.nftEvents) {
      await conn.execute(
        `
          INSERT IGNORE INTO nft_events
            (signature, slot, block_time, instruction_index, inner_index, transfer_order,
             mint, owner, from_owner, to_owner, event_type, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          signature,
          slot,
          blockTime,
          event.instructionIndex,
          event.innerIndex ?? -1,
          event.transferOrder,
          event.mint,
          event.owner,
          event.fromOwner,
          event.toOwner,
          event.eventType,
          JSON.stringify(event.metadata)
        ]
      );
    }
  }

  private async persistProgramEvents(
    conn: PoolConnection,
    signature: string,
    slot: number,
    blockTime: Date | null,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    for (const event of activity.programEvents) {
      await conn.execute(
        `
          INSERT IGNORE INTO program_events
            (signature, slot, block_time, instruction_index, inner_index, program_id,
             program_name, instruction_type, parsed_json, logs_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          signature,
          slot,
          blockTime,
          event.instructionIndex,
          event.innerIndex ?? -1,
          event.programId,
          event.programName,
          event.instructionType,
          event.parsed ? JSON.stringify(event.parsed) : null,
          JSON.stringify(event.logs)
        ]
      );
    }
  }

  private async persistBalanceChanges(
    conn: PoolConnection,
    signature: string,
    slot: number,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    for (const change of activity.balanceChanges) {
      await conn.execute(
        `
          INSERT IGNORE INTO balance_changes
            (signature, slot, account_index, account_address, pre_lamports, post_lamports, delta_lamports)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          signature,
          slot,
          change.accountIndex,
          change.accountAddress,
          change.preLamports,
          change.postLamports,
          change.deltaLamports
        ]
      );
    }
  }

  private async persistTokenBalances(
    conn: PoolConnection,
    signature: string,
    slot: number,
    blockTime: Date | null,
    activity: ParsedSolanaActivity
  ): Promise<void> {
    for (const balance of activity.tokenBalances) {
      await conn.execute(
        `
          INSERT IGNORE INTO token_balances
            (signature, slot, block_time, balance_side, account_index, account_address,
             mint, owner, amount_raw, ui_amount, decimals)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          signature,
          slot,
          blockTime,
          balance.side,
          balance.accountIndex,
          balance.accountAddress,
          balance.mint,
          balance.owner,
          balance.amountRaw,
          balance.uiAmount,
          balance.decimals
        ]
      );
    }
  }

  private async createSyncRun(address: string): Promise<number> {
    const [result] = await pool.execute<ResultSetHeader>(
      "INSERT INTO sync_runs (address, status, started_at) VALUES (?, 'running', NOW())",
      [address]
    );

    return result.insertId;
  }

  private async finishSyncRun(
    id: number,
    status: "success" | "failed",
    signaturesSeen: number,
    transactionsIndexed: number,
    errorMessage: string | null
  ): Promise<void> {
    await pool.execute(
      `
        UPDATE sync_runs
        SET status = ?,
            finished_at = NOW(),
            signatures_seen = ?,
            transactions_indexed = ?,
            error_message = ?
        WHERE id = ?
      `,
      [status, signaturesSeen, transactionsIndexed, errorMessage, id]
    );
  }
}
